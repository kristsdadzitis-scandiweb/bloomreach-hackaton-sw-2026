import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { chatWithMia, type MiaTurnResult, type BloomreachWriteLog } from "../integrations/gemini.js";
import { getCandidateByHandle, loginDemoCustomer, resolveCartLineProducts } from "../integrations/shopify.js";
import { recordCartUpdateEvent, getCustomerProfile, updateCustomerProfile, recordEvent } from "../integrations/bloomreach.js";
import { evaluateSignalCase } from "../services/signals.js";
import type { ChatSession } from "../types.js";
import { newSessionBehavior } from "../types.js";
import { recordTurnLog, getTurnLogs } from "../services/telemetry.js";
import { config } from "../config.js";

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

/**
 * Serializes turns per session. Without this, two overlapping /signal-check
 * calls for the same session (the background poll and an event-triggered
 * recheck both landing while a prior Gemini round-trip is still in flight)
 * both read `triggersFiredThisSession` before either has updated it — both
 * see the trigger as unfired, both genuinely fire, and the shopper gets the
 * same trigger's message twice or three times over. Marking a trigger fired
 * only happens after the whole turn resolves, so the fix is to never let two
 * turns for the same session actually run concurrently in the first place.
 */
const turnLocks = new Map<string, Promise<unknown>>();

function runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prior = turnLocks.get(sessionId) ?? Promise.resolve();
  const settled = prior.then(fn, fn);
  turnLocks.set(
    sessionId,
    settled.then(
      () => undefined,
      () => undefined,
    ),
  );
  return settled;
}

