const log = document.getElementById("log");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");

let sessionId = null;

function appendMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  appendMessage("customer", message);

  await ensureSession();
  const res = await fetch("/api/chat/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  const data = await res.json();
  appendMessage("agent", data.reply);
});
