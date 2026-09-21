import { Router } from "express";
import { sendOutreach, verifyWebhookSignature } from "../integrations/bloomreach.js";
import { decideOutreach } from "../integrations/gemini.js";
import type { DriftContext } from "../types.js";

/**
 * Step 1 -> 2 -> 3: the entry point a Bloomreach scenario's webhook node calls
 * mid-journey once a customer trips the drift condition (Pattern 2: webhook as
 * custom skill). Receives the drift context, asks Gemini to decide, and — if
 * worth it — hands the drafted message back to Bloomreach to actually send.
 */
export const webhookRouter = Router();

webhookRouter.post("/bloomreach", async (req, res) => {
  const signature = req.header("x-webhook-secret");
  if (!verifyWebhookSignature(signature)) {
    return res.status(401).json({ error: "invalid webhook signature" });
  }

  const context = req.body as DriftContext;
  if (!context?.customerId) {
    return res.status(400).json({ error: "missing customerId in drift context" });
  }

  const decision = await decideOutreach(context);

  if (decision.worthContacting) {
    await sendOutreach(context, decision);
  }

  res.json({ received: true, decision });
});
