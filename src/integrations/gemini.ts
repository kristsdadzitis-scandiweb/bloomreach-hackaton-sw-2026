import { config } from "../config.js";
import type { ChatSession } from "../types.js";
import { searchProducts, listProductTypes, type ProductSummary } from "./shopify.js";

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
        "Search the Shopify catalog. This is LITERAL KEYWORD MATCHING against each product's " +
        "title, type, and tags — not a semantic or attribute filter. It has no concept of price " +
        "tier, quality, or fit for purpose. Call this before mentioning or recommending any " +
        "product, price, or availability — never guess. " +
        "Query construction: use only concrete words likely to appear verbatim in a real " +
        "product's title or type — a category ('snowboard', 'shirt'), a color, a material. Drop " +
        "subjective or comparative words ('cheap', 'best', 'warm', 'durable', 'good for " +
        "beginners', 'most popular color') from the query itself — they won't match anything " +
        "literally and will waste the search. Instead, search on the plain category/item alone, " +
        "then reason over the returned prices/titles/details yourself to answer the actual " +
        "question (e.g. compare the returned prices to find 'the cheapest one'). " +
        "For 'bestsellers'/'popular'/'trending'/'what do you recommend', pass an empty query — " +
        "it returns real sales-ranked catalog picks (this is the one case where a vague ask " +
        "maps directly to a real, non-literal sort, so it's fine as the query itself). " +
        "Call it more than once in a turn when building an outfit or bundle (e.g. once for a " +
        "shirt, again for matching shorts) to ground each complementary suggestion separately. " +
        "It never returns an empty list while the catalog has any stock: a query with no " +
        "literal matches still returns other in-stock items as a fallback — treat those as " +
        "'here's what we do have' suggestions, not a match for the original request.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Literal keyword(s) likely to appear in a real product's title/type — a category, " +
              "color, or material. Never a subjective or comparative word like 'cheap' or 'best'.",
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
  const knownCategories = await listProductTypes().catch(() => [] as string[]);
  const categoryLine = knownCategories.length
    ? `The store's actual categories are: ${knownCategories.join(", ")}. Only name a category ` +
      "from this exact list — never invent or guess one (e.g. don't suggest 'shoes' unless " +
      "it's literally in this list). "
    : "";

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
              "result above. " +
              categoryLine +
              "Never suggest 'add to cart' or checkout actions — the customer " +
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
  "for a checkout link, tell them to click 'Add to cart' on the item they want. " +
  "search_products never truly returns nothing — if the exact item asked for isn't there, " +
  "it hands back other in-stock products instead. Never conclude or claim the store lacks a " +
  "whole category based on one search; just say the specific item wasn't found and pivot to " +
  "what the results actually show. Don't apologize for or reference earlier turns being wrong " +
  "— just give the current, correct answer. " +
  "Before calling search_products, think about what's actually a literal keyword versus your " +
  "own judgment call — the tool matches text, it doesn't understand comparisons, quality, or " +
  "fit for purpose. Search on the concrete noun (a category, color, material), then apply the " +
  "comparison or judgment yourself over the results it returns (e.g. compare their real prices " +
  "to answer 'which is cheapest', or use their titles/types to judge 'which suits a beginner'). " +
  "Never let an unrelated fallback result stand in for something you actually reasoned about.";

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

  const pageContext = session.currentProduct
    ? `\n\nThe customer is currently on the product page for "${session.currentProduct.title}" ` +
      `(${session.currentProduct.priceRange}${session.currentProduct.available ? "" : ", out of stock"}). ` +
      "If they use a pronoun like 'this' or 'it' without naming a product, assume they mean this one."
    : "";

  const { parts, products } = await runSearchToolLoop(contents, SYSTEM_PROMPT + pageContext);

  const text = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n");
  const reply = text || "Sorry, I'm having trouble with that — could you try rephrasing?";

  const quickReplies = await suggestQuickReplies(contents, reply);

  return { reply, products, quickReplies };
}
