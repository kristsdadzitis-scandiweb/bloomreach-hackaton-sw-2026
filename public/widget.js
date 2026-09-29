/**
 * Mia — the Northbound shopping assistant. Embeddable widget loaded by the
 * theme app extension's app embed block. Builds its own DOM/styles from
 * scratch since a real theme's page has none of that.
 *
 * Unlike the old Chat-to-Buy widget, the proactive open isn't a fixed
 * client-side timer — it's driven by the backend's real signal-evaluation
 * layer (POST /api/chat/signal-check), which this widget polls while closed.
 * "Known" identity (greeting by name, personalization) comes from a real
 * Bloomreach read the backend does on /session, not from Liquid alone — it
 * works for anonymous-cookie visitors Bloomreach already knows, not just a
 * real logged-in Shopify customer.
 */
(function () {
  const configEl = document.getElementById("chat-to-buy-config");
  const config = configEl ? JSON.parse(configEl.textContent) : {};
  const backendUrl = config.backendUrl || "";
  if (!backendUrl) {
    console.error("[mia] no backend URL configured, widget disabled");
    return;
  }

  function api(path) {
    return `${backendUrl}${path}`;
  }

  /**
   * Identity in this app is genuinely just "whichever customerId this browser
   * presents" — there's no separate Bloomreach login, per CLAUDE.md. That
   * makes a real named demo persona (e.g. Anna K., seeded with real Bloomreach
   * properties at customerId "anna-k") normally unreachable from a fresh
   * browser, since a fresh visitor always gets a random generated id. A
   * `?ctb_customer=<id>` query param lets a demo/test session deliberately
   * pick which cookie to present, persisted the same way a real one would be
   * so it survives subsequent page loads without repeating the param. Not a
   * fake "log in as" feature — it just sets which real customerId this
   * browser is, exactly like the random id it would otherwise generate.
   */
  function anonymousId() {
    try {
      const key = "chat-to-buy-visitor-id";
      const params = new URLSearchParams(window.location.search);
      if (params.has("ctb_customer")) {
        const requested = params.get("ctb_customer");
        if (requested) {
          localStorage.setItem(key, requested);
          return requested;
        }
        localStorage.removeItem(key);
      }
      let id = localStorage.getItem(key);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(key, id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  function currentProductHandle() {
    const match = window.location.pathname.match(/\/products\/([^/?#]+)/);
    return match ? match[1] : undefined;
  }

  const CURRENCY_SYMBOLS = { EUR: "€", USD: "$", GBP: "£" };
  function formatMoney(amount, currencyCode) {
    const symbol = CURRENCY_SYMBOLS[currencyCode];
    return symbol ? `${symbol}${amount}` : `${amount} ${currencyCode}`;
  }

  // --- styles (namespaced under #chat-to-buy-widget to avoid clashing with the theme) ---
  const style = document.createElement("style");
  style.textContent = `
    #chat-to-buy-widget { all: initial; font-family: system-ui, sans-serif; }
    #chat-to-buy-widget * { box-sizing: border-box; }
    #ctb-launcher {
      position: fixed !important; bottom: 20px !important; right: 20px !important; top: auto !important; left: auto !important;
      width: 60px; height: 60px; border-radius: 50%;
      background: #1e3a2f; color: #fff; border: none; font-size: 24px; cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25); z-index: 2147483000 !important;
    }
    #ctb-launcher[hidden] { display: none; }
    #ctb-panel {
      position: fixed !important; bottom: 20px !important; right: 20px !important; top: auto !important; left: auto !important;
      width: 360px; max-width: calc(100vw - 40px);
      height: 520px; max-height: calc(100vh - 40px); background: #fff; border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.25); display: flex; flex-direction: column; overflow: hidden;
      z-index: 2147483000 !important; color: #1a1a1a;
    }
    #ctb-panel[hidden] { display: none; }
    #ctb-header {
      background: #1e3a2f; color: #fff; padding: 12px 14px; display: flex; align-items: center;
      justify-content: space-between; font-size: 14px; font-weight: 600;
    }
    #ctb-close { background: none; border: none; color: #fff; font-size: 18px; cursor: pointer; line-height: 1; }
    #ctb-log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .ctb-bubble { max-width: 85%; padding: 8px 12px; border-radius: 12px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; }
    .ctb-bubble.customer { align-self: flex-end; background: #1e3a2f; color: #fff; border-bottom-right-radius: 2px; }
    .ctb-bubble.agent { align-self: flex-start; background: #f0f0f0; color: #1a1a1a; border-bottom-left-radius: 2px; }
    .ctb-bubble.thinking { display: flex; align-items: center; gap: 4px; padding: 12px; }
    .ctb-bubble.thinking span {
      width: 6px; height: 6px; border-radius: 50%; background: #999; display: inline-block;
      animation: ctb-bounce 1.2s infinite ease-in-out;
    }
    .ctb-bubble.thinking span:nth-child(2) { animation-delay: 0.15s; }
    .ctb-bubble.thinking span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes ctb-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }
    .ctb-product-cards { align-self: flex-start; display: flex; flex-direction: column; gap: 10px; max-width: 92%; width: 92%; }
    .ctb-product-card { border: 1px solid #e0e0e0; border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .ctb-product-card .ctb-card-top { display: flex; align-items: flex-start; gap: 10px; }
    .ctb-product-card .ctb-thumb {
      width: 48px; height: 48px; border-radius: 6px; background: linear-gradient(135deg, #e2e2e2, #cfcfcf); flex-shrink: 0;
      object-fit: cover; display: block;
    }
    .ctb-product-card .ctb-thumb-link { display: block; flex-shrink: 0; }
    .ctb-product-card .ctb-info { flex: 1; min-width: 0; text-decoration: none; color: inherit; display: block; }
    .ctb-product-card .ctb-info:hover .ctb-title { text-decoration: underline; }
    .ctb-product-card .ctb-info .ctb-title { font-size: 13px; font-weight: 600; }
    .ctb-product-card .ctb-info .ctb-attr { font-size: 12px; color: #1e3a2f; margin: 2px 0 0; }
    .ctb-product-card .ctb-info .ctb-price { font-size: 12px; color: #666; margin: 2px 0 0; }
    .ctb-size-pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .ctb-size-pill {
      font-size: 12px; padding: 4px 9px; border-radius: 999px; border: 1px solid #ccc; background: #fff; cursor: pointer;
    }
    .ctb-size-pill.selected { border-color: #1e3a2f; background: #1e3a2f; color: #fff; }
    .ctb-size-pill.unavailable { text-decoration: line-through; color: #bbb; cursor: not-allowed; border-color: #eee; }
    .ctb-stock-line { font-size: 11px; color: #888; }
    .ctb-size-guide-link { font-size: 11px; color: #1e3a2f; background: none; border: none; text-decoration: underline; cursor: pointer; padding: 0; align-self: flex-start; }
    .ctb-size-guide-note { font-size: 11px; color: #555; background: #f6f6f6; border-radius: 6px; padding: 6px 8px; }
    .ctb-product-card .ctb-add-btn {
      font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid #1e3a2f; background: #fff; cursor: pointer; align-self: flex-start;
    }
    .ctb-product-card .ctb-add-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #ctb-quick-replies { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
    #ctb-quick-replies button {
      font-size: 12px; padding: 6px 10px; border-radius: 999px; border: 1px solid #ccc; background: #fff; cursor: pointer;
    }
    #ctb-cart-bar {
      padding: 12px; background: #fff; border-top: 1px solid #eee; font-size: 13px;
    }
    #ctb-cart-bar[hidden] { display: none; }
    #ctb-cart-title { font-size: 13px; font-weight: 700; margin: 0 0 8px; }
    #ctb-cart-lines { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .ctb-cart-line { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; }
    .ctb-cart-line .ctb-cart-line-name { color: #1a1a1a; }
    .ctb-cart-line .ctb-cart-line-variant { color: #888; }
    .ctb-cart-line .ctb-cart-line-price { color: #1a1a1a; white-space: nowrap; }
    #ctb-cart-total {
      display: flex; justify-content: space-between; align-items: baseline;
      padding-top: 8px; border-top: 1px solid #eee; margin-bottom: 10px;
      font-size: 13px; font-weight: 700;
    }
    #ctb-cart-link {
      display: block; text-align: center; background: #1e3a2f; color: #fff; text-decoration: none;
      padding: 12px 14px; border-radius: 10px; font-size: 14px; font-weight: 700;
    }
    #ctb-size-guide-fab {
      position: fixed !important; bottom: 90px !important; right: 20px !important; top: auto !important; left: auto !important;
      background: #fff; color: #1e3a2f; border: 1px solid #1e3a2f; border-radius: 999px; padding: 8px 14px;
      font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 2147482999 !important;
    }
    #ctb-size-guide-fab[hidden] { display: none; }
    #ctb-size-guide-popover {
      position: fixed !important; bottom: 130px !important; right: 20px !important; top: auto !important; left: auto !important;
      width: 280px; max-width: calc(100vw - 40px); background: #fff; border-radius: 12px; padding: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.25); z-index: 2147482999 !important; color: #1a1a1a;
    }
    #ctb-size-guide-popover[hidden] { display: none; }
    #ctb-size-guide-popover .ctb-sg-title { font-size: 13px; font-weight: 700; margin-bottom: 6px; }
    #ctb-size-guide-popover .ctb-sg-note { font-size: 12px; color: #555; margin-bottom: 10px; }
  `;
  document.head.appendChild(style);

  // --- DOM ---
  const root = document.createElement("div");
  root.id = "chat-to-buy-widget";
  root.innerHTML = `
    <button id="ctb-size-guide-fab" hidden>📏 Size guide</button>
    <div id="ctb-size-guide-popover" hidden></div>
    <button id="ctb-launcher" aria-label="Open chat">🏔️</button>
    <div id="ctb-panel" hidden>
      <div id="ctb-header">
        <span id="ctb-header-title">Hi, I'm Mia 👋</span>
        <button id="ctb-close" aria-label="Close chat">✕</button>
      </div>
      <div id="ctb-log"></div>
      <div id="ctb-quick-replies"></div>
      <div id="ctb-cart-bar" hidden>
        <p id="ctb-cart-title">Your cart</p>
        <div id="ctb-cart-lines"></div>
        <div id="ctb-cart-total"><span>Total</span><span id="ctb-cart-total-amount"></span></div>
        <a id="ctb-cart-link" href="#" target="_blank" rel="noopener">Go to checkout</a>
      </div>
    </div>
  `;
  // Attached to <html> rather than <body> — many OS 2.0 themes (Horizon
  // included) apply a CSS transform to <body> for page-transition
  // animations, which makes it the containing block for any descendant
  // position:fixed element instead of the real viewport. Living outside
  // <body> avoids inheriting that.
  document.documentElement.appendChild(root);

  const launcher = root.querySelector("#ctb-launcher");
  const panel = root.querySelector("#ctb-panel");
  const closeBtn = root.querySelector("#ctb-close");
  const log = root.querySelector("#ctb-log");
  const quickRepliesEl = root.querySelector("#ctb-quick-replies");
  const headerTitle = root.querySelector("#ctb-header-title");
  const cartBar = root.querySelector("#ctb-cart-bar");
  const cartLinesEl = root.querySelector("#ctb-cart-lines");
  const cartTotalAmountEl = root.querySelector("#ctb-cart-total-amount");
  const cartLink = root.querySelector("#ctb-cart-link");
  const sizeGuideFab = root.querySelector("#ctb-size-guide-fab");
  const sizeGuidePopover = root.querySelector("#ctb-size-guide-popover");

  let sessionId = null;
  let opened = false;
  // Whether this session already has a real conversation (as opposed to a
  // brand-new session) — used so reopening the chat on a fresh page load
  // doesn't fire a duplicate proactive turn on top of it.
  let hasHistory = false;

  const customerId = config.customer?.id || anonymousId();

  // A real storefront reloads the whole page on every navigation, so nothing
  // in module state survives moving from one page to the next — persist the
  // session id and open/closed state so the chat picks up where it left off
  // instead of resetting on every page.
  const STORAGE_SESSION_KEY = "chat-to-buy-session-id";
  const STORAGE_OPEN_KEY = "chat-to-buy-was-open";
  // How long a "the panel was open" flag stays honored across page loads —
  // past this, treat it as left open from an old session rather than an
  // active conversation still in progress. Matches comparison_stall's own
  // 10-minute window (the longest natural gap this app's triggers expect
  // between two real actions in the "same" browsing session).
  //
  // This only ever gates *restoring a previously-open panel with nothing new
  // to say* on a fresh page load — it does not, and must not, gate a genuine
  // proactive message. performSignalCheck's own openChat() call (a real
  // trigger fired, Gemini actually replied) is unconditional and runs
  // regardless of this flag or the in-page `opened` variable, on this page or
  // the next one — closing the panel must never cause a real message to go
  // silently undelivered. What this flag alone controls is narrower: if the
  // shopper explicitly closed the chat and then just moves to another page
  // with nothing new having happened, don't resurrect the same dismissed
  // conversation for no reason.
  const REOPEN_STALE_MS = 10 * 60_000;
  function getStoredSessionId() {
    try {
      return localStorage.getItem(STORAGE_SESSION_KEY);
    } catch {
      return null;
    }
  }
  function setStoredSessionId(id) {
    try {
      localStorage.setItem(STORAGE_SESSION_KEY, id);
    } catch {}
  }
  function getStoredOpenState() {
    try {
      return localStorage.getItem(STORAGE_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  }
  function setStoredOpenState(isOpen) {
    try {
      localStorage.setItem(STORAGE_OPEN_KEY, isOpen ? "1" : "0");
    } catch {}
  }

  /**
   * Fire-and-forget behavior reporting — local session state for trigger
   * detection, never a Bloomreach write itself.
   *
   * Deliberately NOT navigator.sendBeacon(): the widget is always cross-origin
   * from the storefront (Cloud Run backend, not the shop's own domain), and a
   * beacon with a non-CORS-safelisted Content-Type like application/json
   * doesn't reliably complete the CORS preflight in real browsers — it just
   * fails with a CORS error in the console, silently, since sendBeacon has no
   * way to report that back to the page. `fetch(..., {keepalive:true})` runs
   * through the exact same CORS negotiation as every other call this widget
   * makes (already verified working against this backend) while still
   * surviving page unload, which is the only reason sendBeacon was used here.
   */
  function postEvent(event, properties) {
    if (!sessionId) return Promise.resolve();
    return fetch(api("/api/chat/event"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, event, properties: properties ?? {} }),
      keepalive: true,
    });
  }

  function sendEvent(event, properties) {
    postEvent(event, properties).catch(() => {});
  }

  // Some events (size guide reopened, availability block) can make a trigger
  // true the instant they happen — waiting on the next background poll tick
  // (up to ~14s away) makes a working feature look broken. sendEvent is
  // fire-and-forget with no ordering guarantee against a signal-check sent
  // right after it, so this awaits the event landing first, then checks.
  //
  // bypassOpenGate: true — unlike the background poll, this recheck is a
  // direct reaction to something the shopper just did (often while looking
  // at a product card *inside an already-open chat*, e.g. a size pill on a
  // comparison_stall/complete_the_kit card). Skipping the "don't interrupt
  // an open panel" gate here just means the reaction lands as the next
  // message in the same conversation, not a surprise popup — nothing to
  // suppress. fallbackGreeting stays false: a decline (204) here just means
  // the evidence wasn't enough yet, not something to paper over with a
  // generic greeting. deliberate: true — a real, specific action just
  // happened, so even a hold_back is worth showing in the admin panel (see
  // checkSignal's own comment for the full deliberate/bypassOpenGate split).
  async function reportEventAndRecheck(event, properties) {
    try {
      await postEvent(event, properties);
    } catch {
      return;
    }
    checkSignal({ bypassOpenGate: true, deliberate: true });
  }

  // Dwell time on a product page — one real behavioral signal the size-guide
  // and availability triggers don't need, but complete_the_kit/cart_left_behind
  // and comparison_stall (grouped by category) reasoning benefits from knowing
  // what the shopper actually looked at.
  const viewedProductId = currentProductHandle();
  const viewStartedAt = performance.now();
  let viewedCategory; // filled in once ensureSession's /session response resolves
  let currentProduct; // ditto — the real per-size stock data, needed to read the theme's own native size selector below
  if (viewedProductId) {
    window.addEventListener("pagehide", () => {
      const seconds = Math.round((performance.now() - viewStartedAt) / 1000);
      sendEvent("product_view_end", { productId: viewedProductId, seconds, category: viewedCategory });
    });
  }

  function scrollToBottom() {
    // While the panel is [hidden] (display:none), scrollHeight reads 0, so
    // bubbles appended during history replay don't actually scroll anything —
    // do it again once the panel is visible and has real layout.
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }

  function openChat() {
    panel.hidden = false;
    launcher.hidden = true;
    opened = true;
    setStoredOpenState(true);
    scrollToBottom();
  }

  function closeChat() {
    panel.hidden = true;
    launcher.hidden = false;
    opened = false;
    setStoredOpenState(false);
  }

  function showThinking() {
    const el = document.createElement("div");
    el.className = "ctb-bubble agent thinking";
    el.id = "ctb-thinking-bubble";
    el.innerHTML = "<span></span><span></span><span></span>";
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function hideThinking() {
    root.querySelector("#ctb-thinking-bubble")?.remove();
  }

  function appendBubble(role, text) {
    if (!text) return;
    const el = document.createElement("div");
    el.className = `ctb-bubble ${role}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  /** The one attribute line the playbook wants named before a recommendation — fit note beats a raw spec. */
  function attributeLine(product) {
    if (product.fitNote) return product.fitNote;
    if (product.waterproof) return `Waterproof rating: ${product.waterproof}`;
    if (product.insulation) return `Insulation: ${product.insulation}`;
    if (product.layer) return `Layer: ${product.layer}`;
    return "";
  }

  // A real, standalone size guide for the product page itself — separate
  // from the chat panel entirely, so size_guide_reopened and
  // availability_block can generate real evidence on a first visit, before
  // the chat has ever been opened once.
  function renderSizeGuideAffordance(product) {
    const hasSizes = product && Object.keys(product.stockBySize || {}).length > 0;
    if (!hasSizes) {
      sizeGuideFab.hidden = true;
      sizeGuidePopover.hidden = true;
      return;
    }

    sizeGuideFab.hidden = false;
    sizeGuideFab.onclick = () => {
      const isOpen = !sizeGuidePopover.hidden;
      if (isOpen) {
        sizeGuidePopover.hidden = true;
        return;
      }
      // Every open is a real reopen signal, not just the first — that's
      // exactly what size_guide_reopened is watching for.
      reportEventAndRecheck("size_guide_opened", { productId: product.id });

      sizeGuidePopover.innerHTML = `
        <div class="ctb-sg-title">${product.name} — sizes</div>
        ${product.fitNote ? `<p class="ctb-sg-note">${product.fitNote}</p>` : ""}
      `;
      const pillsWrap = document.createElement("div");
      pillsWrap.className = "ctb-size-pills";
      const stockLine = document.createElement("p");
      stockLine.className = "ctb-stock-line";

      for (const [size, stock] of Object.entries(product.stockBySize)) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "ctb-size-pill" + (stock === 0 ? " unavailable" : "");
        pill.textContent = size;
        pill.addEventListener("click", () => {
          if (stock === 0) {
            reportEventAndRecheck("size_unavailable_viewed", { sku: product.sku, size });
            stockLine.textContent = `${size} is out of stock right now.`;
            return;
          }
          pillsWrap.querySelectorAll(".ctb-size-pill").forEach((el) => el.classList.remove("selected"));
          pill.classList.add("selected");
          stockLine.textContent = stock <= 3 ? `Only ${stock} left in ${size}` : `In stock in ${size}`;
        });
        pillsWrap.appendChild(pill);
      }
      sizeGuidePopover.appendChild(pillsWrap);
      sizeGuidePopover.appendChild(stockLine);
      sizeGuidePopover.hidden = false;
    };
  }

  // The Horizon theme's own native size selector — a <variant-picker> custom
  // element wrapping either radio buttons/swatches or a <select>, per
  // theme's `blocks/variant-picker.liquid` / `snippets/variant-main-picker.liquid`.
  // Both styles render each option value's own literal text as the
  // input/option's `value` — the exact same string our own `stockBySize`
  // keys use — so matching on `value` works across every variant style
  // without depending on theme-specific classnames or the button style's
  // `data-option-available` attribute (which the dropdown style doesn't
  // render at all, only a translated "- Unavailable" text suffix). This is
  // a real gap the size-guide FAB/chat-card pills don't cover: a shopper
  // using the theme's own on-page size selector never touched either of
  // those, so availability_block never had a chance to fire for them.
  document.addEventListener("change", (e) => {
    const target = e.target;
    if (!currentProduct?.stockBySize || !(target instanceof Element)) return;
    if (!target.closest("variant-picker")) return;
    const isRadio = target.tagName === "INPUT" && target.type === "radio";
    const isSelect = target.tagName === "SELECT";
    if (!isRadio && !isSelect) return;
    const size = target.value;
    if (!(size in currentProduct.stockBySize) || currentProduct.stockBySize[size] > 0) return;
    reportEventAndRecheck("size_unavailable_viewed", { sku: currentProduct.sku, size });
  });

  // The order-summary card only ever learned about a cart change through this
  // widget's own two add flows (the product-card button, pendingCartAdds from
  // a typed message) — a real add via the theme's own PDP "Add to cart"
  // button, or a quantity/remove change in the theme's own cart drawer, never
  // told it anything, so the card looked stale or never appeared at all even
  // though the shopper's real cart genuinely changed. Every one of those goes
  // through Shopify's own Ajax Cart API (`/cart/add(.js)`, `/cart/change.js`,
  // `/cart/update.js`, `/cart/clear.js`) regardless of which theme markup or
  // custom element triggers it — patching fetch is a fast, no-latency path
  // for whichever of those calls actually go through window.fetch. It isn't
  // relied on alone, though: this couldn't be confirmed against the live
  // theme's exact component internals, and it wasn't catching every case
  // live (the card only updated after a reload) — startCartPolling below is
  // the actual reliable backstop, theme-agnostic and cheap thanks to
  // syncCartFromTheme's own dedup.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url ?? "";
    const method = (init?.method ?? (typeof input === "object" ? input?.method : undefined) ?? "GET").toUpperCase();
    const isCartMutation = method === "POST" && /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/.test(url);
    const result = nativeFetch(input, init);
    if (isCartMutation) result.then(() => syncCartFromTheme()).catch(() => {});
    return result;
  };

  function appendProductCards(products) {
    const shown = (products ?? []).filter((p) => p.available);
    if (!shown.length) return;
    const wrap = document.createElement("div");
    wrap.className = "ctb-product-cards";

    for (const product of shown) {
      wrap.appendChild(buildProductCard(product));
    }

    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
  }

  function buildProductCard(product) {
    const card = document.createElement("div");
    card.className = "ctb-product-card";
    const href = product.id ? `/products/${product.id}` : "#";
    const thumb = product.image
      ? `<img class="ctb-thumb" src="${product.image}" alt="${product.name}">`
      : `<div class="ctb-thumb"></div>`;
    const attr = attributeLine(product);

    card.innerHTML = `
      <div class="ctb-card-top">
        <a class="ctb-thumb-link" href="${href}">${thumb}</a>
        <a class="ctb-info" href="${href}">
          <div class="ctb-title">${product.name}</div>
          ${attr ? `<p class="ctb-attr">${attr}</p>` : ""}
          <p class="ctb-price">${product.price}</p>
        </a>
      </div>
    `;

    let selectedSize = null;
    const hasSizes = product.sizesInStock && Object.keys(product.stockBySize || {}).length > 0;

    if (hasSizes) {
      const pillsWrap = document.createElement("div");
      pillsWrap.className = "ctb-size-pills";
      for (const [size, stock] of Object.entries(product.stockBySize)) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "ctb-size-pill" + (stock === 0 ? " unavailable" : "");
        pill.textContent = size;
        pill.addEventListener("click", () => {
          if (stock === 0) {
            // Must recheck, not just report — this is exactly the
            // availability_block trigger's own evidence, and the shopper is
            // looking right at this card inside an already-open chat, so a
            // plain fire-and-forget sendEvent() left it waiting on the next
            // ~9s background poll (which also refuses to run while the panel
            // is open) — looked like nothing happened at all.
            reportEventAndRecheck("size_unavailable_viewed", { sku: product.sku, size });
            stockLine.textContent = `${size} is out of stock right now.`;
            return;
          }
          selectedSize = size;
          pillsWrap.querySelectorAll(".ctb-size-pill").forEach((el) => el.classList.remove("selected"));
          pill.classList.add("selected");
          stockLine.textContent = stock <= 3 ? `Only ${stock} left in ${size}` : `In stock in ${size}`;
          addBtn.disabled = false;
        });
        pillsWrap.appendChild(pill);
      }
      card.appendChild(pillsWrap);

      const stockLine = document.createElement("p");
      stockLine.className = "ctb-stock-line";
      card.appendChild(stockLine);

      if (product.fitNote) {
        const guideLink = document.createElement("button");
        guideLink.type = "button";
        guideLink.className = "ctb-size-guide-link";
        guideLink.textContent = "Size guide";
        let noteShown = false;
        guideLink.addEventListener("click", () => {
          sendEvent("size_guide_opened", { productId: product.id });
          if (noteShown) return;
          noteShown = true;
          const note = document.createElement("p");
          note.className = "ctb-size-guide-note";
          note.textContent = product.fitNote;
          card.insertBefore(note, guideLink);
        });
        card.appendChild(guideLink);
      }
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ctb-add-btn";
    addBtn.textContent = "Add to cart";
    if (hasSizes) addBtn.disabled = true;
    addBtn.addEventListener("click", () => {
      const variantId = hasSizes ? product.variantIdsBySize[selectedSize] : product.variantId;
      if (!variantId) return;
      addProductToCart(variantId, addBtn);
    });
    card.appendChild(addBtn);

    return card;
  }

  function renderQuickReplies(replies) {
    quickRepliesEl.innerHTML = "";
    for (const reply of replies ?? []) {
      const btn = document.createElement("button");
      btn.textContent = reply;
      // Clear synchronously, before sendMessage's own async work even starts —
      // a fast double-click/double-tap on the same chip otherwise fires this
      // handler twice while the first click's customer bubble/request is
      // still in flight, producing one customer bubble but two identical
      // agent replies once both requests resolve. sendMessage's own
      // in-flight guard (below) covers every other path into it.
      btn.addEventListener("click", () => {
        quickRepliesEl.innerHTML = "";
        sendMessage(reply);
      });
      quickRepliesEl.appendChild(btn);
    }
  }

  let signalPollHandle = null;
  function startSignalPolling() {
    if (signalPollHandle) return;
    // First check mirrors the old fixed-delay pacing; a real signal (not a
    // canned line) decides whether anything actually happens after that.
    // Kept at a tight 5s cadence for a snappier demo — the backend still
    // skips the Gemini call entirely on a tick that finds nothing (the
    // overwhelming majority of them), so this is cheap even at this
    // frequency; it's "how often do we check the cheap local rules", not
    // "how often do we ask Gemini".
    // The first check is marked deliberate — arriving at this page (possibly
    // the 2nd, 3rd... product looked at this session) is itself a real,
    // discrete reason to look, unlike every later tick on the same page
    // where nothing new has happened. This is what makes comparison_stall's
    // own "N products viewed, not enough yet" evidence actually show up in
    // the admin log after browsing e.g. 2 products, instead of only ever
    // surfacing once the trigger fully fires on the 3rd.
    setTimeout(() => checkSignal({ deliberate: true }), 5000);
    signalPollHandle = setInterval(checkSignal, 5000);
  }

  // bypassOpenGate: skips the "don't interrupt an open panel" guard — true
  // for the shopper deliberately clicking the launcher (a deliberate open has
  // nothing to interrupt and should never come back empty) and for an
  // event-triggered recheck (a direct reaction to something that just
  // happened belongs in the conversation immediately, open or not). Left
  // false for the plain background poll, which has no new evidence beyond
  // time passing and genuinely shouldn't interrupt an active conversation.
  //
  // fallbackGreeting: only the launcher click wants a guaranteed non-empty
  // response (a deliberate open should never come back silent) — a
  // background poll or an event-triggered recheck coming back empty just
  // means nothing fired yet, not something to paper over with a canned line.
  //
  // The background poll (every ~9s) and an event-triggered recheck (fired
  // right after a size-guide interaction) can otherwise both be in flight for
  // the same session at once. The server now serializes turns per session so
  // a race can't make the same trigger fire twice, but there's no reason to
  // even send the redundant second request — piggyback on whichever check is
  // already running instead of starting a new one.
  let signalCheckInFlight = null;
  async function checkSignal(opts) {
    const { bypassOpenGate = false, fallbackGreeting = false, deliberate = false } = opts || {};
    if (!sessionId || (!bypassOpenGate && opened)) return;
    if (signalCheckInFlight) {
      await signalCheckInFlight;
      return;
    }
    // deliberate is its own flag, separate from bypassOpenGate — they answer
    // different questions. bypassOpenGate: should this check run even while
    // the panel is already open. deliberate: does this check have a specific
    // real reason behind it (an event just happened, the shopper clicked the
    // launcher, or this is the first look right after a fresh page load —
    // e.g. having just navigated to a second product, worth surfacing even
    // if nothing crosses a threshold yet) as opposed to the plain recurring
    // timer, which has no reason beyond time passing. The server uses this to
    // decide whether a hold_back still gets logged for the admin panel — a
    // routine poll finding nothing stays silent, but a deliberate check
    // always shows up, even when it comes back empty. See CLAUDE.md's admin
    // panel section.
    signalCheckInFlight = performSignalCheck(fallbackGreeting, deliberate);
    try {
      await signalCheckInFlight;
    } finally {
      signalCheckInFlight = null;
    }
  }

  async function performSignalCheck(fallbackGreeting, deliberate) {
    let res;
    try {
      // keepalive matters here specifically: a real browsing session (moving
      // between product pages every several seconds, e.g. to build up the
      // comparison_stall pattern) navigates away constantly, and a Gemini
      // round-trip routinely takes longer than that. Without keepalive, the
      // browser aborts this fetch mid-flight the instant the page unloads —
      // confirmed live via Cloud Run logs: far more CORS preflights than
      // completed calls for this exact endpoint (requests dying before the
      // real POST ever lands), which is what "unreliable" actually was.
      res = await fetch(api("/api/chat/signal-check"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, deliberate }),
        keepalive: true,
      });
    } catch {
      if (fallbackGreeting) appendBubble("agent", "Hi! I'm Mia — ask me anything about our gear.");
      return;
    }
    if (res.status === 204) {
      if (fallbackGreeting) appendBubble("agent", "Hi! I'm Mia — ask me anything about our gear.");
      return;
    }
    // The server keeps sessions in memory only — a redeploy or a container
    // recycle can make a previously-valid sessionId genuinely unknown to it.
    // That response has no `reply` field, so treating it like a normal 200
    // used to open an empty, silent chat panel. Recover instead: drop the
    // dead id and quietly re-establish a fresh session for next time.
    if (res.status === 404) {
      resetSession();
      ensureSession();
      if (fallbackGreeting) appendBubble("agent", "Hi! I'm Mia — ask me anything about our gear.");
      return;
    }
    // Any other error status (500 from a Gemini failure, 504 from a genuine
    // timeout, etc.) has the same shape problem as 404 — no `reply` field —
    // and the same fix: don't treat it as a real turn. A background check
    // failing is nothing to show; a forced one (the launcher click) still
    // deserves an honest response instead of silence.
    if (!res.ok) {
      if (fallbackGreeting) appendBubble("agent", "Hi! I'm Mia — ask me anything about our gear.");
      return;
    }
    const data = await res.json();
    hasHistory = true;
    openChat();
    appendBubble("agent", data.reply);
    appendProductCards(data.products);
    renderQuickReplies(data.quickReplies);
  }

  let sessionPromise = null;
  function resetSession() {
    sessionId = null;
    sessionPromise = null;
    try {
      localStorage.removeItem(STORAGE_SESSION_KEY);
    } catch {}
  }
  function ensureSession() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const res = await fetch(api("/api/chat/session"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId,
            productHandle: currentProductHandle(),
            sessionId: getStoredSessionId(),
          }),
          keepalive: true,
        });
        const data = await res.json();
        sessionId = data.sessionId;
        setStoredSessionId(sessionId);

        if (data.profile?.firstName) {
          headerTitle.textContent = `Hi, ${data.profile.firstName} 👋`;
        }
        // The real (native) cart lives in the browser regardless of what the
        // backend remembers — read it directly rather than trusting
        // data.cart, which is only ever a stale echo of what was last
        // reported (the backend has no session into the native cart itself).
        syncCartFromTheme();
        renderSizeGuideAffordance(data.product);
        viewedCategory = data.product?.category;
        currentProduct = data.product;

        if (data.history?.length) {
          hasHistory = true;
          let lastAgentChips = [];
          for (const turn of data.history) {
            appendBubble(turn.role, turn.message);
            if (turn.products?.length) appendProductCards(turn.products);
            if (turn.role === "agent") lastAgentChips = turn.chips ?? [];
          }
          // A fresh page load rebuilds the log from scratch — the DOM never
          // remembers the previous page's quick-reply chips, and until now
          // nothing restored them either, so a real set of options the
          // shopper saw a moment ago silently vanished on the next page/
          // reopen even though the conversation itself replayed fine.
          renderQuickReplies(lastAgentChips);
          // Restore the panel open on a fresh page load only when the
          // shopper didn't explicitly close it AND the conversation is still
          // recent — recency is re-derived fresh from the real last-turn
          // timestamp every time, so an ancient test conversation never
          // resurrects itself no matter how long ago it was left open. This
          // is deliberately narrower than "was there a real conversation": an
          // explicit X close means "leave this dismissed" on the next page,
          // not "forget it happened" — a genuinely new proactive message
          // still isn't affected by this at all, since performSignalCheck's
          // own openChat() call runs unconditionally on real evidence,
          // independent of this flag.
          const lastTurnAt = new Date(data.history[data.history.length - 1].timestamp).getTime();
          if (getStoredOpenState() && Date.now() - lastTurnAt < REOPEN_STALE_MS) {
            openChat();
          }
        }
        startSignalPolling();
        startCartPolling();

        return sessionId;
      })();
    }
    return sessionPromise;
  }
  ensureSession();

  async function postMessage(message) {
    return fetch(api("/api/chat/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
      keepalive: true,
    });
  }

  let sendInFlight = false;
  async function sendMessage(message) {
    if (sendInFlight) return;
    sendInFlight = true;
    if (!opened) openChat();
    appendBubble("customer", message);
    renderQuickReplies([]);

    await ensureSession();
    showThinking();

    let data;
    try {
      let res = await postMessage(message);
      // Same dead-session case as performSignalCheck, but here the customer's
      // own message is sitting in the log waiting on a reply — silently
      // dropping it would look like the chat just stopped working. Re-
      // establish a fresh session and resend it once instead.
      if (res.status === 404) {
        resetSession();
        await ensureSession();
        res = await postMessage(message);
      }
      if (!res.ok) {
        appendBubble("agent", "Sorry, something went wrong on my end — could you try that again?");
        return;
      }
      data = await res.json();
    } finally {
      hideThinking();
      sendInFlight = false;
    }

    hasHistory = true;
    appendBubble("agent", data.reply);
    appendProductCards(data.products);
    renderQuickReplies(data.quickReplies);

    // create_cart resolved real variant ids this turn (e.g. "add the Medium
    // baselayer to my cart") — the backend has no browser session to add
    // them for itself, so the widget performs the actual add here, the same
    // native cart the "Add to cart" button on a product card uses.
    if (data.pendingCartAdds?.length) {
      try {
        await addItemsToNativeCart(data.pendingCartAdds.map((item) => ({ id: nativeVariantId(item.variantId), quantity: item.quantity })));
        await syncCartFromTheme();
      } catch {}
    }
  }

  /** gid://shopify/ProductVariant/123 -> "123" — the theme's native cart API takes plain numeric ids, never a GID. */
  function nativeVariantId(variantId) {
    return variantId.split("/").pop();
  }

  async function addItemsToNativeCart(items) {
    const res = await fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) throw new Error(`native add to cart failed: ${res.status}`);
  }

  async function addProductToCart(variantId, btn) {
    btn.disabled = true;
    btn.textContent = "Adding…";
    try {
      await ensureSession();
      // Goes straight to the theme's own cart now, not a separate
      // Storefront-API cart the backend created — that's the whole fix for
      // "the chat's add to cart doesn't show up in the store's own cart
      // panel." See CLAUDE.md's "Native cart switch".
      await addItemsToNativeCart([{ id: nativeVariantId(variantId), quantity: 1 }]);
      btn.textContent = "Added ✓";
      await syncCartFromTheme();
    } catch {
      btn.disabled = false;
      btn.textContent = "Add to cart";
    }
  }

  /**
   * Reads the theme's own real cart (never something this app created
   * itself) and reports it to the backend so complete_the_kit/cart_left_behind/
   * the free-shipping guardrail keep working — the backend can't fetch this
   * cart on its own, since it has no browser session into it. Requires
   * sessionId already set; every call site awaits ensureSession() first.
   *
   * Deduped against `lastCartSnapshotKey` so `startCartPolling`'s recurring
   * call (below) can run cheaply and often — an unchanged cart never gets
   * past a plain `/cart.js` GET, no `cart_synced` POST, no Storefront
   * resolve, no Bloomreach write. Only a real change commits the new key,
   * and only after the round trip actually succeeds — a failed POST leaves
   * it stale on purpose, so the next tick retries instead of silently
   * believing an update went through that didn't.
   */
  let lastCartSnapshotKey = null;
  async function syncCartFromTheme() {
    if (!sessionId) return;
    let nativeCart;
    try {
      const res = await fetch("/cart.js", { headers: { Accept: "application/json" } });
      nativeCart = await res.json();
    } catch {
      return;
    }
    if (!nativeCart.items?.length) {
      lastCartSnapshotKey = "";
      cartBar.hidden = true;
      return;
    }
    const snapshotKey = `${nativeCart.token}:${nativeCart.item_count}:${nativeCart.total_price}`;
    if (snapshotKey === lastCartSnapshotKey) return;
    const lines = nativeCart.items.map((item) => ({
      variantId: String(item.variant_id),
      quantity: item.quantity,
      lineTotal: item.line_price / 100,
    }));
    try {
      const res = await postEvent("cart_synced", {
        token: nativeCart.token,
        totalQuantity: nativeCart.item_count,
        totalAmount: nativeCart.total_price / 100,
        currencyCode: window.Shopify?.currency?.active || "EUR",
        lines,
      });
      const data = await res.json();
      if (data.cart) showCartBar(data.cart, data.checkoutUrl);
      lastCartSnapshotKey = snapshotKey;
    } catch {}
  }

  // The fetch-patch above catches most real cart mutations, but there's no
  // way to confirm it sees every one against every theme's exact cart-add
  // implementation (some component internals are opaque, and this couldn't
  // be verified against the live storefront directly) — reported live as
  // the order-summary card only updating after a reload/page navigation,
  // meaning at least one real path fell through it. This poll is the
  // reliable, theme-agnostic backstop: it doesn't care how the cart changed,
  // only that it did, and the dedup above keeps it essentially free the vast
  // majority of ticks where nothing changed since the last check.
  let cartPollHandle = null;
  function startCartPolling() {
    if (cartPollHandle) return;
    cartPollHandle = setInterval(syncCartFromTheme, 4000);
  }

  function showCartBar(cart, checkoutUrl) {
    cartLinesEl.innerHTML = "";
    for (const line of cart.lines ?? []) {
      const row = document.createElement("div");
      row.className = "ctb-cart-line";
      const name = document.createElement("span");
      name.className = "ctb-cart-line-name";
      const variantSuffix = line.variantTitle && line.variantTitle !== "Default Title" ? ` · ${line.variantTitle}` : "";
      const qtySuffix = line.quantity > 1 ? ` ×${line.quantity}` : "";
      name.textContent = `${line.title}${variantSuffix}${qtySuffix}`;
      const price = document.createElement("span");
      price.className = "ctb-cart-line-price";
      price.textContent = formatMoney(line.lineTotal, cart.currencyCode);
      row.appendChild(name);
      row.appendChild(price);
      cartLinesEl.appendChild(row);
    }
    cartTotalAmountEl.textContent = formatMoney(cart.totalAmount, cart.currencyCode);
    // Prefers a real UCP (Shopify Agentic Storefronts) checkout handoff —
    // a genuine, line-item-accurate hosted checkout URL for this exact cart,
    // built server-side via createUcpCheckoutUrl — falling back to the
    // theme's generic static /checkout entry point if that call failed or
    // wasn't attempted (e.g. a native cart mutation the backend hasn't
    // resolved yet). Both are real, working checkout entry points; this is
    // strictly a preference for the more specific one when it's available.
    cartLink.href = checkoutUrl || "/checkout";
    cartBar.hidden = false;
  }

  cartLink.addEventListener("click", () => sendEvent("checkout_opened", {}));

  launcher.addEventListener("click", async () => {
    if (hasHistory) {
      // Real conversation already exists (possibly still hidden after a
      // page reload) — just reveal it, no need to fetch anything new.
      openChat();
      return;
    }
    openChat();
    await ensureSession();
    await checkSignal({ bypassOpenGate: true, fallbackGreeting: true, deliberate: true });
  });
  closeBtn.addEventListener("click", closeChat);
})();
