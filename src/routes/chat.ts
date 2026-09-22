import { Router } from "express";
import { randomUUID } from "node:crypto";
import { chatReply } from "../integrations/gemini.js";
import { createCart } from "../integrations/shopify.js";
import { recordOrderEvent } from "../integrations/bloomreach.js";
import type { ChatSession } from "../types.js";

/**
 * Step 4: the conversation the deep link opens. Extremely lean in-memory session
 * store for now — fine for a hackathon demo, revisit if it needs to survive
 * across Cloud Run instances.
 */
export const chatRouter = Router();

const sessions = new Map<string, ChatSession>();

chatRouter.post("/session", (req, res) => {
  const sessionId = randomUUID();
  const customerId = req.body?.customerId ?? "unknown";
  sessions.set(sessionId, { sessionId, customerId, history: [] });
  res.json({ sessionId });
});

chatRouter.post("/message", async (req, res) => {
  const { sessionId, message } = req.body as { sessionId: string; message: string };
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown session — call /api/chat/session first" });
  }

  session.history.push({ role: "customer", message, timestamp: new Date().toISOString() });

  const { reply, products } = await chatReply(session, message);

  session.history.push({ role: "agent", message: reply, timestamp: new Date().toISOString() });

  res.json({ reply, products });
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

  const cart = await createCart(lineItems);

  // Loop closure is triggered for real once Shopify's order webhook fires;
  // stubbed here so the full loop is visible end to end in local dev.
  await recordOrderEvent(session.customerId, "mock-order-id");

  res.json(cart);
});
