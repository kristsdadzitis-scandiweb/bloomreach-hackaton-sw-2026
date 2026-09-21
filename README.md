# Chat-to-Buy

An agent that wins back lapsed shoppers through conversation.

Built for the **Composable AI Hackathon 2026** (Bloomreach × Google × Shopify × Databricks), Track **T2 — Conversational commerce and checkout agents**.

## The loop

1. **Detect drift** (Bloomreach) — a scenario trigger fires when a repeat buyer's purchase rhythm breaks.
2. **Decide & draft** (Gemini) — decides whether the customer is worth contacting and drafts the opener + channel.
3. **Reach out** (Bloomreach) — sends the SMS/email with a deep link into the chat.
4. **Chat & compare** (Gemini + Shopify) — a grounded conversation, answers backed by real stock and price.
5. **Cart & handoff** (Shopify) — builds the cart, hands back a checkout link; payment happens in Shopify's own checkout.

The resulting order flows back into Bloomreach, updating the profile and triggering the post-purchase nurture sequence — closing the loop.

## Stack

- **Runtime**: Node.js 22+, TypeScript, Express
- **Hosting**: Google Cloud Run (single container serves the chat UI + API)
- **Platforms**: Bloomreach (Loomi Connect, Marketing Agent, Platform APIs) · Google (Gemini) · Shopify (Storefront/Admin APIs)

## Project structure

```
src/
  server.ts              entrypoint — serves public/ and mounts routes
  config.ts               env var loading
  types.ts                shared types for the loop (DriftContext, OutreachDecision, ...)
  routes/
    webhook.ts             step 1→3: Bloomreach scenario webhook receiver
    chat.ts                step 4→5: chat session, message, checkout handoff
  integrations/
    bloomreach.ts           Loomi Connect / Marketing Agent / Platform API calls
    gemini.ts               outreach decision + chat reasoning
    shopify.ts              product search, cart creation
public/
  index.html, app.js       placeholder chat UI (the deep-link destination)
```

Everything in `integrations/` currently returns mocked data when its credentials aren't set, so the full loop is runnable end to end locally before sandbox access lands — swap in real calls behind each `TODO`.

## Local development

```bash
npm install
cp .env.example .env   # fill in once sandbox credentials are provisioned
npm run dev             # http://localhost:8080
```

- `POST /webhook/bloomreach` — simulate the scenario's webhook trigger
- `GET /` — the placeholder chat UI
- `GET /healthz` — health check

## Deploying to Cloud Run

```bash
gcloud run deploy chat-to-buy --source . --region <region> --allow-unauthenticated
```

## Status

Skeleton only — see `TODO`s in `src/integrations/` for what's stubbed vs. wired to real APIs.
