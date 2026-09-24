import { config } from "../config.js";
import type { CustomerProfile } from "../types.js";

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
 *
 * Reads and writes use genuinely different Bloomreach credentials — this is
 * a real platform distinction (Public vs Private API access groups), not a
 * permissions checkbox on the same key. See CLAUDE.md before changing either.
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

/** Writes a generic named event — the log_event tool's real backing call. */
export async function recordEvent(customerId: string, event: string, properties: Record<string, unknown>): Promise<void> {
  if (!config.bloomreach.apiToken) {
    console.log(`[bloomreach:stub] would record ${event} for ${customerId}`, properties);
    return;
  }
  await trackEvent(customerId, event, properties);
}

/**
 * Sets real customer properties (not events) — uses the same Public-group
 * token as trackEvent, unlike reads below. Fire-and-forget from callers'
 * perspective is fine; Bloomreach queues this asynchronously on its side.
 */
export async function writeCustomerProperties(customerId: string, properties: Record<string, unknown>): Promise<void> {
  if (!config.bloomreach.apiToken) {
    console.log(`[bloomreach:stub] would write properties for ${customerId}`, properties);
    return;
  }
  const url = `${config.bloomreach.apiBaseUrl}/track/v2/projects/${config.bloomreach.projectToken}/customers`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${config.bloomreach.apiToken}`,
    },
    body: JSON.stringify({
      customer_ids: { [config.bloomreach.customerIdField]: customerId },
      properties,
    }),
  });
  const body = (await res.json()) as { success?: boolean };
  if (!res.ok || body.success === false) {
    throw new Error(`Bloomreach property write error: ${JSON.stringify(body)}`);
  }
}

interface CustomerAttributesResponse {
  success: boolean;
  results: Array<{ success: boolean; value: unknown; error?: string }>;
}

/**
 * Reads real customer properties via the Customer API — needs the Private
 * API group's Key ID/Secret (Basic auth), never the Public-group token used
 * for writes above. Missing/never-set properties come back as null, not an
 * error — that's a real "we don't know this yet," not a failure.
 */
async function readCustomerProperties(customerId: string, propertyNames: string[]): Promise<Record<string, unknown>> {
  if (!config.bloomreach.privateKeyId || !config.bloomreach.privateSecret) {
    return {};
  }
  const url = `${config.bloomreach.apiBaseUrl}/data/v2/projects/${config.bloomreach.projectToken}/customers/attributes`;
  const basicAuth = Buffer.from(`${config.bloomreach.privateKeyId}:${config.bloomreach.privateSecret}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify({
      customer_ids: { [config.bloomreach.customerIdField]: customerId },
      attributes: propertyNames.map((property) => ({ type: "property", property })),
    }),
  });
  const body = (await res.json()) as CustomerAttributesResponse;
  if (!res.ok || body.success === false) {
    throw new Error(`Bloomreach property read error: ${JSON.stringify(body)}`);
  }
  const result: Record<string, unknown> = {};
  propertyNames.forEach((name, i) => {
    const entry = body.results[i];
    result[name] = entry?.success ? entry.value : null;
  });
  return result;
}

const PROFILE_PROPERTY_NAMES = [
  "first_name",
  "usual_size_top",
  "usual_size_shoe",
  "top_category",
  "orders_count",
  "last_order_date",
  "last_order_items",
  "segment",
  "consent",
  "open_support_case",
] as const;

/**
 * The real "known identity" lookup — a live Bloomreach read, not fixture
 * data. Returns undefined only when nothing about this customer is known
 * yet (every property came back null), so callers can treat them as
 * anonymous rather than "known but empty."
 */
export async function getCustomerProfile(customerId: string): Promise<CustomerProfile | undefined> {
  const raw = await readCustomerProperties(customerId, [...PROFILE_PROPERTY_NAMES]);
  const hasAnyValue = Object.values(raw).some((v) => v !== null && v !== undefined);
  if (!hasAnyValue) return undefined;

  return {
    firstName: (raw.first_name as string) ?? undefined,
    usualSizeTop: (raw.usual_size_top as string) ?? undefined,
    usualSizeShoe: (raw.usual_size_shoe as string) ?? undefined,
    topCategory: (raw.top_category as string) ?? undefined,
    ordersCount: (raw.orders_count as number) ?? undefined,
    lastOrderDate: (raw.last_order_date as string) ?? undefined,
    lastOrderItems: (raw.last_order_items as string[]) ?? undefined,
    segment: (raw.segment as string) ?? undefined,
    consent: (raw.consent as boolean) ?? undefined,
    openSupportCase: (raw.open_support_case as boolean) ?? undefined,
  };
}

/** Writes learned profile fields back to Bloomreach — camelCase in, real snake_case properties out. */
export async function updateCustomerProfile(customerId: string, profile: Partial<CustomerProfile>): Promise<void> {
  const properties: Record<string, unknown> = {};
  if (profile.firstName !== undefined) properties.first_name = profile.firstName;
  if (profile.usualSizeTop !== undefined) properties.usual_size_top = profile.usualSizeTop;
  if (profile.usualSizeShoe !== undefined) properties.usual_size_shoe = profile.usualSizeShoe;
  if (profile.topCategory !== undefined) properties.top_category = profile.topCategory;
  if (profile.ordersCount !== undefined) properties.orders_count = profile.ordersCount;
  if (profile.lastOrderDate !== undefined) properties.last_order_date = profile.lastOrderDate;
  if (profile.lastOrderItems !== undefined) properties.last_order_items = profile.lastOrderItems;
  if (profile.segment !== undefined) properties.segment = profile.segment;
  if (profile.consent !== undefined) properties.consent = profile.consent;
  if (profile.openSupportCase !== undefined) properties.open_support_case = profile.openSupportCase;

  if (Object.keys(properties).length === 0) return;
  await writeCustomerProperties(customerId, properties);
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
