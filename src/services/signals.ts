import type { ChatSession } from "../types.js";

/**
 * The "a rule opens the question, the model decides" layer the playbook
 * describes. This never decides whether to actually speak — that's Gemini's
 * job, given this as input. It only proposes what's evidently true about the
 * session right now. Tier 1 (all 5 below through complete_the_kit) is fully
 * built; comparison_stall is the first Tier 2 ("build if time") trigger from
 * the colleague's Trigger Screens artifact — the rest of Tier 2, and all of
 * Tier 3 (explicitly "design only" in that artifact), are not implemented.
 */

export type Trigger =
  | "size_guide_reopened"
  | "availability_block"
  | "cart_left_behind"
  | "complete_the_kit"
  | "comparison_stall"
  | "hold_back";

export interface SignalCase {
  trigger: Trigger;
  /**
   * What the caller should record into `triggersFiredThisSession` once this
   * turn actually speaks. Per-entity triggers (size_guide_reopened,
   * availability_block) key this by product/SKU so reopening the guide for a
   * *different* product can still fire — the bare trigger name alone would
   * either never re-suppress (if never recorded) or wrongly block every
   * other product forever (if recorded bare). Equal to `trigger` for
   * triggers that are inherently session-wide (cart_left_behind,
   * complete_the_kit, hold_back).
   */
  firedKey: string;
  evidence: string[];
  alsoTrue: string[];
  computedIn: string;
  quietRulesInForce: string[];
}

const CART_IDLE_MS = 90_000;
const SIZE_GUIDE_REOPEN_THRESHOLD = 2;
const COMPARISON_STALL_WINDOW_MS = 10 * 60_000;
const COMPARISON_STALL_MIN_PRODUCTS = 3;

function holdBack(alsoTrue: string[], quietRulesInForce: string[]): SignalCase {
  return {
    trigger: "hold_back",
    firedKey: "hold_back",
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
 * `unmatchedPairsWith` is real catalog data: handles of cart items that
 * themselves have a pairs_with complement missing from the cart (the same
 * id search_catalog's own `pairs_with` filter expects) — this layer has no
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
    const firedKey = `size_guide_reopened:${productId}`;
    if (count >= SIZE_GUIDE_REOPEN_THRESHOLD && !alreadyFired.has(firedKey)) {
      return {
        trigger: "size_guide_reopened",
        firedKey,
        evidence: [`size guide for ${productId} opened ${count} times`, "no add-to-cart for it yet"],
        alsoTrue,
        computedIn: "server:evaluateSignalCase",
        quietRulesInForce,
      };
    }
  }
  if (reopenCounts.size > 0) alsoTrue.push("a size guide was opened, but not enough times yet to fire");

  // 2. Availability block: a viewed size was out of stock, not yet acted on.
  if (behavior.lastUnavailableSizeView) {
    const { sku, size } = behavior.lastUnavailableSizeView;
    const firedKey = `availability_block:${sku}`;
    if (!alreadyFired.has(firedKey)) {
      return {
        trigger: "availability_block",
        firedKey,
        evidence: [`viewed ${sku} in size ${size}, which has zero stock`],
        alsoTrue,
        computedIn: "server:evaluateSignalCase",
        quietRulesInForce,
      };
    }
  }

  // 3. Cart left behind: cart non-empty, idle past the threshold, checkout not started.
  if (behavior.cartLastModifiedAt && behavior.checkoutStep === "none") {
    const idleMs = Date.now() - new Date(behavior.cartLastModifiedAt).getTime();
    if (idleMs >= CART_IDLE_MS && !alreadyFired.has("cart_left_behind")) {
      return {
        trigger: "cart_left_behind",
        firedKey: "cart_left_behind",
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
      firedKey: "complete_the_kit",
      evidence: [
        `cart item(s) ${unmatchedPairsWith.join(", ")} have a pairs_with complement not yet in the cart`,
        `call search_catalog with pairs_with:<that cart item's id> to find the real complement to recommend`,
      ],
      alsoTrue,
      computedIn: "server:evaluateSignalCase",
      quietRulesInForce,
    };
  }
  if (behavior.opportunityUsedThisSession) {
    quietRulesInForce.push("opportunity already used this session — at most one per session");
  }

  // 5. Comparison stall (Tier 2): three or more distinct products in the same
  // category viewed within a 10-minute window, cart still empty — undecided,
  // not blocked. Lower priority than every Tier 1 trigger above: a genuine
  // blocker or a post-commitment opportunity should always dominate a softer
  // "still deciding" reading.
  const byCategory = new Map<string, Set<string>>();
  const now = Date.now();
  for (const [productId, stat] of Object.entries(behavior.productsViewed)) {
    if (!stat.category) continue;
    if (now - new Date(stat.lastViewedAt).getTime() > COMPARISON_STALL_WINDOW_MS) continue;
    const seen = byCategory.get(stat.category) ?? new Set<string>();
    seen.add(productId);
    byCategory.set(stat.category, seen);
  }
  for (const [category, ids] of byCategory) {
    const firedKey = `comparison_stall:${category}`;
    if (ids.size >= COMPARISON_STALL_MIN_PRODUCTS && !session.cartId && !alreadyFired.has(firedKey)) {
      return {
        trigger: "comparison_stall",
        firedKey,
        evidence: [
          `${ids.size} distinct ${category} products viewed within 10 minutes: ${[...ids].join(", ")}`,
          "cart is still empty — undecided, not blocked",
          "ask which of price, weight or waterproofing matters most, never guess the criterion",
        ],
        alsoTrue,
        computedIn: "server:evaluateSignalCase",
        quietRulesInForce,
      };
    }
  }
  if (byCategory.size > 0) alsoTrue.push("multiple products viewed in a category, but not enough yet (or a trigger above already fired) for comparison_stall");

  return holdBack(alsoTrue, quietRulesInForce);
}
