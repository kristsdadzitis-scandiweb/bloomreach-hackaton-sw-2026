import { config } from "../config.js";
import type { ChatSession, DriftContext, OutreachDecision } from "../types.js";
import { searchProducts, type ProductSummary } from "./shopify.js";

/**
 * Step 2 + step 4: Gemini is the reasoning layer — decides who's worth contacting,
 * drafts the opener, and runs the shopping conversation. Both steps use real
 * function-calling so the model grounds itself in Shopify data instead of
 * inventing product handles.
 */

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
}

async function generateContent(body: Record<string, unknown>): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.google.geminiModel}:generateContent?key=${config.google.geminiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API error: ${JSON.stringify(data)}`);
  }
  return data as GeminiResponse;
}

const SEARCH_PRODUCTS_TOOL = {
  functionDeclarations: [
    {
      name: "search_products",
      description:
        "Search the Shopify catalog for products matching a natural-language query. Use this " +
        "before mentioning or recommending any product, price, or availability — never guess.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language search query, e.g. a product type, color, or keyword.",
          },
        },
        required: ["query"],
      },
    },
  ],
};

/**
 * Runs the search_products tool-calling loop against `contents` until the model
 * answers with text instead of a function call, or `maxSteps` is exhausted.
 * Mutates `contents` in place so the caller can keep building on the transcript.
 */
async function runSearchToolLoop(
  contents: GeminiContent[],
  systemPrompt: string,
  maxSteps = 3,
): Promise<{ parts: GeminiPart[]; products: ProductSummary[] }> {
  let products: ProductSummary[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const data = await generateContent({
      contents,
      tools: [SEARCH_PRODUCTS_TOOL],
      systemInstruction: { parts: [{ text: systemPrompt }] },
    });

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const functionCallPart = parts.find((p) => p.functionCall);

    if (!functionCallPart?.functionCall) {
      return { parts, products };
    }

    contents.push({ role: "model", parts });

    const { name, args } = functionCallPart.functionCall;
    const result = name === "search_products" ? await searchProducts(String(args.query ?? "")) : { error: `unknown tool ${name}` };
    if (name === "search_products") {
      products = result as ProductSummary[];
    }

    contents.push({
      role: "function",
      parts: [{ functionResponse: { name, response: { result } } }],
    });
  }

  return { parts: [], products };
}

/** Step 2: decide whether this customer is worth contacting, and draft the opener. */
export async function decideOutreach(context: DriftContext): Promise<OutreachDecision> {
  if (!config.google.geminiApiKey) {
    return mockDecision(context);
  }

  const prompt = `A repeat customer's purchase rhythm has drifted. Weigh engagement, predicted
lifetime value, and how long they've drifted to decide whether to reach out, then draft a short,
warm opener referencing their category affinity if it's worth contacting them. If you recommend
products, first use search_products to confirm they actually exist and are in stock.

Customer signals:
- Days since last purchase: ${context.daysSinceLastPurchase}
- Purchase frequency trend: ${context.purchaseFrequencyTrend}
- Engagement score (0-1): ${context.engagementScore}
- Top category affinity: ${context.topCategoryAffinity}
- Predicted lifetime value: ${context.predictedLifetimeValue}
- Last purchased product: ${context.lastPurchasedProduct ?? "unknown"}`;

  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: prompt }] }];

  const { parts } = await runSearchToolLoop(
    contents,
    "Before recommending any product, call search_products to confirm it actually exists in " +
      "the catalog and is available. Never invent product handles.",
    2,
  );
  if (parts.length) {
    contents.push({ role: "model", parts });
  }

  contents.push({
    role: "user",
    parts: [
      {
        text:
          "Based on the conversation above, respond with the final decision as JSON. Only include " +
          "product handles that came back from a search_products result above — if none fit, use an empty array.",
      },
    ],
  });

  const finalData = await generateContent({
    contents,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          worthContacting: { type: "boolean" },
          channel: { type: "string", enum: ["sms", "email"] },
          openingMessage: { type: "string" },
          recommendedProductHandles: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["worthContacting", "channel", "openingMessage", "recommendedProductHandles", "reason"],
      },
    },
  });

  const text = finalData.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!text) {
    throw new Error("Gemini returned no decision content");
  }
  return JSON.parse(text) as OutreachDecision;
}

export interface ChatReplyResult {
  reply: string;
  products: ProductSummary[];
}

/** Step 4: one turn of the shopping conversation, grounded in real Shopify data via tool-calling. */
export async function chatReply(session: ChatSession, latestMessage: string): Promise<ChatReplyResult> {
  if (!config.google.geminiApiKey) {
    return { reply: `[gemini:stub] (would answer: "${latestMessage}")`, products: [] };
  }

  const contents: GeminiContent[] = session.history.map((turn) => ({
    role: turn.role === "customer" ? "user" : "model",
    parts: [{ text: turn.message }],
  }));

  const { parts, products } = await runSearchToolLoop(
    contents,
    "You are a shopping assistant. Ground every product, price, or availability claim in the " +
      "search_products tool — never invent catalog data.",
  );

  const text = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n");

  return { reply: text || "Sorry, I'm having trouble with that — could you try rephrasing?", products };
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
