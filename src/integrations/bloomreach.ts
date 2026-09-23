import { config } from "../config.js";

/**
 * Loop closure: Bloomreach is the system-of-record layer. Cart activity from
 * the chat is tracked back onto the real customer profile via the Engagement
 * Track API, so it's available for segmentation/personalization there.
 *
 * This intentionally stops at "added to cart," not "purchased" — a genuine
 * purchase-confirmed event needs a Shopify order webhook, and Shopify gates
 * order webhooks (they carry customer PII) behind a protected-customer-data
 * approval this app doesn't have. Reporting a fake "purchase" event on every
 * cart add would be worse than not reporting one at all.
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

export interface CartUpdateDetails {
  cartId: string;
  totalQuantity: number;
  lineItems: Array<{ variantId: string; quantity: number }>;
}

/** Track real cart-building behavior back onto the customer's profile. */
export async function recordCartUpdateEvent(customerId: string, cart: CartUpdateDetails): Promise<void> {
  if (!config.bloomreach.apiToken) {
    console.log(`[bloomreach:stub] would record cart_updated for ${customerId}`, cart);
    return;
  }

  await trackEvent(customerId, "cart_updated", {
    cart_id: cart.cartId,
    total_quantity: cart.totalQuantity,
    line_items: cart.lineItems,
  });
}
