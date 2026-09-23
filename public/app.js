const launcher = document.getElementById("chat-launcher");
const panel = document.getElementById("chat-panel");
const closeBtn = document.getElementById("chat-close");
const log = document.getElementById("chat-log");
const quickRepliesEl = document.getElementById("quick-replies");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const pageBuyBtn = document.getElementById("page-buy-btn");
const authToggle = document.getElementById("auth-toggle");
const chatHeaderTitle = document.getElementById("chat-header-title");

let sessionId = null;
let opened = false;
let loggedInName = null;

function openChat() {
  panel.hidden = false;
  launcher.hidden = true;
  opened = true;
}

function closeChat() {
  panel.hidden = true;
  launcher.hidden = false;
}

function showThinking() {
  const el = document.createElement("div");
  el.className = "bubble agent thinking";
  el.id = "thinking-bubble";
  el.innerHTML = "<span></span><span></span><span></span>";
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function hideThinking() {
  document.getElementById("thinking-bubble")?.remove();
}

function appendBubble(role, text) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function appendProductCards(products) {
  const inStock = (products ?? []).filter((p) => p.available && p.variantId);
  if (!inStock.length) return;
  const wrap = document.createElement("div");
  wrap.className = "product-cards";

  for (const product of inStock) {
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <div class="thumb"></div>
      <div class="info">
        <div class="title">${product.title}</div>
        <p class="price">${product.priceRange}</p>
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

let pageProduct = null;

function renderPageProduct(product) {
  pageProduct = product;
  if (!product) return;
  const priceEl = document.getElementById("page-price");
  const titleEl = document.getElementById("page-title");
  if (priceEl) priceEl.textContent = product.priceRange;
  if (titleEl) titleEl.textContent = product.title;
}

let sessionPromise = null;

// Cached as an in-flight promise (not just the resolved id) so the eager
// call below and any interaction-triggered call share one session instead
// of racing to create two.
function ensureSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const params = new URLSearchParams(window.location.search);
      const customerId = params.get("customer") ?? "demo-customer";
      const productHandle = document.querySelector(".product")?.dataset.productHandle;
      const res = await fetch("/api/chat/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, productHandle }),
      });
      const data = await res.json();
      sessionId = data.sessionId;
      renderPageProduct(data.product);
      return sessionId;
    })();
  }
  return sessionPromise;
}

// Resolve the real price/title as soon as the page loads, not just once the
// customer opens chat — otherwise the page would show a stale placeholder.
ensureSession();

async function sendMessage(message) {
  if (!opened) openChat();
  appendBubble("customer", message);
  renderQuickReplies([]);

  await ensureSession();
  showThinking();

  let data;
  try {
    const res = await fetch("/api/chat/message", {
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

const cartBar = document.getElementById("cart-bar");
const cartCountEl = document.getElementById("cart-count");
const cartLink = document.getElementById("cart-link");

async function addProductToCart(product, btn) {
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    await ensureSession();
    const res = await fetch("/api/chat/checkout", {
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

// A real <a href> the customer clicks directly satisfies every browser's
// popup-blocker check on its own — no window.open() timing games needed.
function showCartBar(cart) {
  cartCountEl.textContent = cart.totalQuantity;
  cartLink.href = cart.checkoutUrl;
  cartBar.hidden = false;
}

// --- log in / log out toggle (simulates an authenticated customer) ---
function renderAuthState() {
  if (loggedInName) {
    authToggle.textContent = `Log out (${loggedInName})`;
    authToggle.classList.add("logged-in");
    chatHeaderTitle.textContent = `Hi, ${loggedInName} 👋`;
  } else {
    authToggle.textContent = "Log in";
    authToggle.classList.remove("logged-in");
    chatHeaderTitle.textContent = "Need help?";
  }
}

authToggle.addEventListener("click", async () => {
  authToggle.disabled = true;
  try {
    await ensureSession();
    const endpoint = loggedInName ? "/api/chat/logout" : "/api/chat/login";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    loggedInName = data.loggedIn ? data.name : null;
    renderAuthState();
  } finally {
    authToggle.disabled = false;
  }
});

// --- proactive trigger ---
const PROACTIVE_GREETING = "Hi! Looking for anything in particular today?";
const PROACTIVE_QUICK_REPLIES = ["Show me bestsellers", "I need a gift", "Just browsing"];

function triggerProactiveGreeting() {
  if (opened) return;
  openChat();
  appendBubble("agent", PROACTIVE_GREETING);
  renderQuickReplies(PROACTIVE_QUICK_REPLIES);
}

setTimeout(triggerProactiveGreeting, 5000);

launcher.addEventListener("click", () => {
  if (!opened) {
    triggerProactiveGreeting();
  } else {
    openChat();
  }
});
closeBtn.addEventListener("click", closeChat);

pageBuyBtn.addEventListener("click", async () => {
  await ensureSession();
  if (pageProduct?.variantId) {
    await addProductToCart(pageProduct, pageBuyBtn);
  }
  sendMessage(`I just added ${pageProduct?.title ?? "this"} to my cart — anything that goes well with it?`);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  await sendMessage(message);
});
