import { config } from "../config.js";
import type { ChatSession, MiaCandidate, MiaResponse } from "../types.js";
import { searchCatalog, checkStock, addToCart, getCart, resolveVariantIdBySku, type SearchCatalogFilters } from "./shopify.js";
import { getCustomerProfile, recordEvent } from "./bloomreach.js";
import type { SignalCase } from "../services/signals.js";
import { enforceGuardrails, type GroundTruth } from "../services/guardrails.js";

/**
 * Gemini is Mia's reasoning layer: a tool-calling loop grounds every fact in
 * real Shopify/Bloomreach data (phase A), then a separate structured-output
 * call shapes the decision/reply/write_back JSON (phase B) — Gemini's API
 * doesn't allow `tools` and `responseSchema` in the same call, confirmed in
 * this codebase, so the two-phase split is load-bearing, not a style choice.
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

// --- Tool declarations (the six from the playbook) ---

const MIA_TOOLS = {
  functionDeclarations: [
    {
      name: "get_customer_context",
      description:
        "Returns this customer's real known profile (from a live Bloomreach read — first_name, " +
        "usual sizes, order history, segment, consent, open_support_case) plus this session's own " +
        "behavior. Most of this is already in the context block below; call this only if you need " +
        "to double-check something the context block doesn't cover. Never treat a missing field as " +
        "a fact you can guess — it means genuinely unknown.",
      parameters: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] },
    },
    {
      name: "search_catalog",
      description:
        "Searches the real Northbound catalog and returns up to 8 products, each with real sizes " +
        "in stock, fit note, waterproofing, weight, layer, and pairs_with. Call this before " +
        "mentioning or recommending any product, price, or availability — never guess or invent " +
        "one. Pass pairs_with (a product id) to find real complements for that specific product " +
        "instead of a general search.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "A literal category, e.g. 'jacket', 'footwear', 'baselayer'." },
          waterproof_min: { type: "string", enum: ["none", "water-repellent", "10k", "20k", "28k"] },
          max_price: { type: "number" },
          max_weight_g: { type: "number" },
          size: { type: "string" },
          layer: { type: "string", enum: ["base", "mid", "shell", "bottom", "footwear", "accessory"] },
          pairs_with: { type: "string", description: "Product id to find real complements for." },
        },
      },
    },
    {
      name: "check_stock",
      description: "Live per-size stock counts for the given SKUs, from Shopify. Call before showing any size.",
      parameters: {
        type: "object",
        properties: { skus: { type: "array", items: { type: "string" } } },
        required: ["skus"],
      },
    },
    {
      name: "create_cart",
      description: "Creates or updates the real Shopify cart for this shopper and returns cart id, lines, and totals.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sku: { type: "string" },
                size: { type: "string" },
                qty: { type: "integer" },
              },
              required: ["sku", "qty"],
            },
          },
        },
        required: ["items"],
      },
    },
    {
      name: "get_checkout",
      description:
        "Returns the real Shopify checkout for the current cart: URL, and current totals. There is " +
        "no in-chat payment in this build — checkout always happens on the real Shopify checkout page.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      name: "log_event",
      description:
        "Writes a real event to the Bloomreach customer profile. Use for chat_open, chat_decision, " +
        "chat_outcome, or any attribute you've just learned in conversation (e.g. a corrected size).",
      parameters: {
        type: "object",
        properties: {
          event: { type: "string" },
          properties: { type: "object" },
        },
        required: ["event", "properties"],
      },
    },
  ],
};

export interface ToolLoopResult {
  parts: GeminiPart[];
  candidates: MiaCandidate[];
  stockBySku: Record<string, Record<string, number>>;
  cartValue: number;
  cartNonEmpty: boolean;
  checkoutUrl?: string;
}

/**
 * Phase A — the tool-calling loop. Accumulates real ground truth as it goes
 * (candidates, per-SKU stock, cart state) for the guardrail layer to check
 * phase B's output against later, not just for the transcript.
 */
