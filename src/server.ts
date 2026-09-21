import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { webhookRouter } from "./routes/webhook.js";
import { chatRouter } from "./routes/chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use("/webhook", webhookRouter);
app.use("/api/chat", chatRouter);

// Serves the chat UI (public/index.html) — the page a customer lands on via the deep link.
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(config.port, () => {
  console.log(`chat-to-buy listening on :${config.port}`);
});