async function runMiaTurn(session: ChatSession, latestMessage: string | undefined, deliberate = false): Promise<MiaTurnResult> {
  return runExclusive(session.sessionId, async () => {
    const startedAt = Date.now();
    // complete_the_kit's real evidence — which of the cart's own pairs_with
    // complements aren't in the cart yet — is already resolved on
    // session.cart by the /event "cart_synced" handler below, whenever the
    // widget last reported the real native cart. No fetch needed here: the
    // backend has no browser session into that cart to fetch it itself.
    const cart = session.cart ?? null;
    const isProactive = latestMessage === undefined;
    const signalCase = evaluateSignalCase(session, cart?.unmatchedPairsWith ?? [], isProactive);
    const result = await chatWithMia(session, latestMessage, signalCase, cart);

    // Combines the tool loop's own log_event writes (result.bloomreachWrites)
    // with this turn's phase B writeBack — both are real attempted Bloomreach
    // writes, tracked identically for the admin panel. Previously this write
    // used a bare `.catch(() => {})`: a failure here was indistinguishable
    // from "nothing was written this turn" anywhere in the app, admin panel
    // included — the whole point of surfacing writes at all was to answer
    // "is Bloomreach actually working," which a swallowed error defeats.
    const bloomreachWrites: BloomreachWriteLog[] = [...result.bloomreachWrites];
    if (result.response.writeBack?.event) {
      const { event, properties } = result.response.writeBack;
      try {
        await recordEvent(session.customerId, event, properties);
        bloomreachWrites.push({ source: "write_back", event, properties, failed: false });
      } catch (err) {
        bloomreachWrites.push({ source: "write_back", event, properties, failed: true, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Only count a trigger as "used" once Mia actually decided to speak. The
    // rule matching is cheap and allowed to keep re-firing every check — it's
    // Gemini's judgment call each time whether the evidence is real yet (e.g.
    // comparison_stall correctly declines on a quick skim, but should still
    // get to fire later once dwell time genuinely looks like comparison).
    // Marking it used on a mere rule-match, regardless of the model's
    // decision, silently burned the one shot on a declined attempt — this
    // was a real bug: a quick early test made comparison_stall permanently
    // unreproducible for the rest of that session.
    const spoke = result.response.decision.action === "open_chat";
    if (signalCase.trigger !== "hold_back" && spoke) {
      session.behavior.triggersFiredThisSession.push(signalCase.firedKey);
    }
    if (signalCase.trigger === "complete_the_kit" && spoke) {
      session.behavior.opportunityUsedThisSession = true;
    }
    if (isProactive && spoke) {
      session.behavior.lastProactiveSpokeAt = new Date().toISOString();
    }
    settleIdentityAfterTurn(session);

    // Every turn with real evidence is logged, spoke or not — a hold_back
    // Gemini actually reasoned about (a real trigger matched, but the model
    // declined to voice it) is exactly what the admin panel needs to
    // demonstrate. A bare hold_back where the rule layer found nothing never
    // even reached Gemini (see chatWithMia's early return) — logging that
    // would just be routine background-poll noise with zero decision to
    // show, on a 20s timer for as long as any tab is open, which is the
    // exact clutter this skip was added to cut down on.
    //
    // `deliberate` is the one exception: it's true only when this check has
    // a specific, real reason behind it — an event report (size guide
    // opened, an out-of-stock size clicked) or the shopper clicking the
    // launcher — never the plain timer poll. Those are bounded by actual
    // shopper behavior, not wall-clock time, so logging them even when they
    // land on hold_back (e.g. "size guide opened once, needs a second open
    // to fire") is exactly the visibility asked for, without reintroducing
    // the same noise: nothing repeats just because time passed.
    const skippedGemini = isProactive && signalCase.trigger === "hold_back";
    // A direct message reply is always shown to the customer regardless of
    // `decision.action` (/message returns reply.text unconditionally) —
    // only a proactive turn's visibility actually depends on `spoke`
    // (open_chat vs. the 204 signal-check returns for anything else). Using
    // bare `spoke` here previously hid the real reply text for every
    // "continue"-action direct reply, which is most of them — exactly the
    // gap that made the false "I've added it to your cart" claim invisible
    // in the log itself, visible only via a screenshot of the widget.
    const shown = !isProactive || spoke;
    if (!skippedGemini || deliberate) recordTurnLog({
      sessionId: session.sessionId,
      customerId: session.customerId,
      identityTier: session.identityTier,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      isProactive,
      customerMessage: latestMessage,
      signalCase,
      decision: result.response.decision,
      spoke,
      replyText: shown ? result.response.reply.text : undefined,
      chips: shown ? result.response.reply.chips : undefined,
      pendingCartAddsCount: result.pendingCartAdds.length,
      cart: cart ? { totalQuantity: cart.totalQuantity, totalAmount: cart.totalAmount } : null,
      profile: session.profile ?? null,
      bloomreachWrites,
      violations: result.violations,
    });

    return result;
  });
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
    const product = await getCandidateByHandle(productHandle);
    if (product) {
      session.currentProduct = product;
      session.behavior.pageType = "pdp";
      session.behavior.category = product.category;
    }
  }

  // The real (native) cart outlives a page reload — but the backend has no
  // browser session into it, so it can't re-fetch it here the way it used to
  // fetch its own Storefront-API cart. session.cart holds whatever the
  // widget last reported; the widget itself re-syncs from /cart.js directly
  // (its own source of truth, no round trip needed) right after this call.
  res.json({
    sessionId: session.sessionId,
    product: session.currentProduct ?? null,
    history: session.history,
    cart: session.cart ?? null,
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

  const { response, ground, pendingCartAdds } = await runMiaTurn(session, message);
  const products = ground.candidates.filter((c) => response.reply.show.includes(c.id) && c.available);

  session.history.push({
    role: "agent",
    message: response.reply.text,
    timestamp: new Date().toISOString(),
    products,
    chips: response.reply.chips,
  });

  // Real variant ids create_cart resolved this turn — the widget performs
  // the actual add via the theme's own native /cart/add.js after receiving
  // this response, since the backend has no browser session to add for it.
  res.json({
    reply: response.reply.text,
    products,
    quickReplies: response.reply.chips,
    decision: response.decision,
    pendingCartAdds,
  });
}));

/** The playbook's signal-driven proactive turn — server-evaluated instead of a fixed client timer. */
chatRouter.post("/signal-check", asyncHandler(async (req, res) => {
  const { sessionId, deliberate } = req.body as { sessionId: string; deliberate?: boolean };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session" });
  }

  const { response, ground } = await runMiaTurn(session, undefined, Boolean(deliberate));
  if (response.decision.action !== "open_chat") {
    return res.status(204).end();
  }

  const products = ground.candidates.filter((c) => response.reply.show.includes(c.id) && c.available);
  session.history.push({
    role: "agent",
    message: response.reply.text,
    timestamp: new Date().toISOString(),
    products,
    chips: response.reply.chips,
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
      const category = props.category ? String(props.category) : undefined;
      if (productId) {
        const existing = behavior.productsViewed[productId] ?? { productId, views: 0, totalSeconds: 0, lastViewedAt: "" };
        behavior.productsViewed[productId] = {
          productId,
          views: existing.views + 1,
          totalSeconds: existing.totalSeconds + seconds,
          lastViewedAt: new Date().toISOString(),
          category: category ?? existing.category,
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
    case "cart_synced": {
      // The real, native cart (theme's own /cart/add.js + /cart.js) — the
      // backend has no browser session into it, so this is the only way it
      // learns the cart changed, whether the add came from the widget's own
      // "Add to cart" button or from create_cart during a real conversation.
      // See CLAUDE.md's "Native cart switch" for why there's no cartId-based
      // fetch here the way there used to be.
      const token = String(props.token ?? "");
      const totalQuantity = Number(props.totalQuantity ?? 0);
      const totalAmount = Number(props.totalAmount ?? 0);
      const currencyCode = String(props.currencyCode ?? "");
      const rawLines = (props.lines as Array<{ variantId: string; quantity: number; lineTotal: number }>) ?? [];

      const { sizeSignals, ...cartFields } = await resolveCartLineProducts(rawLines).catch(() => ({
        lines: [],
        lineHandles: [],
        unmatchedPairsWith: [],
        sizeSignals: {} as { usualSizeTop?: string; usualSizeShoe?: string },
      }));
      session.cart = { totalQuantity, totalAmount, currencyCode, ...cartFields };
      behavior.cartLastModifiedAt = new Date().toISOString();
      if (totalQuantity > 0) behavior.checkoutStep = "none";

      // A genuine "purchase" event needs a Shopify order webhook, which needs
      // protected-customer-data approval this app doesn't have (see
      // bloomreach.ts). Track the real, verifiable signal we do have
      // instead: the cart itself, same as before — just fired on every real
      // sync now instead of only on the old /checkout route, since that's
      // the only add-to-cart path left that the backend even hears about.
      if (token && rawLines.length > 0) {
        await recordCartUpdateEvent(session.customerId, {
          cartId: token,
          totalQuantity,
          lineItems: rawLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        }).catch(() => {});
      }

      // A real, deterministic size signal from what's actually in the cart —
      // most of Mia's replies are chip-driven, so a shopper stating their own
      // size in free text (the only thing that previously updated this) is
      // rare. Only write what actually changed, and only overwrite the
      // in-memory profile mirror on a real write, matching how every other
      // durable Bloomreach write in this app behaves.
      const profilePatch: { usualSizeTop?: string; usualSizeShoe?: string } = {};
      if (sizeSignals.usualSizeTop && sizeSignals.usualSizeTop !== session.profile?.usualSizeTop) {
        profilePatch.usualSizeTop = sizeSignals.usualSizeTop;
      }
      if (sizeSignals.usualSizeShoe && sizeSignals.usualSizeShoe !== session.profile?.usualSizeShoe) {
        profilePatch.usualSizeShoe = sizeSignals.usualSizeShoe;
      }
      if (Object.keys(profilePatch).length > 0) {
        await updateCustomerProfile(session.customerId, profilePatch)
          .then(() => {
            session.profile = { ...session.profile, ...profilePatch };
          })
          .catch(() => {});
      }
      break;
    }
    default:
      break;
  }

  // For cart_synced specifically, hand back the resolved cart (real product
  // titles/handles from Shopify, not something the widget has to guess at
  // from /cart.js's own field names) so it can render the order-summary card
  // from one authoritative source instead of two.
  res.json({ ok: true, cart: session.cart ?? null });
}));

chatRouter.post("/login", asyncHandler(async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session" });
  }

  // Real Shopify login — used for identity/personalization only now.
  // Attaching this to the shopper's cart (so checkout recognizes them and
  // prefills their saved address) only worked for the backend's own
  // Storefront-API cart; the native cart/checkout has no equivalent
  // client-side hook for it, so that prefill no longer applies now that
  // "Add to cart" goes straight to the theme's own cart. See CLAUDE.md's
  // "Native cart switch".
  const profile = await loginDemoCustomer();
  session.customerName = profile.firstName;

  // Real write — this is now genuinely who Bloomreach thinks this customer
  // is, not a display-only value. Set in-memory too rather than reading it
  // straight back: the write endpoint is documented as async/queued, so an
  // immediate re-read could race and return stale data.
  await updateCustomerProfile(session.customerId, { firstName: profile.firstName }).catch(() => {});
  session.profile = { ...session.profile, firstName: profile.firstName };
  session.identityTier = "just_signed_in";

  res.json({ loggedIn: true, name: profile.firstName, email: profile.email });
}));

chatRouter.post("/logout", asyncHandler(async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session" });
  }

  session.customerName = undefined;
  session.identityTier = "anonymous";
  session.profile = undefined;

  res.json({ loggedIn: false });
}));

/**
 * Troubleshooting/demo panel (public/admin.html) — shows every real signal
 * evaluation and the decision Mia actually made from it, hold_back included,
 * per session. Gated by a shared secret: this exposes internal reasoning
 * (and session-level profile data) on the same public *.run.app URL the
 * storefront widget calls, not something every visitor should be able to load.
 */
function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminPanel.token) {
    res.status(503).json({ error: "admin panel disabled — set ADMIN_PANEL_TOKEN" });
    return;
  }
  const provided = req.header("x-admin-token") || (req.query.token as string | undefined);
  if (provided !== config.adminPanel.token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

chatRouter.get("/admin/sessions", requireAdminToken, (_req, res) => {
  const list = [...sessions.values()]
    .map((s) => ({
      sessionId: s.sessionId,
      customerId: s.customerId,
      identityTier: s.identityTier,
      historyLength: s.history.length,
      lastActivityAt: s.behavior.lastActivityAt,
      cart: s.cart ? { totalQuantity: s.cart.totalQuantity, totalAmount: s.cart.totalAmount } : null,
      triggersFiredThisSession: s.behavior.triggersFiredThisSession,
    }))
    .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  res.json({ sessions: list });
});

chatRouter.get("/admin/logs", requireAdminToken, (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
  const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
  res.json({ logs: getTurnLogs({ sessionId, limit }) });
});
