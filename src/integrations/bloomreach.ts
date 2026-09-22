import { config } from "../config.js";
import type { DriftContext, OutreachDecision } from "../types.js";

/**
 * Step 3 + loop closure: Bloomreach is the activation and system-of-record layer.
 * Both outbound calls go through the Engagement Track API rather than Loomi Connect —
 * Loomi Connect's documented auth is SSO, which doesn't fit an unattended server call.
 * A Bloomreach scenario triggers off these tracked events to do the actual sending.
 */

/** Verifies the shared secret on an inbound scenario webhook call (step 1/3 trigger). */
export function verifyWebhookSignature(providedSecret: string | undefined): boolean {
  if (!config.bloomreach.webhookSecret) return true; // secret not configured yet — allow through locally
  return providedSecret === config.bloomreach.webhookSecret;
}

async function trackEvent(
  customerId: string,
  eventType: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const url = `${config.bloomreach.apiBaseUrl}/track/v2/projects/${config.bloomreach.projectToken}/customers/events`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${config.bloomreach.apiToken}`,
    },
    body: JSON.stringify({
      customer_ids: { [config.bloomreach.customerIdField]: customerId },
      event_type: eventType,
      properties,
    }),
  });

  const body = (await res.json()) as { success?: boolean };
  if (!res.ok || body.success === false) {
    throw new Error(`Bloomreach track event error: ${JSON.stringify(body)}`);
  }
}

/** Step 3: track the drafted outreach so a Bloomreach scenario can send the SMS/email. */
export async function sendOutreach(context: DriftContext, decision: OutreachDecision): Promise<void> {
  if (!config.bloomreach.apiToken) {
    console.log(`[bloomreach:stub] would send ${decision.channel} to ${context.customerId}: "${decision.openingMessage}"`);
    return;
  }

  await trackEvent(context.customerId, "chat_to_buy_outreach_decided", {
    channel: decision.channel,
    opening_message: decision.openingMessage,
    reason: decision.reason,
    recommended_product_handles: decision.recommendedProductHandles,
  });
}

/** Loop closure: write the order event back so Bloomreach's profile + nurture sequence pick it up. */
export async function recordOrderEvent(customerId: string, orderId: string): Promise<void> {
  if (!config.bloomreach.apiToken) {
    console.log(`[bloomreach:stub] would record order ${orderId} for ${customerId} and trigger nurture sequence`);
    return;
  }

  await trackEvent(customerId, "purchase", { order_id: orderId });
}
