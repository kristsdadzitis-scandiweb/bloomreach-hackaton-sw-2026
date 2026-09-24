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

  function anonymousId() {
    try {
      const key = "chat-to-buy-visitor-id";
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
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 10px 12px; background: #f6f6f6; border-top: 1px solid #eee; font-size: 13px;
    }
    #ctb-cart-bar[hidden] { display: none; }
    #ctb-cart-link {
      background: #1e3a2f; color: #fff; text-decoration: none; padding: 8px 14px;
      border-radius: 8px; font-size: 13px; font-weight: 600;
    }
    #ctb-chat-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #eee; }
    #ctb-input { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc; font-size: 14px; }
    #ctb-chat-form button[type="submit"] {
      padding: 8px 14px; border-radius: 8px; border: none; background: #1e3a2f; color: #fff; cursor: pointer;
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
        <span><span id="ctb-cart-count">0</span> item(s) in cart</span>
        <a id="ctb-cart-link" href="#" target="_blank" rel="noopener">Go to checkout</a>
      </div>
      <form id="ctb-chat-form">
        <input id="ctb-input" type="text" placeholder="Type a message…" autocomplete="off">
        <button type="submit">Send</button>
      </form>
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
  const form = root.querySelector("#ctb-chat-form");
  const input = root.querySelector("#ctb-input");
  const headerTitle = root.querySelector("#ctb-header-title");
  const cartBar = root.querySelector("#ctb-cart-bar");
  const cartCountEl = root.querySelector("#ctb-cart-count");
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

  /** Fire-and-forget behavior reporting — local session state for trigger detection, never a Bloomreach write itself. */
  function sendEvent(event, properties) {
    if (!sessionId) return;
    const body = JSON.stringify({ sessionId, event, properties: properties ?? {} });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(api("/api/chat/event"), new Blob([body], { type: "application/json" }));
    } else {
      fetch(api("/api/chat/event"), { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
    }
  }

  // Dwell time on a product page — one real behavioral signal the size-guide
  // and availability triggers don't need, but complete_the_kit/cart_left_behind
  // reasoning benefits from knowing what the shopper actually looked at.
  const viewedProductId = currentProductHandle();
  const viewStartedAt = performance.now();
  if (viewedProductId) {
    window.addEventListener("pagehide", () => {
      const seconds = Math.round((performance.now() - viewStartedAt) / 1000);
      sendEvent("product_view_end", { productId: viewedProductId, seconds });
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
      sendEvent("size_guide_opened", { productId: product.id });

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
            sendEvent("size_unavailable_viewed", { sku: product.sku, size });
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
            sendEvent("size_unavailable_viewed", { sku: product.sku, size });
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
      btn.addEventListener("click", () => sendMessage(reply));
      quickRepliesEl.appendChild(btn);
    }
  }

  let signalPollHandle = null;
  function startSignalPolling() {
    if (signalPollHandle) return;
    // First check mirrors the old fixed-delay pacing; a real signal (not a
    // canned line) decides whether anything actually happens after that.
    setTimeout(checkSignal, 5000);
    signalPollHandle = setInterval(checkSignal, 9000);
  }

  // `force` = the shopper deliberately clicked the launcher, as opposed to a
  // background poll. A background poll must never interrupt an open panel;
  // a deliberate open has nothing to interrupt and should never come back
  // empty, even if the backend has no proactive trigger to fire on.
  async function checkSignal(force) {
    if (!sessionId || (!force && opened)) return;
    let res;
    try {
      res = await fetch(api("/api/chat/signal-check"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch {
      if (force) appendBubble("agent", "Hi! I'm Mia — ask me anything about our gear.");
      return;
    }
    if (res.status === 204) {
      if (force) appendBubble("agent", "Hi! I'm Mia — ask me anything about our gear.");
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
        });
        const data = await res.json();
        sessionId = data.sessionId;
        setStoredSessionId(sessionId);

        if (data.profile?.firstName) {
          headerTitle.textContent = `Hi, ${data.profile.firstName} 👋`;
        }
        if (data.cart?.totalQuantity > 0) showCartBar(data.cart);
        renderSizeGuideAffordance(data.product);

        if (data.history?.length) {
          hasHistory = true;
          for (const turn of data.history) {
            appendBubble(turn.role, turn.message);
            if (turn.products?.length) appendProductCards(turn.products);
          }
          if (getStoredOpenState()) openChat();
        }
        startSignalPolling();

        return sessionId;
      })();
    }
    return sessionPromise;
  }
  ensureSession();

  async function sendMessage(message) {
    if (!opened) openChat();
    appendBubble("customer", message);
    renderQuickReplies([]);

    await ensureSession();
    showThinking();

    let data;
    try {
      const res = await fetch(api("/api/chat/message"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message }),
      });
      data = await res.json();
    } finally {
      hideThinking();
    }

    hasHistory = true;
    appendBubble("agent", data.reply);
    appendProductCards(data.products);
    renderQuickReplies(data.quickReplies);
  }

  async function addProductToCart(variantId, btn) {
    btn.disabled = true;
    btn.textContent = "Adding…";
    try {
      await ensureSession();
      const res = await fetch(api("/api/chat/checkout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, lineItems: [{ variantId, quantity: 1 }] }),
      });
      const cart = await res.json();
      btn.textContent = "Added ✓";
      showCartBar(cart);
    } catch {
      btn.disabled = false;
      btn.textContent = "Add to cart";
    }
  }

  function showCartBar(cart) {
    cartCountEl.textContent = cart.totalQuantity;
    cartLink.href = cart.checkoutUrl;
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
    await checkSignal(true);
  });
  closeBtn.addEventListener("click", closeChat);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    await sendMessage(message);
  });
})();
