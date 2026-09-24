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

export interface ChatSession {
  sessionId: string;
  customerId: string;
  history: ChatTurn[];
  /** Shopify cart id, once the customer has added a first item this session. */
  cartId?: string;
  /** Set once the customer "logs in" (demo login toggle) — attached to their cart. */
  customerAccessToken?: string;
  customerName?: string;
  /** The real product the customer's current page is showing, if any — full candidate shape so the size guide and Mia's own page-awareness have real sizes/stock/fit note to work with. */
  currentProduct?: MiaCandidate;
  identityTier: IdentityTier;
  /** Populated from a real Bloomreach read — never fixture/fabricated data. */
  profile?: CustomerProfile;
  behavior: SessionBehavior;
}

/** The cart the agent hands off for checkout. */
export interface CartHandoff {
  checkoutUrl: string;
  lineItems: Array<{ variantId: string; quantity: number }>;
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
