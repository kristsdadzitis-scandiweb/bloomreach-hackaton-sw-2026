/**
 * Shared types for the proactive shopping assistant.
 * A customer browsing the site gets a proactive chat prompt, the agent helps
 * pick products (and complements), then hands off a Shopify cart for checkout.
 */

/** A single turn in the shopping conversation. */
export interface ChatTurn {
  role: "customer" | "agent";
  message: string;
  timestamp: string;
  /** Product cards shown alongside an agent turn, if search_products was called. */
  products?: ProductPageContext[];
}

export interface ChatSession {
  sessionId: string;
  customerId: string;
  history: ChatTurn[];
  /** Shopify cart id, once the customer has added a first item this session. */
  cartId?: string;
  /** Set once the customer "logs in" (demo login toggle) — attached to their cart. */
  customerAccessToken?: string;
  customerName?: string;
  /** The real product the customer's current page is showing, if any. */
  currentProduct?: ProductPageContext;
}

export interface ProductPageContext {
  handle: string;
  title: string;
  priceRange: string;
  available: boolean;
  /** So the page's own "Add to cart" button can add this exact variant. */
  variantId: string;
}

/** The cart the agent hands off for checkout. */
export interface CartHandoff {
  checkoutUrl: string;
  lineItems: Array<{ variantId: string; quantity: number }>;
}
