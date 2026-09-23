import { Router } from "express";
import { randomUUID } from "node:crypto";
import { chatReply } from "../integrations/gemini.js";
import {
  addToCart,
  attachDemoDeliveryAddress,
  getProductByHandle,
  loginDemoCustomer,
  updateCartBuyerIdentity,
} from "../integrations/shopify.js";
import { recordCartUpdateEvent } from "../integrations/bloomreach.js";
import type { ChatSession } from "../types.js";

/**
 * The proactive shopping conversation. Extremely lean in-memory session
 * store for now — fine for a hackathon demo, revisit if it needs to survive
 * across Cloud Run instances.
 */
export const chatRouter = Router();

const sessions = new Map<string, ChatSession>();

chatRouter.post("/session", async (req, res) => {
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
    session = { sessionId: randomUUID(), customerId: customerId ?? "unknown", history: [] };
    sessions.set(session.sessionId, session);
  }

  if (productHandle) {
    const product = await getProductByHandle(productHandle);
    if (product) {
      session.currentProduct = product;
    }
  }

  res.json({ sessionId: session.sessionId, product: session.currentProduct ?? null, history: session.history });
});

chatRouter.post("/message", async (req, res) => {
  const { sessionId, message } = req.body as { sessionId: string; message: string };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session — call /api/chat/session first" });
  }

  session.history.push({ role: "customer", message, timestamp: new Date().toISOString() });

  const { reply, products, quickReplies } = await chatReply(session, message);

  session.history.push({ role: "agent", message: reply, timestamp: new Date().toISOString() });

  res.json({ reply, products, quickReplies });
});

chatRouter.post("/checkout", async (req, res) => {
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

  // A genuine "purchase" event needs a Shopify order webhook, which needs
  // protected-customer-data approval this app doesn't have (see bloomreach.ts).
  // Track the real, verifiable signal we do have instead: the cart itself.
  await recordCartUpdateEvent(session.customerId, cart);

  res.json(cart);
});

chatRouter.post("/login", async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session" });
  }

  const profile = await loginDemoCustomer();
  session.customerAccessToken = profile.accessToken;
  session.customerName = profile.firstName;

  if (session.cartId) {
    await updateCartBuyerIdentity(session.cartId, profile.accessToken);
    await attachDemoDeliveryAddress(session.cartId);
  }

  res.json({ loggedIn: true, name: profile.firstName, email: profile.email });
});

chatRouter.post("/logout", async (req, res) => {
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

  res.json({ loggedIn: false });
});
