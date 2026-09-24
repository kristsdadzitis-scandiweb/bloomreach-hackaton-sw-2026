import type { MiaCandidate, MiaResponse } from "../types.js";

/**
 * Real ground truth from this turn's tool calls — never the model's own
 * claims. Every guardrail below checks the response against this, not
 * against what the model said it did.
 */
export interface GroundTruth {
  candidates: MiaCandidate[];
  cartNonEmpty: boolean;
  cartValue: number;
  freeShippingThreshold: number;
}

const FREE_SHIPPING_WINDOW = 15;

/**
 * Backend-enforced guardrails, applied regardless of what the model
 * returned. Each violation is a real thing the model got wrong or invented —
 * dropped here rather than trusted, and returned alongside the sanitized
 * response as an audit trail.
 */
export function enforceGuardrails(response: MiaResponse, ground: GroundTruth): { safe: MiaResponse; violations: string[] } {
  const violations: string[] = [];
  const candidatesById = new Map(ground.candidates.map((c) => [c.id, c]));

  const show = response.reply.show.filter((id) => {
    const ok = candidatesById.has(id);
    if (!ok) violations.push(`dropped show id "${id}" — not returned by a tool this turn`);
    return ok;
  });

  const recommendSizes: Record<string, string> = {};
  for (const [productId, size] of Object.entries(response.reply.recommendSizes)) {
    const candidate = candidatesById.get(productId);
    const inStock = candidate?.sizesInStock.includes(size);
    if (candidate && inStock) {
      recommendSizes[productId] = size;
    } else {
      violations.push(`dropped recommend_sizes[${productId}]=${size} — zero real stock or unknown product`);
    }
  }

  const shownSkus = new Set(show.map((id) => candidatesById.get(id)?.sku).filter(Boolean));
  const addToCart = response.reply.addToCart.filter((item) => {
    const ok = shownSkus.has(item.sku);
    if (!ok) violations.push(`dropped add_to_cart for sku "${item.sku}" — not among this turn's shown items`);
    return ok;
  });

  let openCheckout = response.reply.openCheckout;
  if (openCheckout && !ground.cartNonEmpty) {
    violations.push("forced open_checkout to false — cart is empty");
    openCheckout = false;
  }

  let offer = response.decision.offer;
  if (offer.type === "free_shipping") {
    const withinWindow = ground.freeShippingThreshold - ground.cartValue <= FREE_SHIPPING_WINDOW && ground.cartValue <= ground.freeShippingThreshold;
    if (!withinWindow) {
      violations.push("coerced free_shipping offer to none — cart value not within the real window");
      offer = { type: "none", why: "not eligible" };
    }
  }

  return {
    safe: {
      decision: { ...response.decision, offer },
      reply: { ...response.reply, show, recommendSizes, addToCart, openCheckout },
      writeBack: response.writeBack,
    },
    violations,
  };
}
