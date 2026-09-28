import { config } from "../config.js";
import type { ChatSession, MiaCandidate, MiaResponse, ClientReportedCart, CustomerProfile } from "../types.js";
import {
  searchCatalog,
  checkStock,
  getCandidateByHandle,
  resolveVariantIdBySku,
  type SearchCatalogFilters,
} from "./shopify.js";
import { getCustomerProfile, recordEvent, updateCustomerProfile } from "./bloomreach.js";
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

// Observed a genuine, successful (non-retried) call take ~24s under real
// Gemini load today — 20s would have aborted a call that was about to
// succeed. 45s still leaves comfortable room for several calls plus a retry
// within Cloud Run's 300s request limit, while still recovering from a truly
// stuck connection well before that limit.
const GEMINI_CALL_TIMEOUT_MS = 45_000;

/**
 * Without an explicit timeout, a stalled Gemini call hangs until Cloud Run's
 * own 300s request timeout kills it — and since runMiaTurn serializes every
 * turn per session (runExclusive), one stuck call jams every later request
 * for that session behind it, each also burning a full 5 minutes before
 * dying. Confirmed live: a real burst of "maximum request timeout" errors on
 * /signal-check, all traced back to this. Failing fast here lets the lock
 * queue keep moving and gives the caller a real error instead of a hang.
 */
