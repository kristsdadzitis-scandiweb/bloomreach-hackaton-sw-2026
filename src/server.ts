import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { chatRouter } from "./routes/chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use("/api/chat", chatRouter);

// Serves the mock product page + proactive chat widget (public/index.html).
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(config.port, () => {
  console.log(`chat-to-buy listening on :${config.port}`);
});
