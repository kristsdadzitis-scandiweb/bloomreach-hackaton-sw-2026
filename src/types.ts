/**
 * Shared types for the Chat-to-Buy loop.
 * Mirrors the five steps in the architecture diagram:
 * detect drift -> decide & draft -> reach out -> chat & compare -> cart & handoff.
 */

/** Step 1: what Bloomreach's webhook hands us about a drifting customer. */
export interface DriftContext {
  customerId: string;
  daysSinceLastPurchase: number;
  purchaseFrequencyTrend: "steady" | "slowing" | "stopped";
  engagementScore: number; // 0-1, recent email/SMS/web engagement
  topCategoryAffinity: string;
  predictedLifetimeValue: number;
  lastPurchasedProduct?: string;
}

/** Step 2: Gemini's decision about whether/how to reach out. */
export interface OutreachDecision {
  worthContacting: boolean;
  channel: "sms" | "email";
  openingMessage: string;
  recommendedProductHandles: string[];
  reason: string;
}

/** A single turn in the step-4 shopping conversation. */
export interface ChatTurn {
  role: "customer" | "agent";
  message: string;
  timestamp: string;
}

export interface ChatSession {
  sessionId: string;
  customerId: string;
  history: ChatTurn[];
}

/** Step 5: the cart the agent hands off for checkout. */
export interface CartHandoff {
  checkoutUrl: string;
  lineItems: Array<{ variantId: string; quantity: number }>;
}