async function runMiaToolLoop(
  contents: GeminiContent[],
  systemPrompt: string,
  session: ChatSession,
  maxSteps = 6,
): Promise<ToolLoopResult> {
  const candidates: MiaCandidate[] = [];
  const stockBySku: Record<string, Record<string, number>> = {};
  let cartValue = 0;
  let cartNonEmpty = Boolean(session.cartId);
  let checkoutUrl: string | undefined;

  for (let step = 0; step < maxSteps; step++) {
    const lastStep = step === maxSteps - 1;
    const data = await generateContent({
      contents,
      ...(lastStep ? {} : { tools: [MIA_TOOLS] }),
      systemInstruction: { parts: [{ text: systemPrompt }] },
    });

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const functionCallParts = parts.filter((p) => p.functionCall);
    if (functionCallParts.length === 0) {
      return { parts, candidates, stockBySku, cartValue, cartNonEmpty, checkoutUrl };
    }

    contents.push({ role: "model", parts });

    const responseParts: GeminiPart[] = [];
    for (const part of functionCallParts) {
      const { id, name, args } = part.functionCall!;
      let result: unknown;

      switch (name) {
        case "get_customer_context": {
          const profile = session.profile ?? (await getCustomerProfile(session.customerId).catch(() => undefined));
          result = { profile: profile ?? null, behavior: session.behavior };
          break;
        }
        case "search_catalog": {
          const filters: SearchCatalogFilters = {
            category: args.category as string | undefined,
            waterproofMin: args.waterproof_min as string | undefined,
            maxPrice: args.max_price as number | undefined,
            maxWeightG: args.max_weight_g as number | undefined,
            size: args.size as string | undefined,
            layer: args.layer as SearchCatalogFilters["layer"],
            pairsWith: args.pairs_with as string | undefined,
          };
          const found = await searchCatalog(filters);
          candidates.push(...found);
          result = found;
          break;
        }
        case "check_stock": {
          const skus = (args.skus as string[]) ?? [];
          const stock = await checkStock(skus);
          Object.assign(stockBySku, stock);
          result = stock;
          break;
        }
        case "create_cart": {
          const items = (args.items as Array<{ sku: string; size?: string; qty: number }>) ?? [];
          const lineItems = await Promise.all(
            items.map(async (item) => {
              const variantId = await resolveVariantIdBySku(item.sku);
              return variantId ? { variantId, quantity: item.qty } : null;
            }),
          );
          const validLineItems = lineItems.filter((li): li is { variantId: string; quantity: number } => li !== null);
          if (validLineItems.length > 0) {
            const cart = await addToCart(session.cartId, validLineItems, session.customerAccessToken);
            session.cartId = cart.cartId;
            cartNonEmpty = cart.totalQuantity > 0;
            checkoutUrl = cart.checkoutUrl;
            result = cart;
          } else {
            result = { error: "no valid SKUs resolved to a real variant" };
          }
          break;
        }
        case "get_checkout": {
          const cart = session.cartId ? await getCart(session.cartId) : null;
          if (cart) {
            checkoutUrl = cart.checkoutUrl;
            cartValue = 0; // Shopify's cart totalAmount isn't fetched by getCart today — see CLAUDE.md open item.
            cartNonEmpty = cart.totalQuantity > 0;
          }
          result = cart ?? { error: "no cart yet" };
          break;
        }
        case "log_event": {
          await recordEvent(session.customerId, String(args.event ?? "chat_event"), (args.properties as Record<string, unknown>) ?? {});
          result = { success: true };
          break;
        }
        default:
          result = { error: `unknown tool ${name}` };
      }

      responseParts.push({ functionResponse: { id, name, response: { result } } });
    }

    contents.push({ role: "function", parts: responseParts });
  }

  return { parts: [], candidates, stockBySku, cartValue, cartNonEmpty, checkoutUrl };
}

// --- Phase B: structured decision/reply/write_back ---

