# Chat-to-Buy

A proactive on-site shopping assistant: a customer browsing the store gets a
chat bot pop-up, gets help picking products (and what goes with them), and
checks out — ideally without ever leaving the page.

Built for the **Composable AI Hackathon 2026** (Bloomreach × Google × Shopify × Databricks), Track **T2 — Conversational commerce and checkout agents**.

## The loop

1. **Proactive prompt** (frontend) — a chat bubble pops up while the customer browses, with quick-reply chips to lower the bar to engage.
2. **Chat & compare** (Gemini + Shopify) — Gemini decides when to ground itself in the real catalog via tool-calling (never invents price/stock), and reasons about complementary items ("what goes with this?") by searching for each piece separately.
3. **Cart & handoff** (Shopify) — each "Add to cart" click adds to one real Shopify cart for the session (creating it on the first add, appending lines after that), and a persistent cart bar in the chat surfaces a real checkout link the customer clicks when ready. Only in-stock products are ever suggested or shown. Both Shopify's Checkout Kit (Web, early preview) and a `window.open()`-based popup were tried first, but a checkout link the customer clicks directly is the only approach immune to popup-blocker timing quirks.
4. **Loop closure** (Bloomreach) — the completed order is tracked back onto the customer's real profile via the Engagement Track API.

## Stack

- **Runtime**: Node.js 22+, TypeScript, Express
- **Hosting**: Google Cloud Run (single container serves the chat widget + API)
- **Platforms**: Google (Gemini) · Shopify (Storefront API) · Bloomreach (Engagement Track API)

## Project structure

```
src/
  server.ts              entrypoint — serves public/ and mounts routes
  config.ts               env var loading
  types.ts                shared chat/cart types
  routes/
    chat.ts                chat session, message, checkout handoff
  integrations/
    bloomreach.ts           loop closure — tracks the completed order
    gemini.ts               tool-calling chat reasoning + quick replies
    shopify.ts              product search, cart creation
public/
  index.html, app.js       mock product page + proactive chat widget
```

Each integration falls back to mocked data when its credentials aren't set, so the loop is runnable locally without sandbox access.

## Local development

```bash
npm install
cp .env.example .env   # fill in sandbox credentials
npm run dev             # http://localhost:8080
```

- `GET /` — the mock product page with the proactive chat widget
- `POST /api/chat/session`, `/message`, `/checkout` — the chat API the widget calls
- `GET /healthz` — health check

## Deploying to Cloud Run

```bash
gcloud run deploy chat-to-buy --source . --region <region> --allow-unauthenticated
```

## Status

Shopify, Gemini, and Bloomreach integrations are wired to real APIs and tested against the hackathon sandbox.
