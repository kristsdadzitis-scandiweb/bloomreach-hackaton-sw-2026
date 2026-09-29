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
  /** Product cards shown alongside an agent turn, if search_catalog was called. */
  products?: MiaCandidate[];
  /** Quick-reply chips offered alongside an agent turn — persisted so a page reload (which wipes the widget's in-memory DOM) can restore the last turn's real options instead of leaving none. */
  chips?: string[];
}

export type IdentityTier = "anonymous" | "known" | "just_signed_in";

/** A real Bloomreach customer property lookup, not fixture data. Absent fields are genuinely unknown. */
export interface CustomerProfile {
  firstName?: string;
  usualSizeTop?: string;
  usualSizeShoe?: string;
  topCategory?: string;
  ordersCount?: number;
  lastOrderDate?: string;
  lastOrderItems?: string[];
  segment?: string;
  consent?: boolean;
  openSupportCase?: boolean;
}

export interface ProductViewStat {
  productId: string;
  views: number;
  totalSeconds: number;
  lastViewedAt: string;
  /** The product's own category at view time — comparison_stall groups by this, not just by product id. */
  category?: string;
}

export interface SizeGuideOpen {
  productId: string;
  openedAt: string;
}

export interface UnavailableSizeView {
  sku: string;
  size: string;
  viewedAt: string;
}

export type CheckoutStep = "none" | "opened" | "abandoned";

/** Raw behavioral signals the widget reports — the input evaluateSignalCase reasons over. */
export interface SessionBehavior {
  device: "mobile" | "desktop" | "unknown";
  pageType: "home" | "category" | "pdp" | "cart" | "unknown";
  category?: string;
  productsViewed: Record<string, ProductViewStat>;
  filters: Record<string, string | string[]>;
  sort?: string;
  sizeGuideOpens: SizeGuideOpen[];
  lastUnavailableSizeView?: UnavailableSizeView;
  checkoutStep: CheckoutStep;
  checkoutOpenedAt?: string;
  cartLastModifiedAt?: string;
  lastActivityAt: string;
  opportunityUsedThisSession: boolean;
  triggersFiredThisSession: string[];
  /** When Mia last actually spoke a proactive (signal-driven) turn — lets evaluateSignalCase space out two different triggers that both go true within a few seconds of each other, instead of firing back-to-back. Never set by a direct reply to a customer message. */
  lastProactiveSpokeAt?: string;
}

export function newSessionBehavior(): SessionBehavior {
  return {
    device: "unknown",
    pageType: "unknown",
    productsViewed: {},
    filters: {},
    sizeGuideOpens: [],
    checkoutStep: "none",
    lastActivityAt: new Date().toISOString(),
    opportunityUsedThisSession: false,
    triggersFiredThisSession: [],
  };
}

/** One real cart line, for rendering an honest order-summary card and reasoning about complete_the_kit — never fabricated data. */
export interface CartLineInfo {
  handle: string;
  title: string;
  variantTitle: string;
  quantity: number;
  lineTotal: number;
  /** Real Shopify ProductVariant gid — needed to build a UCP (Agentic Storefronts) checkout handoff from this line. */
  variantId: string;
}

/**
 * The shopper's real, visible cart — the same one the theme's own cart
 * drawer/checkout shows, since "Add to cart" now goes straight to the
 * theme's native `/cart/add.js` instead of a separate Storefront-API cart
 * the backend created (see CLAUDE.md's "Native cart switch" section for why:
 * the old approach never showed up in the store's own cart panel at all).
 * The backend has no session/cookie into that native cart, so this is
 * populated entirely from what the widget reports after reading `/cart.js`
 * itself — the backend still resolves the *product* side (handle,
 * pairs_with) from the real variant ids the client sends, never trusting
 * anything about product data from the client directly.
 */
export interface ClientReportedCart {
  totalQuantity: number;
  totalAmount: number;
  currencyCode: string;
  lines: CartLineInfo[];
  lineHandles: string[];
  unmatchedPairsWith: string[];
}

export interface ChatSession {
  sessionId: string;
  customerId: string;
  history: ChatTurn[];
  /**
   * The shopper's real, native cart (the one the theme's own cart drawer and
   * checkout show) — see ClientReportedCart. Populated by the widget, not
   * fetched by the backend, since the backend has no browser session into it.
   * The single cart for everything cart-aware in this app — a product-card
   * "Add to cart" click and a typed "add this to my cart" message both end
   * up here, deliberately, after an earlier version kept the two separate
   * and a real add via conversation silently never showed an order-summary
   * card at all (see CLAUDE.md's "Native cart switch" section).
   */
  cart?: ClientReportedCart;
  customerName?: string;
  /** The real product the customer's current page is showing, if any — full candidate shape so the size guide and Mia's own page-awareness have real sizes/stock/fit note to work with. */
  currentProduct?: MiaCandidate;
  identityTier: IdentityTier;
  /** Populated from a real Bloomreach read — never fixture/fabricated data. */
  profile?: CustomerProfile;
  behavior: SessionBehavior;
}

/** A real search_catalog result — every field here must trace back to a Shopify read. */
export interface MiaCandidate {
  id: string;
  sku: string;
  variantId: string;
  name: string;
  category: string;
  price: string;
  /** True if any variant (sized or not) has real stock — the general purchasability check. */
  available: boolean;
  sizesInStock: string[];
  /** Real per-size stock counts and variant ids — the widget needs the exact variantId for the size actually selected, not just the first variant. Empty for products with no Size option. */
  stockBySize: Record<string, number>;
  variantIdsBySize: Record<string, string>;
  waterproof?: string;
  insulation?: string;
  weightG?: number;
  fitNote?: string;
  layer?: string;
  pairsWith?: string[];
  image?: string;
}

export interface MiaDecision {
  action: "open_chat" | "stay_closed" | "continue";
  readAs: string;
  confidence: "low" | "medium" | "high";
  rejected: Array<{ reading: string; why: string }>;
  offer: { type: "none" | "free_shipping"; why: string };
}

export interface MiaReply {
  text: string;
  show: string[];
  recommendSizes: Record<string, string>;
  addToCart: Array<{ sku: string; size: string; qty: number }>;
  openCheckout: boolean;
  chips: string[];
}

export interface MiaWriteBack {
  event: string;
  properties: Record<string, unknown>;
}

export interface MiaResponse {
  decision: MiaDecision;
  reply: MiaReply;
  writeBack: MiaWriteBack;
}
