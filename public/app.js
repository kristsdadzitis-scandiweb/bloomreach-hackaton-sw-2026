const launcher = document.getElementById("chat-launcher");
const panel = document.getElementById("chat-panel");
const closeBtn = document.getElementById("chat-close");
const log = document.getElementById("chat-log");
const quickRepliesEl = document.getElementById("quick-replies");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const pageBuyBtn = document.getElementById("page-buy-btn");
const checkoutEl = document.getElementById("shopify-checkout");

let sessionId = null;
let opened = false;

function openChat() {
  panel.hidden = false;
  launcher.hidden = true;
  opened = true;
}

function closeChat() {
  panel.hidden = true;
  launcher.hidden = false;
}

function appendBubble(role, text) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function appendProductCards(products) {
  if (!products?.length) return;
  const wrap = document.createElement("div");
  wrap.className = "product-cards";

  for (const product of products) {
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <div class="thumb"></div>
      <div class="info">
        <div class="title">${product.title}</div>
        <p class="price">${product.priceRange}${product.available ? "" : " · out of stock"}</p>
      </div>
      <button ${product.available ? "" : "disabled"}>Add to cart</button>
    `;
    card.querySelector("button").addEventListener("click", () => checkout(product));
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

async function ensureSession() {
  if (sessionId) return sessionId;
  const params = new URLSearchParams(window.location.search);
  const customerId = params.get("customer") ?? "demo-customer";
  const res = await fetch("/api/chat/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerId }),
  });
  const data = await res.json();
  sessionId = data.sessionId;
  return sessionId;
}

async function sendMessage(message) {
  if (!opened) openChat();
  appendBubble("customer", message);
  renderQuickReplies([]);

  await ensureSession();
  const res = await fetch("/api/chat/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  const data = await res.json();
  appendBubble("agent", data.reply);
  appendProductCards(data.products);
  renderQuickReplies(data.quickReplies);
}

async function checkout(product) {
  await ensureSession();
  const res = await fetch("/api/chat/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, lineItems: [{ variantId: product.variantId, quantity: 1 }] }),
  });
  const cart = await res.json();
  presentCheckout(cart.checkoutUrl);
}

function presentCheckout(checkoutUrl) {
  if (window.__checkoutKitReady && checkoutEl && typeof checkoutEl.open === "function") {
    try {
      checkoutEl.setAttribute("src", checkoutUrl);
      checkoutEl.open();
      return;
    } catch (err) {
      console.error("Checkout Kit failed, falling back to a plain link:", err);
    }
  }
  window.open(checkoutUrl, "_blank");
}

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

pageBuyBtn.addEventListener("click", () => {
  sendMessage("I just added The Complete Snowboard to my cart — anything that goes well with it?");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  await sendMessage(message);
});

if (checkoutEl) {
  checkoutEl.addEventListener("ec.complete", (event) => {
    appendBubble("agent", "🎉 Order placed! Thanks for shopping with us.");
    console.log("Order complete", event.detail?.checkout?.order?.id);
  });
}