const MIA_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open_chat", "stay_closed", "continue"] },
        readAs: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        rejected: {
          type: "array",
          items: { type: "object", properties: { reading: { type: "string" }, why: { type: "string" } }, required: ["reading", "why"] },
        },
        offer: {
          type: "object",
          properties: { type: { type: "string", enum: ["none", "free_shipping"] }, why: { type: "string" } },
          required: ["type", "why"],
        },
      },
      required: ["action", "readAs", "confidence", "rejected", "offer"],
    },
    reply: {
      type: "object",
      properties: {
        text: { type: "string" },
        show: { type: "array", items: { type: "string" } },
        recommendSizes: { type: "object" },
        addToCart: {
          type: "array",
          items: { type: "object", properties: { sku: { type: "string" }, size: { type: "string" }, qty: { type: "integer" } }, required: ["sku", "size", "qty"] },
        },
        openCheckout: { type: "boolean" },
        chips: { type: "array", items: { type: "string" } },
      },
      required: ["text", "show", "recommendSizes", "addToCart", "openCheckout", "chips"],
    },
    writeBack: {
      type: "object",
      properties: { event: { type: "string" }, properties: { type: "object" } },
      required: ["event", "properties"],
    },
  },
  required: ["decision", "reply", "writeBack"],
};

function buildContextBlock(session: ChatSession, signalCase: SignalCase, candidates: MiaCandidate[]): string {
  const block = {
    IDENTITY: session.identityTier,
    PROFILE: session.profile ?? null,
    SESSION: {
      device: session.behavior.device,
      pageType: session.behavior.pageType,
      category: session.behavior.category,
      productsViewed: session.behavior.productsViewed,
      filters: session.behavior.filters,
      sort: session.behavior.sort,
      sizeGuideOpens: session.behavior.sizeGuideOpens,
      cartLastModifiedAt: session.behavior.cartLastModifiedAt,
      checkoutStep: session.behavior.checkoutStep,
    },
    SIGNAL_CASE: signalCase,
    CANDIDATES: candidates,
    OPPORTUNITY_USED_THIS_SESSION: session.behavior.opportunityUsedThisSession,
    // CHAT_HISTORY isn't duplicated here — it's the surrounding `contents`
    // transcript itself, already sent alongside this context block.
  };
  return `CONTEXT BLOCK:\n${JSON.stringify(block, null, 2)}`;
}

