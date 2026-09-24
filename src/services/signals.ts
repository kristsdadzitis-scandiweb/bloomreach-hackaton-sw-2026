import type { ChatSession } from "../types.js";

/**
 * The "a rule opens the question, the model decides" layer the playbook
 * describes. This never decides whether to actually speak — that's Gemini's
 * job, given this as input. It only proposes what's evidently true about the
 * session right now, Tier 1 only (Tier 2/3 are out of scope for this build).
 */

export type TierOneTrigger =
  | "size_guide_reopened"
  | "availability_block"
  | "cart_left_behind"
  | "complete_the_kit"
  | "hold_back";

export interface SignalCase {
  trigger: TierOneTrigger;
  evidence: string[];
  alsoTrue: string[];
  computedIn: string;
  quietRulesInForce: string[];
}

const CART_IDLE_MS = 90_000;
const SIZE_GUIDE_REOPEN_THRESHOLD = 2;

function holdBack(alsoTrue: string[], quietRulesInForce: string[]): SignalCase {
  return {
    trigger: "hold_back",
    evidence: ["no Tier 1 condition cleanly fired this check"],
    alsoTrue,
    computedIn: "server:evaluateSignalCase",
    quietRulesInForce,
  };
}

/**
 * Evaluates the current session's behavior against the Tier 1 trigger table.
 * Always returns a populated SignalCase — hold_back is a real, logged
 * decision (with its own evidence/quiet-rules trail), never "nothing".
 *
 * `unmatchedPairsWith` is real catalog data (which of a cart item's
 * pairs_with complements aren't in the cart yet) — this layer has no
 * Shopify access itself, so the caller resolves it before calling in.
 */
export function evaluateSignalCase(session: ChatSession, unmatchedPairsWith: string[] = []): SignalCase {
  const { behavior } = session;
  const alreadyFired = new Set(behavior.triggersFiredThisSession);
  const alsoTrue: string[] = [];
  const quietRulesInForce: string[] = [];

  // 1. Size guide reopened: same product's size guide opened enough times,
  // with no add-to-cart for it yet.
  const reopenCounts = new Map<string, number>();
  for (const open of behavior.sizeGuideOpens) {
    reopenCounts.set(open.productId, (reopenCounts.get(open.productId) ?? 0) + 1);
  }
  for (const [productId, count] of reopenCounts) {
    if (count >= SIZE_GUIDE_REOPEN_THRESHOLD && !alreadyFired.has(`size_guide_reopened:${productId}`)) {
      return {
        trigger: "size_guide_reopened",
        evidence: [`size guide for ${productId} opened ${count} times`, "no add-to-cart for it yet"],
        alsoTrue,
        computedIn: "server:evaluateSignalCase",
        quietRulesInForce,
      };
    }
  }
  if (reopenCounts.size > 0) alsoTrue.push("a size guide was opened, but not enough times yet to fire");

  // 2. Availability block: a viewed size was out of stock, not yet acted on.
  if (behavior.lastUnavailableSizeView && !alreadyFired.has(`availability_block:${behavior.lastUnavailableSizeView.sku}`)) {
    const { sku, size } = behavior.lastUnavailableSizeView;
    return {
      trigger: "availability_block",
      evidence: [`viewed ${sku} in size ${size}, which has zero stock`],
      alsoTrue,
      computedIn: "server:evaluateSignalCase",
      quietRulesInForce,
    };
  }

  // 3. Cart left behind: cart non-empty, idle past the threshold, checkout not started.
  if (behavior.cartLastModifiedAt && behavior.checkoutStep === "none") {
    const idleMs = Date.now() - new Date(behavior.cartLastModifiedAt).getTime();
    if (idleMs >= CART_IDLE_MS && !alreadyFired.has("cart_left_behind")) {
      return {
        trigger: "cart_left_behind",
        evidence: [`cart last modified ${Math.round(idleMs / 1000)}s ago`, "checkout not started"],
        alsoTrue,
        computedIn: "server:evaluateSignalCase",
        quietRulesInForce,
      };
    }
    if (idleMs < CART_IDLE_MS) alsoTrue.push("cart is recent, not yet idle long enough for cart_left_behind");
  }
  if (behavior.checkoutStep === "opened") {
    quietRulesInForce.push("checkout is open — never speak while a field may have focus");
  }

  // 4. Complete the kit: a cart item has a real, unbought pairs_with match.
  if (unmatchedPairsWith.length > 0 && !behavior.opportunityUsedThisSession && !alreadyFired.has("complete_the_kit")) {
    return {
      trigger: "complete_the_kit",
      evidence: [`cart item pairs with ${unmatchedPairsWith.join(", ")}, not yet in cart`],
      alsoTrue,
      computedIn: "server:evaluateSignalCase",
      quietRulesInForce,
    };
  }
  if (behavior.opportunityUsedThisSession) {
    quietRulesInForce.push("opportunity already used this session — at most one per session");
  }

  return holdBack(alsoTrue, quietRulesInForce);
}
