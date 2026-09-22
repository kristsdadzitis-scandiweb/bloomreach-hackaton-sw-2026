import { config } from "../config.js";
import type { ChatSession } from "../types.js";
import { searchProducts, type ProductSummary } from "./shopify.js";

/**
 * Gemini is the reasoning layer for the proactive shopping assistant: it
 * decides when to ground itself in real Shopify data via tool-calling,
 * reasons about complementary products, and suggests quick-reply chips.
 */

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
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
        "Search the Shopify catalog for products matching a natural-language query. Call this " +
        "before mentioning or recommending any product, price, or availability — never guess. " +
        "Call it more than once in a turn when building an outfit or bundle (e.g. once for a " +
        "shirt, again for matching shorts) to ground each complementary suggestion separately.",
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
  maxSteps = 6,
): Promise<{ parts: GeminiPart[]; products: ProductSummary[] }> {
  const products: ProductSummary[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const lastStep = step === maxSteps - 1;
    const data = await generateContent({
      contents,
      // Withhold the tool on the last step so the model is forced to answer
      // in text instead of exhausting the budget on another function call.
      ...(lastStep ? {} : { tools: [SEARCH_PRODUCTS_TOOL] }),
      systemInstruction: { parts: [{ text: systemPrompt }] },
    });

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    // The model can call the tool more than once in the same turn (e.g. one
    // search per item in an outfit) — every functionCall needs a matching
    // functionResponse, paired by id, or the conversation state corrupts.
    const functionCallParts = parts.filter((p) => p.functionCall);

    if (functionCallParts.length === 0) {
      return { parts, products };
    }

    contents.push({ role: "model", parts });

    const responseParts: GeminiPart[] = [];
    for (const part of functionCallParts) {
      const { id, name, args } = part.functionCall!;
      const result = name === "search_products" ? await searchProducts(String(args.query ?? "")) : { error: `unknown tool ${name}` };
      if (name === "search_products") {
        products.push(...(result as ProductSummary[]));
      }
      responseParts.push({ functionResponse: { id, name, response: { result } } });
    }

    contents.push({ role: "function", parts: responseParts });
  }

  return { parts: [], products };
}

const QUICK_REPLIES_SCHEMA = {
  type: "object",
  properties: {
    quickReplies: {
      type: "array",
      items: { type: "string" },
      description: "2-4 short (under 5 words) suggested replies the customer could tap next.",
    },
  },
  required: ["quickReplies"],
};

async function suggestQuickReplies(contents: GeminiContent[], lastReply: string): Promise<string[]> {
  const data = await generateContent({
    contents: [
      ...contents,
      { role: "model", parts: [{ text: lastReply }] },
      {
        role: "user",
        parts: [
          {
            text:
              "Based on the conversation above, suggest 2-4 short quick-reply options the " +
              "customer could tap next (e.g. asking about sizes/colors, browsing a category, " +
              "'show more'). Only name a specific product if it appeared in a search_products " +
              "result above. Never suggest 'add to cart' or checkout actions — the customer " +
              "does those from the product card's own button, not by typing.",
          },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json", responseSchema: QUICK_REPLIES_SCHEMA },
  });

  const text = data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!text) return [];
  try {
    return (JSON.parse(text) as { quickReplies: string[] }).quickReplies ?? [];
  } catch {
    return [];
  }
}

export interface ChatReplyResult {
  reply: string;
  products: ProductSummary[];
  quickReplies: string[];
}

const SYSTEM_PROMPT =
  "You are a proactive on-site shopping assistant. Ground every product, price, or " +
  "availability claim in the search_products tool — never invent catalog data, and never " +
  "mention a product you haven't just searched for. When a customer is building an outfit " +
  "or bundle, suggest complementary items (e.g. a shirt and matching shorts) by searching " +
  "for each piece separately. Keep replies short and conversational, suited to a chat " +
  "widget. You cannot create a cart or checkout yourself and have no access to the " +
  "customer's cart or checkout URL — each product you show appears as a card with its own " +
  "'Add to cart' button, which is how the customer actually buys. If asked to check out or " +
  "for a checkout link, tell them to click 'Add to cart' on the item they want.";

/** One turn of the shopping conversation, grounded in real Shopify data via tool-calling. */
export async function chatReply(session: ChatSession, latestMessage: string): Promise<ChatReplyResult> {
  if (!config.google.geminiApiKey) {
    return {
      reply: `[gemini:stub] (would answer: "${latestMessage}")`,
      products: [],
      quickReplies: [],
    };
  }

  const contents: GeminiContent[] = session.history.map((turn) => ({
    role: turn.role === "customer" ? "user" : "model",
    parts: [{ text: turn.message }],
  }));

  const { parts, products } = await runSearchToolLoop(contents, SYSTEM_PROMPT);

  const text = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n");
  const reply = text || "Sorry, I'm having trouble with that — could you try rephrasing?";

  const quickReplies = await suggestQuickReplies(contents, reply);

  return { reply, products, quickReplies };
}
