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

// Not /healthz — Cloud Run's default *.run.app domain reserves paths ending in
// "z" and answers them with its own 404 at the frontend, before the request
// ever reaches this container. See CLAUDE.md.
app.get("/health", (_req, res) => res.json({ ok: true }));

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

// Final safety net — every chatRouter route already catches its own errors
// (see asyncHandler in routes/chat.ts), but this catches anything else
// (a future route added without that wrapper, a sync throw, etc.) rather
// than letting Express's default handler behavior surprise us.
const handleUnexpectedError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "internal error" });
  }
};
app.use(handleUnexpectedError);

// One customer's request must never take the whole app down for everyone
// else — this is a single process serving every session in memory. Every
// route is already wrapped (asyncHandler), so reaching this is itself a
// bug, but the alternative (letting Node exit) is strictly worse.
process.on("uncaughtException", (err) => console.error("[server] uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("[server] unhandledRejection:", err));

app.listen(config.port, () => {
  console.log(`chat-to-buy listening on :${config.port}`);
});