async function produceMiaResponse(contents: GeminiContent[], systemPrompt: string, contextBlock: string): Promise<MiaResponse> {
  const data = await generateContent({
    contents: [...contents, { role: "user", parts: [{ text: contextBlock }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { responseMimeType: "application/json", responseSchema: MIA_RESPONSE_SCHEMA },
  });

  const text = data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!text) {
    return {
      decision: { action: "stay_closed", readAs: "no structured response returned", confidence: "low", rejected: [], offer: { type: "none", why: "" } },
      reply: { text: "", show: [], recommendSizes: {}, addToCart: [], openCheckout: false, chips: [] },
      writeBack: { event: "chat_decision", properties: { error: "empty_response" } },
    };
  }
  return JSON.parse(text) as MiaResponse;
}

// --- The playbook's verbatim system instruction ---

const SYSTEM_PROMPT = `You are Mia, the shopping assistant for Northbound, an outdoor store for autumn hiking and trail running. You appear inside the store's own website, next to the page the shopper is on. You are the equivalent of a good floor assistant: you notice, you ask one thing, you answer with facts, and you leave people alone when they do not need you.

WHO YOU ARE TALKING TO
The context block tells you the identity level:
- anonymous: you know only this session. Ask rather than assume. Never pretend to know their size, history or name.
- known: you have the profile. Use it. Do not ask what you already know. Reference past purchases by name when relevant.
- just_signed_in: they were anonymous a moment ago. Acknowledge once, by first name, say what changed because you now know them, then continue. Do not repeat the acknowledgement.

HOW YOU DECIDE
The context block contains a signal case: the events that fired, the trigger name, and any other readings that were also true. You decide whether to speak at all. Return action "open_chat" only when something is genuinely blocking a purchase the shopper already intends, or when a commitment has just been made and one specific complement or correction helps. Return "stay_closed" when the evidence is thin, when the shopper is simply browsing, when they are mid-payment, or when interrupting would cost more than it gains. Always list the readings you rejected and why. A rule opens the question. You make the decision.

HOW YOU SPEAK
- One question per message. Never two.
- Short. A message is one to three sentences. No lists, no headers, no emoji.
- Refer to what the shopper just did, specifically. "Going back and forth between the Aurora and the Summit?" not "I see you are browsing jackets".
- Name the fit note or the attribute that matters before recommending.
- Never more than four of your messages before a cart is offered, if the shopper is engaging.
- When a shopper says they are just browsing, or asks you to stop, close warmly in one sentence and do not reopen.

FACTS
Every product fact comes from a tool result: name, price, sizes, stock, waterproofing, weight, fit. If you have not called the tool, you do not know it. Never invent a product, a price, a stock level or a delivery date. If a tool fails, say you cannot check right now and offer to continue without that fact.

OFFERS
No discounts. Not when asked, not when the shopper hesitates, not when a competitor is mentioned. The only concession you may mention is free delivery over the threshold, and only when the cart is within 15 euros of it. If a shopper insists on a code, say there is none and say what is genuinely available.

RECOMMENDING
Products shown come from search_catalog, which is ranked by the store's recommendation engine. You choose the criterion (weather, weight, warmth, price, fit) from what the shopper said; you do not reorder the engine's ranking. Show at most three. Always check stock before showing a size. Never show a size with zero stock. For complements, use pairs_with from the catalog and keep the complement at or under about 40 percent of the anchor item's price.

OPPORTUNITIES
Cross-sell only after a commitment: an item added, a decision voiced, an order placed. Never while the shopper is still choosing. One opportunity per session, at most two items. A trade-up must name what it costs the shopper in price or weight. If they decline once, do not raise it again.

WHEN TO HAND OFF
Complaints, order problems, returns in progress, anything about a past order going wrong: say you will pass it to a person, log it, and stop selling. Do not attempt to fix service issues.

SCOPE
Questions outside shopping at Northbound get one friendly redirect. Do not answer them.

OUTPUT
Reply with one JSON object matching the response schema and nothing else. The "text" field is what the shopper reads. Everything else is for the page and the profile.`;

export interface MiaTurnResult {
  response: MiaResponse;
  ground: GroundTruth;
}

/** One turn of the Mia conversation. `latestMessage` is undefined for a proactive, signal-driven turn. */
export async function chatWithMia(session: ChatSession, latestMessage: string | undefined, signalCase: SignalCase): Promise<MiaTurnResult> {
  if (!config.google.geminiApiKey) {
    const stub: MiaResponse = {
      decision: { action: "stay_closed", readAs: "stub mode, no Gemini key configured", confidence: "low", rejected: [], offer: { type: "none", why: "" } },
      reply: { text: `[gemini:stub] (would answer: "${latestMessage ?? "(proactive check)"}")`, show: [], recommendSizes: {}, addToCart: [], openCheckout: false, chips: [] },
      writeBack: { event: "chat_decision", properties: { stub: true } },
    };
    return { response: stub, ground: { candidates: [], cartNonEmpty: false, cartValue: 0, freeShippingThreshold: 0 } };
  }

  const contents: GeminiContent[] = session.history.map((turn) => ({
    role: turn.role === "customer" ? "user" : "model",
    parts: [{ text: turn.message }],
  }));
  if (latestMessage) {
    contents.push({ role: "user", parts: [{ text: latestMessage }] });
  }

  const toolResult = await runMiaToolLoop(contents, SYSTEM_PROMPT, session);
  const contextBlock = buildContextBlock(session, signalCase, toolResult.candidates);
  const response = await produceMiaResponse(contents, SYSTEM_PROMPT, contextBlock);

  const ground: GroundTruth = {
    candidates: toolResult.candidates,
    cartNonEmpty: toolResult.cartNonEmpty,
    cartValue: toolResult.cartValue,
    freeShippingThreshold: 99,
  };

  const { safe } = enforceGuardrails(response, ground);
  return { response: safe, ground };
}
