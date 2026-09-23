/**
 * Chat-to-Buy embeddable widget — loaded by the theme app extension's app
 * embed block. Unlike public/app.js (built for the mock demo page, which
 * already has the widget's markup in its HTML), this builds its own DOM and
 * styles from scratch, since a real theme's page has none of that.
 *
 * Scope note: this greets a real logged-in shopper by name (from the
 * Liquid `customer` global the embed block passes in), but doesn't attempt
 * to attach their real Shopify identity to the cart for checkout
 * personalization — that needs an actual customerAccessToken, which Liquid
 * can't hand to page JS for a real shopper. The demo's "Log in" toggle
 * (a fixed simulated account) is intentionally not part of this widget.
 */
(function () {
  const configEl = document.getElementById("chat-to-buy-config");
  const config = configEl ? JSON.parse(configEl.textContent) : {};
  const backendUrl = config.backendUrl || "";
  if (!backendUrl) {
    console.error("[chat-to-buy] no backend URL configured, widget disabled");
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
      background: #1a1a1a; color: #fff; border: none; font-size: 24px; cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25); z-index: 2147483000 !important;
    }
    #ctb-launcher[hidden] { display: none; }
    #ctb-panel {
      position: fixed !important; bottom: 20px !important; right: 20px !important; top: auto !important; left: auto !important;
      width: 340px; max-width: calc(100vw - 40px);
      height: 480px; max-height: calc(100vh - 40px); background: #fff; border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.25); display: flex; flex-direction: column; overflow: hidden;
      z-index: 2147483000 !important; color: #1a1a1a;
    }
    #ctb-panel[hidden] { display: none; }
    #ctb-header {
      background: #1a1a1a; color: #fff; padding: 12px 14px; display: flex; align-items: center;
      justify-content: space-between; font-size: 14px; font-weight: 600;
    }
    #ctb-close { background: none; border: none; color: #fff; font-size: 18px; cursor: pointer; line-height: 1; }
    #ctb-log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .ctb-bubble { max-width: 85%; padding: 8px 12px; border-radius: 12px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; }
    .ctb-bubble.customer { align-self: flex-end; background: #1a1a1a; color: #fff; border-bottom-right-radius: 2px; }
    .ctb-bubble.agent { align-self: flex-start; background: #f0f0f0; color: #1a1a1a; border-bottom-left-radius: 2px; }
    .ctb-bubble.thinking { display: flex; align-items: center; gap: 4px; padding: 12px; }
    .ctb-bubble.thinking span {
      width: 6px; height: 6px; border-radius: 50%; background: #999; display: inline-block;
      animation: ctb-bounce 1.2s infinite ease-in-out;
    }
    .ctb-bubble.thinking span:nth-child(2) { animation-delay: 0.15s; }
    .ctb-bubble.thinking span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes ctb-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }
    .ctb-product-cards { align-self: flex-start; display: flex; flex-direction: column; gap: 8px; max-width: 90%; }
    .ctb-product-card { border: 1px solid #e0e0e0; border-radius: 10px; padding: 8px 10px; display: flex; align-items: center; gap: 10px; }
    .ctb-product-card .ctb-thumb {
      width: 40px; height: 40px; border-radius: 6px; background: linear-gradient(135deg, #e2e2e2, #cfcfcf); flex-shrink: 0;
    }
    .ctb-product-card .ctb-info { flex: 1; min-width: 0; }
    .ctb-product-card .ctb-info .ctb-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctb-product-card .ctb-info .ctb-price { font-size: 12px; color: #666; margin: 0; }
    .ctb-product-card button {
      font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid #1a1a1a; background: #fff; cursor: pointer;
    }
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
      background: #1a1a1a; color: #fff; text-decoration: none; padding: 8px 14px;
      border-radius: 8px; font-size: 13px; font-weight: 600;
    }
    #ctb-chat-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #eee; }
    #ctb-input { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc; font-size: 14px; }
    #ctb-chat-form button[type="submit"] {
      padding: 8px 14px; border-radius: 8px; border: none; background: #1a1a1a; color: #fff; cursor: pointer;
    }
  `;
  document.head.appendChild(style);

  // --- DOM ---
  const root = document.createElement("div");
  root.id = "chat-to-buy-widget";
  root.innerHTML = `
    <button id="ctb-launcher" aria-label="Open chat">💬</button>
    <div id="ctb-panel" hidden>
      <div id="ctb-header">
        <span id="ctb-header-title">Need help?</span>
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

  let sessionId = null;
  let opened = false;

  if (config.customer?.firstName) {
    headerTitle.textContent = `Hi, ${config.customer.firstName} 👋`;
  }

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

  function openChat() {
    panel.hidden = false;
    launcher.hidden = true;
    opened = true;
    setStoredOpenState(true);
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
    const el = document.createElement("div");
    el.className = `ctb-bubble ${role}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function appendProductCards(products) {
    const inStock = (products ?? []).filter((p) => p.available && p.variantId);
    if (!inStock.length) return;
    const wrap = document.createElement("div");
    wrap.className = "ctb-product-cards";

    for (const product of inStock) {
      const card = document.createElement("div");
      card.className = "ctb-product-card";
      card.innerHTML = `
        <div class="ctb-thumb"></div>
        <div class="ctb-info">
          <div class="ctb-title">${product.title}</div>
          <p class="ctb-price">${product.priceRange}</p>
        </div>
        <button>Add to cart</button>
      `;
      const btn = card.querySelector("button");
      btn.addEventListener("click", () => addProductToCart(product, btn));
      wrap.appendChild(card);
    }

    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
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

  let sessionPromise = null;
  function ensureSession() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const res = await fetch(api("/api/chat/session"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId: config.customer?.id || anonymousId(),
            productHandle: currentProductHandle(),
            sessionId: getStoredSessionId(),
          }),
        });
        const data = await res.json();
        sessionId = data.sessionId;
        setStoredSessionId(sessionId);

        if (data.history?.length) {
          for (const turn of data.history) {
            appendBubble(turn.role, turn.message);
          }
          if (getStoredOpenState()) openChat();
        } else if (getStoredOpenState()) {
          // No real conversation yet, but the panel was open (they'd seen the
          // proactive greeting) when they navigated — restore it immediately
          // instead of making them wait through the timer again.
          triggerProactiveGreeting();
        } else {
          setTimeout(triggerProactiveGreeting, 5000);
        }

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

    appendBubble("agent", data.reply);
    appendProductCards(data.products);
    renderQuickReplies(data.quickReplies);
  }

  async function addProductToCart(product, btn) {
    btn.disabled = true;
    btn.textContent = "Adding…";
    try {
      await ensureSession();
      const res = await fetch(api("/api/chat/checkout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, lineItems: [{ variantId: product.variantId, quantity: 1 }] }),
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

  const PROACTIVE_GREETING = "Hi! Looking for anything in particular today?";
  const PROACTIVE_QUICK_REPLIES = ["Show me bestsellers", "I need a gift", "Just browsing"];

  function triggerProactiveGreeting() {
    if (opened) return;
    openChat();
    appendBubble("agent", PROACTIVE_GREETING);
    renderQuickReplies(PROACTIVE_QUICK_REPLIES);
  }

  launcher.addEventListener("click", () => {
    if (!opened) {
      triggerProactiveGreeting();
    } else {
      openChat();
    }
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
