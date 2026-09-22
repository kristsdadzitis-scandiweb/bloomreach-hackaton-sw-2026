import { config } from "../config.js";

/**
 * Loop closure: Bloomreach is the system-of-record layer. Once a chat
 * session closes a sale, the order event is tracked back onto the real
 * customer profile via the Engagement Track API.
 */

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

/** Loop closure: write the order event back so Bloomreach's profile + nurture sequence pick it up. */
export async function recordOrderEvent(customerId: string, orderId: string): Promise<void> {
  if (!config.bloomreach.apiToken) {
    console.log(`[bloomreach:stub] would record order ${orderId} for ${customerId} and trigger nurture sequence`);
    return;
  }

  await trackEvent(customerId, "purchase", { order_id: orderId });
}
