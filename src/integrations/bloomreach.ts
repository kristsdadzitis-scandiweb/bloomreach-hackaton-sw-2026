import { config } from "../config.js";
import type { DriftContext, OutreachDecision } from "../types.js";

/**
 * Step 3 + loop closure: Bloomreach is the activation and system-of-record layer.
 * TODO once BLOOMREACH_LOOMI_CONNECT_URL / BLOOMREACH_PROJECT_TOKEN land:
 * wire these up to Loomi Connect (MCP) and/or the Platform APIs.
 */

/** Verifies the shared secret on an inbound scenario webhook call (step 1/3 trigger). */
export function verifyWebhookSignature(providedSecret: string | undefined): boolean {
  if (!config.bloomreach.webhookSecret) return true; // secret not configured yet — allow through locally
  return providedSecret === config.bloomreach.webhookSecret;
}

/** Step 3: hand the drafted message to the Marketing Agent / scenario to actually send it. */
export async function sendOutreach(context: DriftContext, decision: OutreachDecision): Promise<void> {
  // TODO: call Loomi Connect / Marketing Agent (Pattern 1) to build + fire the SMS/email scenario.
  console.log(`[bloomreach:stub] would send ${decision.channel} to ${context.customerId}: "${decision.openingMessage}"`);
}

/** Loop closure: write the order event back so Bloomreach's profile + nurture sequence pick it up. */
export async function recordOrderEvent(customerId: string, orderId: string): Promise<void> {
  // TODO: write the order event via Platform APIs, then call the Marketing Agent (Pattern 1)
  // to build the post-purchase nurture sequence, per T2's recommended composability pattern.
  console.log(`[bloomreach:stub] would record order ${orderId} for ${customerId} and trigger nurture sequence`);
}
