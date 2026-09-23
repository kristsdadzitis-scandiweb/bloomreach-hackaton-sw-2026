import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { chatRouter } from "./routes/chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// The theme app extension's widget.js runs on the shop's own storefront
// domain (myshopify.com or a custom domain), not ours, so its fetch() calls
// to this API are cross-origin and need CORS — our mock demo page is
// same-origin and unaffected either way.
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || origin === `https://${config.shopify.storeDomain}` || origin.endsWith(".myshopify.com")) {
        return callback(null, true);
      }
      callback(new Error(`Origin not allowed: ${origin}`));
    },
  }),
);
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use("/api/chat", chatRouter);

// Serves the mock product page + proactive chat widget (public/index.html).
app.use(express.static(path.join(__dirname, "..", "public")));

const handleCorsRejection: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof Error && err.message.startsWith("Origin not allowed")) {
    return res.status(403).json({ error: "origin not allowed" });
  }
  next(err);
};
app.use(handleCorsRejection);

app.listen(config.port, () => {
  console.log(`chat-to-buy listening on :${config.port}`);
});
