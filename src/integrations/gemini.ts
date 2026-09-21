import { config } from "../config.js";
import type { ChatSession, DriftContext, OutreachDecision } from "../types.js";

/**
 * Step 2 + step 4: Gemini is the reasoning layer — decides who's worth contacting,
 * drafts the opener, and runs the shopping conversation.
 * TODO once GEMINI_API_KEY lands: replace the mocked responses with real calls
 * (Google AI Studio for prototyping, Gemini Enterprise API for the deployed version).
 */

/** Step 2: decide whether this customer is worth contacting, and draft the opener. */
export async function decideOutreach(context: DriftContext): Promise<OutreachDecision> {
  if (!config.google.geminiApiKey) {
    return mockDecision(context);
  }

  // TODO: call Gemini Enterprise with a structured prompt built from `context`,
  // asking it to weigh engagement/CLV/category affinity and return a decision
  // in the OutreachDecision shape (worth contacting, channel, message, recommendations).
  return mockDecision(context);
}

/** Step 4: one turn of the shopping conversation, grounded in Shopify product context. */
export async function chatReply(session: ChatSession, productContext: string): Promise<string> {
  if (!config.google.geminiApiKey) {
    return `[gemini:stub] (would answer using: ${productContext || "no product context yet"})`;
  }

  // TODO: call Gemini with session.history + productContext (live Shopify price/availability)
  // so answers stay grounded in real stock, not hallucinated.
  return `[gemini:stub] (would answer using: ${productContext || "no product context yet"})`;
}

function mockDecision(context: DriftContext): OutreachDecision {
  const worthContacting = context.engagementScore > 0.2 || context.predictedLifetimeValue > 100;
  return {
    worthContacting,
    channel: context.engagementScore < 0.4 ? "sms" : "email",
    openingMessage: `Hey — noticed you haven't checked out ${context.topCategoryAffinity} in a while. New arrivals just landed.`,
    recommendedProductHandles: [],
    reason: "mock decision — replace with a real Gemini call",
  };
}
