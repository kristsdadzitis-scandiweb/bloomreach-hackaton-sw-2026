import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { chatWithMia, type MiaTurnResult } from "../integrations/gemini.js";
import {
  addToCart,
  attachDemoDeliveryAddress,
  getCart,
  getProductByHandle,
  loginDemoCustomer,
  updateCartBuyerIdentity,
} from "../integrations/shopify.js";
import { recordCartUpdateEvent, getCustomerProfile, updateCustomerProfile, recordEvent } from "../integrations/bloomreach.js";
import { evaluateSignalCase } from "../services/signals.js";
import type { ChatSession } from "../types.js";
import { newSessionBehavior } from "../types.js";

/**
 * Mia's shopping conversation. Extremely lean in-memory session store for
 * now — fine for a hackathon demo, revisit if it needs to survive across
 * Cloud Run instances.
 */
export const chatRouter = Router();

const sessions = new Map<string, ChatSession>();

/**
 * Express doesn't route a rejected promise from an async handler to error
 * middleware on its own — it becomes an unhandled rejection, which crashes
 * the whole process (all sessions, every visitor, since this is one Node
 * instance). One bad Shopify/Gemini/Bloomreach call from a single customer
 * must never take the app down for everyone else — every route is wrapped.
 */
function asyncHandler(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next: NextFunction) => {
    handler(req, res).catch((err) => {
      console.error(`[chat] ${req.path} failed:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal error" });
      } else {
        next(err);
      }
    });
  };
}

/** Real Bloomreach read — resolves whether this customer is genuinely known, never a guess. */
async function resolveIdentity(session: ChatSession): Promise<void> {
  const profile = await getCustomerProfile(session.customerId).catch(() => undefined);
  session.profile = profile;
  if (session.identityTier === "just_signed_in") return; // preserved for exactly one turn
  session.identityTier = profile ? "known" : "anonymous";
}

/** just_signed_in only survives the one turn right after login. */
function settleIdentityAfterTurn(session: ChatSession): void {
  if (session.identityTier === "just_signed_in") {
    session.identityTier = "known";
  }
}

async function runMiaTurn(session: ChatSession, latestMessage: string | undefined): Promise<MiaTurnResult> {
  // complete_the_kit needs real pairs_with data from a catalog lookup, which
  // this layer doesn't have yet — deferred; Tier 1's other four triggers
  // don't depend on it, and this is a documented scoping call, not a silent gap.
  const signalCase = evaluateSignalCase(session, []);
  const result = await chatWithMia(session, latestMessage, signalCase);

  if (result.response.writeBack?.event) {
    await recordEvent(session.customerId, result.response.writeBack.event, result.response.writeBack.properties).catch(() => {});
  }
  if (signalCase.trigger !== "hold_back") {
    session.behavior.triggersFiredThisSession.push(signalCase.trigger);
  }
  settleIdentityAfterTurn(session);
  return result;
}

chatRouter.post("/session", asyncHandler(async (req, res) => {
  const { customerId, productHandle, sessionId: existingSessionId } = req.body as {
    customerId?: string;
    productHandle?: string;
    sessionId?: string;
  };

  // A real storefront reloads the whole page on navigation, wiping the
  // widget's in-memory state — the browser resends the sessionId it saved
  // from last time so the conversation resumes instead of restarting.
  let session = existingSessionId ? sessions.get(existingSessionId) : undefined;
  if (!session) {
    session = {
      sessionId: randomUUID(),
      customerId: customerId ?? "unknown",
      history: [],
      identityTier: "anonymous",
      behavior: newSessionBehavior(),
    };
    sessions.set(session.sessionId, session);
  }

  await resolveIdentity(session);

  if (productHandle) {
    const product = await getProductByHandle(productHandle);
    if (product) {
      session.currentProduct = product;
      session.behavior.pageType = "pdp";
    }
  }

  // The cart itself outlives a page reload (it's a real Shopify object) — the
  // widget's in-memory knowledge of it doesn't, so hand it back on resume.
  const cart = session.cartId ? await getCart(session.cartId) : null;

  res.json({
    sessionId: session.sessionId,
    product: session.currentProduct ?? null,
    history: session.history,
    cart,
    identityTier: session.identityTier,
    profile: session.profile ?? null,
  });
}));

chatRouter.post("/message", asyncHandler(async (req, res) => {
  const { sessionId, message } = req.body as { sessionId: string; message: string };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session — call /api/chat/session first" });
  }

  session.history.push({ role: "customer", message, timestamp: new Date().toISOString() });
  session.behavior.lastActivityAt = new Date().toISOString();

  const { response, ground } = await runMiaTurn(session, message);
  const products = ground.candidates.filter((c) => response.reply.show.includes(c.id) && c.available);

  session.history.push({
    role: "agent",
    message: response.reply.text,
    timestamp: new Date().toISOString(),
    products,
  });

  res.json({ reply: response.reply.text, products, quickReplies: response.reply.chips, decision: response.decision });
}));

/** The playbook's signal-driven proactive turn — server-evaluated instead of a fixed client timer. */
chatRouter.post("/signal-check", asyncHandler(async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session" });
  }

  const { response, ground } = await runMiaTurn(session, undefined);
  if (response.decision.action !== "open_chat") {
    return res.status(204).end();
  }

  const products = ground.candidates.filter((c) => response.reply.show.includes(c.id) && c.available);
  session.history.push({
    role: "agent",
    message: response.reply.text,
    timestamp: new Date().toISOString(),
    products,
  });

  res.json({ reply: response.reply.text, products, quickReplies: response.reply.chips, decision: response.decision });
}));

/** Widget-reported behavior — local session state for trigger detection, separate from the model's own write_back. */
chatRouter.post("/event", asyncHandler(async (req, res) => {
  const { sessionId, event, properties } = req.body as {
    sessionId: string;
    event: string;
    properties?: Record<string, unknown>;
  };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session" });
  }

  const { behavior } = session;
  behavior.lastActivityAt = new Date().toISOString();
  const props = properties ?? {};

  switch (event) {
    case "product_view_end": {
      const productId = String(props.productId ?? "");
      const seconds = Number(props.seconds ?? 0);
      if (productId) {
        const existing = behavior.productsViewed[productId] ?? { productId, views: 0, totalSeconds: 0, lastViewedAt: "" };
        behavior.productsViewed[productId] = {
          productId,
          views: existing.views + 1,
          totalSeconds: existing.totalSeconds + seconds,
          lastViewedAt: new Date().toISOString(),
        };
      }
      break;
    }
    case "size_guide_opened": {
      const productId = String(props.productId ?? "");
      if (productId) behavior.sizeGuideOpens.push({ productId, openedAt: new Date().toISOString() });
      break;
    }
    case "size_unavailable_viewed": {
      const sku = String(props.sku ?? "");
      const size = String(props.size ?? "");
      if (sku && size) behavior.lastUnavailableSizeView = { sku, size, viewedAt: new Date().toISOString() };
      break;
    }
    case "filter_applied":
      if (props.name) behavior.filters[String(props.name)] = props.value as string | string[];
      break;
    case "sort_changed":
      behavior.sort = props.sort as string | undefined;
      break;
    case "checkout_opened":
      behavior.checkoutStep = "opened";
      behavior.checkoutOpenedAt = new Date().toISOString();
      break;
    default:
      break;
  }

  res.json({ ok: true });
}));

chatRouter.post("/checkout", asyncHandler(async (req, res) => {
  const { sessionId, lineItems } = req.body as {
    sessionId: string;
    lineItems: Array<{ variantId: string; quantity: number }>;
  };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session" });
  }

  const cart = await addToCart(session.cartId, lineItems, session.customerAccessToken);
  session.cartId = cart.cartId;
  session.behavior.cartLastModifiedAt = new Date().toISOString();
  session.behavior.checkoutStep = "none";

  // A genuine "purchase" event needs a Shopify order webhook, which needs
  // protected-customer-data approval this app doesn't have (see bloomreach.ts).
  // Track the real, verifiable signal we do have instead: the cart itself.
  await recordCartUpdateEvent(session.customerId, cart);

  res.json(cart);
}));

chatRouter.post("/login", asyncHandler(async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session" });
  }

  const profile = await loginDemoCustomer();
  session.customerAccessToken = profile.accessToken;
  session.customerName = profile.firstName;

  // Real write — this is now genuinely who Bloomreach thinks this customer
  // is, not a display-only value. Set in-memory too rather than reading it
  // straight back: the write endpoint is documented as async/queued, so an
  // immediate re-read could race and return stale data.
  await updateCustomerProfile(session.customerId, { firstName: profile.firstName }).catch(() => {});
  session.profile = { ...session.profile, firstName: profile.firstName };
  session.identityTier = "just_signed_in";

  if (session.cartId) {
    await updateCartBuyerIdentity(session.cartId, profile.accessToken);
    await attachDemoDeliveryAddress(session.cartId);
  }

  res.json({ loggedIn: true, name: profile.firstName, email: profile.email });
}));

chatRouter.post("/logout", asyncHandler(async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session" });
  }

  if (session.cartId) {
    await updateCartBuyerIdentity(session.cartId, undefined);
  }
  session.customerAccessToken = undefined;
  session.customerName = undefined;
  session.identityTier = "anonymous";
  session.profile = undefined;

  res.json({ loggedIn: false });
}));