async function generateContentOnce(body: Record<string, unknown>): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.google.geminiModel}:generateContent?key=${config.google.geminiApiKey}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_CALL_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Gemini API call timed out after ${GEMINI_CALL_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API error: ${JSON.stringify(data)}`);
  }
  return data as GeminiResponse;
}

/**
 * Confirmed live: Gemini genuinely returns transient failures under real
 * load — a clean 503 ("This model is currently experiencing high demand...
 * Please try again later" — literally its own advice) and, separately, a raw
 * `TypeError: fetch failed` network error. Both are real, temporary,
 * upstream conditions, not bugs in this code, and both usually clear within
 * a second or two — one retry is cheap insurance against surfacing a broken
 * turn (or an empty chat panel) for something that would have worked a
 * moment later.
 */
async function generateContent(body: Record<string, unknown>): Promise<GeminiResponse> {
  try {
    return await generateContentOnce(body);
  } catch (err) {
    const isTransient =
      err instanceof TypeError || (err instanceof Error && /"code":503|UNAVAILABLE|timed out/.test(err.message));
    if (!isTransient) throw err;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return generateContentOnce(body);
  }
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
        "Writes a real, one-off event to the shopper's Bloomreach history. Use for chat_open, " +
        "chat_decision, chat_outcome, and anything else that happened once, this conversation. This " +
        "only records that something happened — it does NOT change what get_customer_context reads " +
        "back next session. If the shopper corrected or revealed something that should still be true " +
        "later (their usual size, their main category, a consent change), call " +
        "update_customer_profile instead, or in addition.",
      parameters: {
        type: "object",
        properties: {
          event: { type: "string" },
          properties: { type: "object" },
        },
        required: ["event", "properties"],
      },
    },
    {
      name: "update_customer_profile",
      description:
        "Updates a durable field on the shopper's real Bloomreach profile — the one get_customer_context " +
        "reads from, this session and every future one. Use this whenever the shopper corrects or " +
        "reveals a lasting fact about themselves: their usual top or shoe size, their main category of " +
        "interest, or a consent change. Only pass the fields that genuinely changed; never guess the " +
        "others. Sizes must be converted to the store's own vocabulary — the same letters/numbers the " +
        "catalog itself uses, never the shopper's own wording (\"a medium\" is \"M\", \"a nine\" is \"9\"). " +
        "This is different from log_event, which only logs that something happened without changing " +
        "what is known about them going forward.",
      parameters: {
        type: "object",
        properties: {
          usual_size_top: { type: "string", enum: ["S", "M", "L", "XL"] },
          usual_size_shoe: { type: "string", enum: ["7", "8", "9", "10", "11", "12"] },
          top_category: { type: "string" },
          consent: { type: "boolean" },
        },
      },
    },
  ],
};

/**
 * One real attempted Bloomreach write this turn — the log_event tool call
 * and the phase B writeBack are the two sources, tracked identically so the
 * admin panel can show both together. `failed` matters: every call site
 * previously swallowed a Bloomreach error with a bare `.catch(() => {})`, so
 * "the log shows nothing" and "it silently failed" looked identical from the
 * admin panel — this makes a real failure visible instead of indistinguishable
 * from "nothing was written this turn."
 */
export interface BloomreachWriteLog {
  source: "log_event" | "write_back" | "update_customer_profile";
  event: string;
  properties: Record<string, unknown>;
  failed: boolean;
  error?: string;
}

export interface ToolLoopResult {
  parts: GeminiPart[];
  candidates: MiaCandidate[];
  stockBySku: Record<string, Record<string, number>>;
  cartValue: number;
  cartNonEmpty: boolean;
  checkoutUrl?: string;
  /**
   * Real variant ids create_cart resolved this turn, for the widget to
   * actually add via the theme's own native `/cart/add.js` — the backend has
   * no browser session to add to that cart itself. Always empty for a
   * proactive turn (Mia never adds to cart on her own initiative).
   */
  pendingCartAdds: Array<{ variantId: string; quantity: number }>;
  /** Every real log_event tool call made during this turn's tool loop. Always empty for a proactive turn (no tool loop runs at all). */
  bloomreachWrites: BloomreachWriteLog[];
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
  let cartValue = session.cart?.totalAmount ?? 0;
  let cartNonEmpty = (session.cart?.totalQuantity ?? 0) > 0;
  let checkoutUrl: string | undefined;
  const pendingCartAdds: Array<{ variantId: string; quantity: number }> = [];
  const bloomreachWrites: BloomreachWriteLog[] = [];

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
      return { parts, candidates, stockBySku, cartValue, cartNonEmpty, checkoutUrl, pendingCartAdds, bloomreachWrites };
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
          // The backend has no browser session into the shopper's real
          // (native) cart, so it can't add to it directly the way it used to
          // add to its own Storefront-API cart — it only resolves real SKUs
          // to real variant ids here (still genuine ground truth, never
          // fabricated) and hands them to the widget as pendingCartAdds,
          // which performs the actual add via the theme's own
          // `/cart/add.js` after this turn completes, then reports the
          // result back. See CLAUDE.md's "Native cart switch".
          const items = (args.items as Array<{ sku: string; size?: string; qty: number }>) ?? [];
          const resolved = await Promise.all(
            items.map(async (item) => {
              const variantId = await resolveVariantIdBySku(item.sku);
              return variantId ? { variantId, quantity: item.qty } : null;
            }),
          );
          const validItems = resolved.filter((li): li is { variantId: string; quantity: number } => li !== null);
          if (validItems.length > 0) {
            pendingCartAdds.push(...validItems);
            cartNonEmpty = true;
            result = { pending: validItems, note: "will be added to the shopper's real cart once this turn is sent to them" };
          } else {
            result = { error: "no valid SKUs resolved to a real variant" };
          }
          break;
        }
        case "get_checkout": {
          // Real cart state, but sourced from what the widget already
          // reported (session.cart) rather than a fresh Shopify fetch — the
          // backend has no session into the shopper's native cart to fetch
          // from directly. checkoutUrl is the theme's own real checkout
          // entry point, not a per-cart URL, since there's no separate
          // Storefront-API cart object to link to anymore.
          if (session.cart) {
            checkoutUrl = "/checkout";
            cartValue = session.cart.totalAmount;
            cartNonEmpty = session.cart.totalQuantity > 0;
          }
          result = session.cart ?? { error: "no cart yet" };
          break;
        }
        case "log_event": {
          const event = String(args.event ?? "chat_event");
          const properties = (args.properties as Record<string, unknown>) ?? {};
          try {
            await recordEvent(session.customerId, event, properties);
            bloomreachWrites.push({ source: "log_event", event, properties, failed: false });
            result = { success: true };
          } catch (err) {
            bloomreachWrites.push({ source: "log_event", event, properties, failed: true, error: err instanceof Error ? err.message : String(err) });
            result = { success: false, error: "Bloomreach write failed" };
          }
          break;
        }
        case "update_customer_profile": {
          // A real, durable write — writeCustomerProperties, not trackEvent —
          // so this actually changes what a future getCustomerProfile read
          // returns, unlike log_event above. session.profile is also updated
          // in-memory immediately so the rest of *this* conversation reflects
          // the correction without waiting on a fresh Bloomreach round trip.
          const patch: Partial<CustomerProfile> = {};
          if (typeof args.usual_size_top === "string") patch.usualSizeTop = args.usual_size_top;
          if (typeof args.usual_size_shoe === "string") patch.usualSizeShoe = args.usual_size_shoe;
          if (typeof args.top_category === "string") patch.topCategory = args.top_category;
          if (typeof args.consent === "boolean") patch.consent = args.consent;

          if (Object.keys(patch).length === 0) {
            result = { error: "no valid profile fields provided" };
            break;
          }
          try {
            await updateCustomerProfile(session.customerId, patch);
            session.profile = { ...session.profile, ...patch };
            bloomreachWrites.push({ source: "update_customer_profile", event: "update_customer_profile", properties: patch, failed: false });
            result = { success: true, profile: session.profile };
          } catch (err) {
            bloomreachWrites.push({
              source: "update_customer_profile",
              event: "update_customer_profile",
              properties: patch,
              failed: true,
              error: err instanceof Error ? err.message : String(err),
            });
            result = { success: false, error: "Bloomreach profile write failed" };
          }
          break;
        }
        default:
          result = { error: `unknown tool ${name}` };
      }

      responseParts.push({ functionResponse: { id, name, response: { result } } });
    }

    contents.push({ role: "function", parts: responseParts });
  }

  return { parts: [], candidates, stockBySku, cartValue, cartNonEmpty, checkoutUrl, pendingCartAdds, bloomreachWrites };
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
      // The real product the customer's current page is showing, if any —
      // resolve pronouns ("this", "it") to this without asking, per the
      // playbook's own identity rules on using what you already know.
      pageProduct: session.currentProduct ?? null,
      productsViewed: session.behavior.productsViewed,
      filters: session.behavior.filters,
      sort: session.behavior.sort,
      sizeGuideOpens: session.behavior.sizeGuideOpens,
      cartLastModifiedAt: session.behavior.cartLastModifiedAt,
      checkoutStep: session.behavior.checkoutStep,
    },
    // The shopper's real, resolved cart (see ClientReportedCart) — real
    // Shopify product titles/quantities/totals, not something to re-derive
    // or treat as unverified. This was missing entirely until found live:
    // cart_left_behind kept declining with readAs like "without knowing the
    // cart contents, there is no specific blocker to address" — Gemini had
    // genuinely never been shown what was in the cart, only the generic
    // idle-time evidence in SIGNAL_CASE. null means genuinely empty/unknown,
    // never omit real cart data to keep the block small.
    CART: session.cart ?? null,
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
- If the shopper corrects or reveals something durable about themselves — their usual size, their main category, a consent change — call update_customer_profile so it is still true next session. log_event alone only records that it happened; it does not change what you, or a future session, will know about them.

HOW YOU DECIDE
The context block contains a signal case: the events that fired, the trigger name, and any other readings that were also true. You decide whether to speak at all. Return action "open_chat" only when something is genuinely blocking a purchase the shopper already intends, when a commitment has just been made and one specific complement or correction helps, when the shopper is genuinely stalled comparing several similar options and naming the one criterion that actually differs would resolve it, or when the signal case is cart_left_behind: the cart was modified and has sat idle past the threshold with checkout never started. That idle cart is itself the genuine signal, even if the shopper has since moved on to browsing something else — moving on is not evidence they lost interest in what is already in the cart, and is never a reason to treat a cart_left_behind signal case as "just browsing." Return "stay_closed" when the evidence is thin, when the shopper is simply browsing with nothing in the cart, when they are mid-payment, or when interrupting would cost more than it gains. Always list the readings you rejected and why. A rule opens the question. You make the decision.

HOW YOU SPEAK
- One question per message. Never two.
- Short. A message is one to three sentences. No lists, no headers, no emoji.
- Refer to what the shopper just did, specifically. "Going back and forth between the Aurora and the Summit?" not "I see you are browsing jackets".
- Name the fit note or the attribute that matters before recommending.
- Do not drag the conversation out. Get to a concrete product suggestion (a shown product, a recommended size, or a named complement) within your first two messages — do not spend messages on pleasantries or repeated clarifying questions before naming something concrete. The one exception is a genuine sizing or fit conversation (size_guide_reopened, or discussing what layer or fleece goes underneath) — there, working through fit first before landing on a size is expected, not stalling.
- Never more than four of your messages before a cart is offered, if the shopper is engaging.
- When a shopper says they are just browsing, or asks you to stop, close warmly in one sentence and do not reopen.
- Whenever your message asks a question, chips must offer 2-4 concrete answers to that exact question — never leave chips empty when you have just asked something. If you asked which size they wear, chips are that product's real available sizes (call check_stock first if you have not already); if you asked yes/no, chips are the two real answers; never a generic filler chip unrelated to what you just asked.

FACTS
Every product fact comes from a tool result, or from CART/CANDIDATES/pageProduct in the context block below — both are real, already-verified Shopify data, not something to re-check or treat as less certain than a tool call. If a fact is in neither place, you do not know it. Never invent a product, a price, a stock level or a delivery date. If a tool fails, say you cannot check right now and offer to continue without that fact. CART specifically holds the shopper's real current cart lines (title, variant, quantity, line total) — when speaking to a cart_left_behind signal case, name the actual item(s) from CART.lines; do not say you do not know what is in the cart when CART is populated.
Never tell the shopper something was added to their cart unless you called create_cart this turn and it returned real pending items, not an error. If it returned an error, say so plainly and offer to try again or pick something else — do not say it worked anyway, and do not write a writeBack event claiming a cart add when it did not happen. The add itself is performed by the shopper's own browser after your reply is sent, not by you directly — you are only ever reporting what create_cart actually resolved.

OFFERS
No discounts. Not when asked, not when the shopper hesitates, not when a competitor is mentioned. The only concession you may mention is free delivery over the threshold, and only when the cart is within 15 euros of it. If a shopper insists on a code, say there is none and say what is genuinely available.

RECOMMENDING
Products shown come from search_catalog, which is ranked by the store's recommendation engine. You choose the criterion (weather, weight, warmth, price, fit) from what the shopper said; you do not reorder the engine's ranking. Show at most three. Always check stock before showing a size. Never show a size with zero stock. For complements, use pairs_with from the catalog and keep the complement at or under about 40 percent of the anchor item's price. When you are suggesting a different size of the exact product the shopper is already viewing (the page product in the context block), do not put it in show — they are already looking at it. State the size you recommend and ask to add it directly; a yes/no chip is enough. Reserve show for a genuinely different product they do not already have in front of them.

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
  /** Real variant ids to add to the shopper's native cart client-side — see ToolLoopResult. */
  pendingCartAdds: Array<{ variantId: string; quantity: number }>;
  /** Every real log_event tool call this turn — see BloomreachWriteLog. Does not include the separate phase B writeBack, which the caller (runMiaTurn) records itself since it fires after this returns. */
  bloomreachWrites: BloomreachWriteLog[];
  /** Real things enforceGuardrails caught and dropped this turn — the model claimed or requested something ground truth didn't back up. Empty is the expected case, not "not checked". */
  violations: string[];
}

/**
 * Folds in real, already-known ground truth that doesn't need Gemini's own
 * tool-calling to find: the current page's product, complete_the_kit's
 * pairs_with complements, and comparison_stall's own compared products. Every
 * Tier 1/2 trigger's real data need is covered by one of these three — none
 * of them require guessing at catalog filters the way an actual customer
 * question does, which is the whole reason Phase A's tool loop can be
 * skipped for a proactive turn at all.
 */
async function resolveKnownCandidates(session: ChatSession, signalCase: SignalCase, pairsWithAnchors: string[]): Promise<MiaCandidate[]> {
  let candidates: MiaCandidate[] = [];
  const known = new Set<string>();
  const add = (c: MiaCandidate | null | undefined) => {
    if (c && !known.has(c.id)) {
      known.add(c.id);
      candidates = [...candidates, c];
    }
  };

  add(session.currentProduct);

  if (pairsWithAnchors.length > 0) {
    const fetched = await Promise.all(pairsWithAnchors.map((handle) => searchCatalog({ pairsWith: handle }).catch(() => [])));
    fetched.flat().forEach(add);
  }

  if (signalCase.relevantHandles.length > 0) {
    const fetched = await Promise.all(
      signalCase.relevantHandles.filter((h) => !known.has(h)).map((handle) => getCandidateByHandle(handle).catch(() => null)),
    );
    fetched.forEach(add);
  }

  return candidates;
}

/** One turn of the Mia conversation. `latestMessage` is undefined for a proactive, signal-driven turn. */
export async function chatWithMia(
  session: ChatSession,
  latestMessage: string | undefined,
  signalCase: SignalCase,
  cart: ClientReportedCart | null = null,
): Promise<MiaTurnResult> {
  if (!config.google.geminiApiKey) {
    const stub: MiaResponse = {
      decision: { action: "stay_closed", readAs: "stub mode, no Gemini key configured", confidence: "low", rejected: [], offer: { type: "none", why: "" } },
      reply: { text: `[gemini:stub] (would answer: "${latestMessage ?? "(proactive check)"}")`, show: [], recommendSizes: {}, addToCart: [], openCheckout: false, chips: [] },
      writeBack: { event: "chat_decision", properties: { stub: true } },
    };
    return { response: stub, ground: { candidates: [], cartNonEmpty: false, cartValue: 0, freeShippingThreshold: 0, pendingCartAddsCount: 0 }, pendingCartAdds: [], bloomreachWrites: [], violations: [] };
  }

  // A proactive check where the rule layer itself found nothing to work with
  // is, by this app's own design ("a rule opens the question, you decide"),
  // never something Gemini would override with a reason of its own — it has
  // no evidence beyond what evaluateSignalCase already looked for. Confirmed
  // live: every real hold_back check observed this session came back
  // stay_closed. The widget polls /signal-check every several seconds for as
  // long as any tab stays open, and the overwhelming majority of those ticks
  // find nothing — that background noise, not real triggers or real replies,
  // was the actual driver of Gemini call volume. Skipping the API call here
  // entirely (no candidates resolved, no request sent) removes that cost
  // without touching any turn that has real evidence to reason about: a
  // genuine trigger match still always goes to Gemini in full, and so does
  // every direct customer message. See CLAUDE.md's admin panel section.
  if (!latestMessage && signalCase.trigger === "hold_back") {
    const skipped: MiaResponse = {
      decision: {
        action: "stay_closed",
        readAs: "no signal case matched this check — skipped the Gemini call entirely",
        confidence: "high",
        rejected: [],
        offer: { type: "none", why: "" },
      },
      reply: { text: "", show: [], recommendSizes: {}, addToCart: [], openCheckout: false, chips: [] },
      writeBack: { event: "", properties: {} },
    };
    return {
      response: skipped,
      ground: { candidates: [], cartNonEmpty: (cart?.totalQuantity ?? 0) > 0, cartValue: cart?.totalAmount ?? 0, freeShippingThreshold: 99, pendingCartAddsCount: 0 },
      pendingCartAdds: [],
      bloomreachWrites: [],
      violations: [],
    };
  }

  const contents: GeminiContent[] = session.history.map((turn) => ({
    role: turn.role === "customer" ? "user" : "model",
    parts: [{ text: turn.message }],
  }));
  if (latestMessage) {
    contents.push({ role: "user", parts: [{ text: latestMessage }] });
  } else if (contents.length === 0) {
    // A proactive signal-check on a brand-new session has no history and no
    // customer message — Gemini rejects a genuinely empty `contents` array
    // outright ("contents is not specified"), so this needs a real anchor.
    contents.push({
      role: "user",
      parts: [{ text: "(Proactive check — no customer message yet. Decide from the context block and signal case below whether to speak at all.)" }],
    });
  }

  const pairsWithAnchors = cart?.unmatchedPairsWith ?? [];
  let candidates: MiaCandidate[];
  let cartNonEmpty: boolean;
  let cartValue: number;
  let pendingCartAdds: Array<{ variantId: string; quantity: number }> = [];
  let bloomreachWrites: BloomreachWriteLog[] = [];

  if (latestMessage) {
    // A real customer message can ask for anything — there's no way to
    // pre-fetch what an open-ended question needs, so this keeps the full
    // tool-calling phase and the model's own judgment about what to look up.
    const toolResult = await runMiaToolLoop(contents, SYSTEM_PROMPT, session);
    const known = await resolveKnownCandidates(session, signalCase, pairsWithAnchors);
    candidates = toolResult.candidates;
    for (const c of known) if (!candidates.some((existing) => existing.id === c.id)) candidates = [...candidates, c];
    cartNonEmpty = toolResult.cartNonEmpty;
    cartValue = toolResult.cartValue;
    pendingCartAdds = toolResult.pendingCartAdds;
    bloomreachWrites = toolResult.bloomreachWrites;
  } else {
    // A proactive, signal-driven turn: every Tier 1/2 trigger's real data
    // need is already covered by resolveKnownCandidates plus the cart
    // snapshot the caller already fetched — nothing here depends on the
    // model deciding to call a tool, so skip Phase A's round trip(s)
    // entirely. Roughly halves Gemini latency for every trigger-driven
    // message, which is the majority of this app's traffic (every Tier 1/2
    // scenario fires this way; only a typed customer message doesn't).
    // Mia never adds to cart on her own initiative, so pendingCartAdds stays empty here.
    candidates = await resolveKnownCandidates(session, signalCase, pairsWithAnchors);
    cartNonEmpty = (cart?.totalQuantity ?? 0) > 0;
    cartValue = cart?.totalAmount ?? 0;
  }

  const contextBlock = buildContextBlock(session, signalCase, candidates);
  const response = await produceMiaResponse(contents, SYSTEM_PROMPT, contextBlock);

  const ground: GroundTruth = {
    candidates,
    cartNonEmpty,
    cartValue,
    freeShippingThreshold: 99,
    pendingCartAddsCount: pendingCartAdds.length,
  };

  const { safe, violations } = enforceGuardrails(response, ground);
  return { response: safe, ground, pendingCartAdds, bloomreachWrites, violations };
}
