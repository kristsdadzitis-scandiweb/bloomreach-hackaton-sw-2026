import { config } from "../config.js";
import type { CartHandoff } from "../types.js";

/**
 * Step 4 + 5: Shopify grounds the conversation in real stock/price, then builds the cart.
 * TODO once SHOPIFY_STOREFRONT_API_TOKEN / SHOPIFY_ADMIN_API_TOKEN land: replace the
 * mocked responses with real Storefront/Admin API (GraphQL) calls against the dev store.
 */

export interface ProductSummary {
  handle: string;
  title: string;
  priceRange: string;
  available: boolean;
}

/** Step 4: ground a customer question in real catalog data. */
export async function searchProducts(query: string): Promise<ProductSummary[]> {
  if (!config.shopify.storeDomain) {
    return mockProducts(query);
  }

  // TODO: call the Storefront API's `products(query: ...)` field.
  return mockProducts(query);
}

/** Step 5: build the cart and hand back a checkout URL. */
export async function createCart(lineItems: Array<{ variantId: string; quantity: number }>): Promise<CartHandoff> {
  if (!config.shopify.storeDomain) {
    return { checkoutUrl: "https://example-dev-store.myshopify.com/cart/mock-checkout", lineItems };
  }

  // TODO: call the Storefront API's `cartCreate` mutation, return `cart.checkoutUrl`.
  // Note: dev store checkout pages are password-protected — factor that into the demo.
  return { checkoutUrl: "https://example-dev-store.myshopify.com/cart/mock-checkout", lineItems };
}

function mockProducts(query: string): ProductSummary[] {
  return [
    { handle: "mock-product-1", title: `Mock result for "${query}"`, priceRange: "$49.00", available: true },
  ];
}
