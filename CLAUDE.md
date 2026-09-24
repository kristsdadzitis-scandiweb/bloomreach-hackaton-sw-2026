# Bloomreach access — read this before touching anything Bloomreach-related

There are **two separate, unrelated connections** to Bloomreach in this project. Don't
assume one implies the other works, and don't assume a failure on one means Bloomreach
access is broken in general.

## 1. Reading data — Loomi Connect MCP tools (`mcp__Loomi-Connect__*`)

Used to inspect real Engagement data: customers, their properties, their event history.
This goes through **the logged-in user's own Bloomreach account**, not any credential
stored in this repo. It is read-mostly (some write tools exist too — campaigns,
scenarios — but the app itself never uses them).

Navigation hierarchy: cloud organization → workspace/project → customer.

```
mcp__Loomi-Connect__list_cloud_organizations
  → org: "Hackathon Sept2026"  (id: 23e76270-e92e-48e0-9f60-eeea13449490)

mcp__Loomi-Connect__list_projects  (cloud_organization_id above)
  → project: "dusty-waffle"  (id: 26f53274-b2b0-11f1-a9e6-4ed962b2df3a)
    — this project id matches BLOOMREACH_PROJECT_TOKEN in .env, i.e. it's the
      same Bloomreach project the app writes events into.

mcp__Loomi-Connect__list_customers  (project_id above, optional `query` filters
  by identifier — email/cookie, not properties)
  → customers here are keyed by `cookie` (anonymous visitor id), not email —
    this catalog/demo has no real registered shoppers with PII.

mcp__Loomi-Connect__list_customer_events  (project_id, customer_id)
  → real event history, e.g. `cart_updated` events fired by checkout.

mcp__Loomi-Connect__get_customer_properties  (project_id, customer_id)
  → current property values for that customer.
```

**If a Loomi Connect call fails with a permissions error**, it is almost always one of:
- The MCP server isn't authenticated in that session/environment (different machine,
  expired session) — re-run `list_cloud_organizations` first; if that itself fails,
  it's an auth problem, not a scoped-permission problem.
- Targeting the wrong org/project — always resolve org → project fresh each session
  rather than hardcoding IDs from a stale conversation, in case account access changed.
- A write/admin-level action (campaigns, scenario changes) needing a higher IAM role
  than plain reads.
- **Discovery tools specifically** (`list_discovery_accounts`, `search_discovery_catalogs`,
  `search_discovery_catalog_products`, etc.) can be gated off even when Engagement tools
  work fine — `list_cloud_organizations` succeeding and even showing `DISCOVERY_PRODUCT`
  in `enabled_modules` does **not** mean Discovery is enabled for MCP access. That's a
  separate, account-level toggle an admin has to turn on. If `list_discovery_accounts`
  fails with "Your account is not set up for Discovery" but `list_cloud_organizations`/
  `list_projects`/`list_customers` all work, that's the answer — don't keep re-checking
  auth, and don't conclude Bloomreach access is broken. This is moot anyway for product
  questions — see "No product catalog in Bloomreach" below; there's nothing to query
  there even once Discovery access is granted.

It is **not** evidence that the app's own write path (below) is broken, and vice versa.

### No product catalog in Bloomreach

`search_products` (the chat tool the bot calls) queries the **Shopify Storefront API**
(`src/integrations/shopify.ts`), not Bloomreach Discovery. Bloomreach has no role in
product search/catalog for this app at all — its only involvement is the Engagement
read/write paths described above. Don't reach for Discovery tools (or assume a Discovery
permissions error is relevant) when debugging product search or comparing catalog data —
wrong system entirely.

## 2. Writing data — the app's Track API call (`src/integrations/bloomreach.ts`)

`recordCartUpdateEvent()` sends a real `cart_updated` event via Bloomreach's public
Track API (`POST /track/v2/projects/{token}/customers/events`), authenticated with
`BLOOMREACH_PROJECT_TOKEN` from `.env`. This is **write-only** — the app has no code
path that reads anything back from Bloomreach. It fires once, from
`POST /api/chat/checkout` in `src/routes/chat.ts`, with the real cart id/quantity/line
items — never fabricated data.

There used to be a fake `purchase` event fired here (`order_id: "mock-order-id"`) —
renamed to the honest `cart_updated` event because a real order-completion signal
would need a Shopify order webhook, which needs protected-customer-data approval this
app doesn't have (same gate that blocks reading the Shopify Customer object directly).
Don't reintroduce a `purchase`/`order`-named event unless that approval actually exists
— call it what it verifiably is.

## Verifying either path before claiming something works or is broken

Don't assume — check:
- Read path: run `list_cloud_organizations` → `list_projects` → `list_customers` (with
  a `query` for a known test customer id/cookie, e.g. one used in local testing) →
  `list_customer_events`, and read the actual response.
- Write path: trigger `/api/chat/checkout` (or curl it directly) with a distinctive
  `customerId`, then look it up via the read path above to confirm the event landed.

# Databricks access

Same pattern as Bloomreach: **two separate connections**, don't assume one implies the
other. `.env` has `DATABRICKS_TOKEN` only — no host or SQL warehouse HTTP path, and
`config.ts` has no Databricks integration at all. The app itself cannot currently talk
to Databricks; everything below was done via `mcp__databricks__*` tools, i.e. **the
logged-in user's own Databricks account**, the same way Loomi Connect uses the user's
own Bloomreach login.

Two catalogs matter here, with different permissions for this account:
- `databricks-hackathon` — the shared hackathon reference catalog (`scandiweb`,
  `00data` schemas with fully synthetic sample data, `source_system: "sample_seed_42"`).
  **Read-only** for this account — `CREATE SCHEMA` on it fails with `PERMISSION_DENIED`.
  Don't try to write here again without re-checking; assume it's still read-only.
- `workspace_2` — this account's own catalog. `CREATE SCHEMA` on the catalog itself is
  *also* denied, but `CREATE TABLE` inside its existing `default` schema works. So real
  project data lives directly in `workspace_2.default`, prefixed `chat_to_buy_*` (no
  dedicated schema was possible) — not `databricks-hackathon.chat_to_buy` like an
  earlier plan assumed before actually testing permissions.

Note: `workspace_2` is scoped to the personal-role identity this MCP session
authenticates as — it isn't visible when browsing Databricks under the org's "Scandiweb"
role (confirmed: different workspace/role context, not a UI caching issue). Deliberately
left as-is — this data only needs to support the app functioning, not to be browsable
under every role, so don't treat the role mismatch as something to fix.

## What's loaded in `workspace_2.default.chat_to_buy_*` (real data, not synthetic)

- `chat_to_buy_products` — the full real Shopify catalog (21 rows) via the Storefront
  API. `unit_cost`/`subcategory` are genuinely NULL (not available/not modeled), not
  omitted by mistake.
- `chat_to_buy_customers` — real Bloomreach customers, keyed by the **same cookie id**
  Bloomreach uses, so this table and Bloomreach are actually joinable by `customer_id`
  (unlike the sample data, which shares no key with anything). Only 2 rows: see scope
  note below. `first_name`/`last_name`/`email`/etc. are NULL — these are anonymous
  cookie-identified visitors, there's no real name/email to put there. `synthetic_record`
  is always `false` here, unlike the sample data — a real, meaningful signal.
- `chat_to_buy_transactions` / `chat_to_buy_transaction_items` — derived from real
  `cart_updated` events read back from Bloomreach, joined against real Shopify variant
  prices (Storefront `nodes` query) for honest `unit_price`/amounts, since the Bloomreach
  event itself only carries `cart_id`/`variantId`/`quantity`, no price. **Important:**
  `transaction_status` is `'cart_item_added'`, not `'completed'` — these represent real
  add-to-cart actions, not confirmed orders (same order-webhook approval gate as the
  Bloomreach section above). Don't reinterpret these as completed sales.
- `chat_to_buy_customer_features` / predictions — **not created**. Real feature
  aggregation over 2 customers/3 events is nearly degenerate, and a real
  `customer_predictions` table needs an actual trained model — fabricating scores there
  would repeat the exact mistake the fake `purchase` event was fixed for. Natural
  follow-up once there's more real traffic, not before.

## Scope: this is a bounded backfill, not a full historical export

Only 2 customers (`demo-customer`, `test-cart-resume`) are loaded, out of 877 total
Bloomreach customers. There is no working bulk-discovery path for "which customers have
a real `cart_updated` event": `execute_analytics_eql`'s `customers matching
exists[event ...]` combined with an identifier breakdown (`by customer.id` / `by
customer.cookie`) reliably returns zero rows even when a match is directly confirmed via
`list_customer_events` — a tool limitation, not zero real activity. `list_customer_events`
itself needs a `customer_id`, so without a working discovery query the only way to find
more real activity is checking specific known ids one at a time (rate-limited to ~1/sec).
If a future session wants full coverage, that discovery gap is the thing to solve first —
don't assume 2 customers is the true total, and don't re-attempt the same EQL approach
without a reason to think it'll behave differently.

## Phase 2 (not started): live dual-write from the app

Idea: have `POST /api/chat/checkout` write a transaction row to Databricks the moment a
cart updates, same event/instant as the Bloomreach write, fire-and-forget. Blocked on
getting a real Databricks workspace URL + SQL warehouse HTTP path from the user — the
token alone isn't enough for the app to call the SQL Statement Execution API itself.

# Northbound catalog (Mia demo)

The old snowboard/Weird Fish catalog (22 products) was deleted via `productDelete` —
Northbound replaces that demo, not runs alongside it. Only `gift-card` and
`selling-plans-ski-wax` were left from the original seed (didn't match either
`productType:"snowboard"` or `vendor:"Weird Fish"`, and weren't asked for) — delete
those too if they ever show up in a `search_catalog` result by mistake, but they
haven't so far. `the-minimal-snowboard` also survived on purpose: its `productType`
is empty, not literally `"snowboard"`, so it didn't match the filter used — worth
knowing if "no snowboards left" is ever asserted and it turns out one technically is.

5 real products seeded via Admin API `productSet` in the same dev store, vendor
`Northbound`, all with real Size options and deliberate stock gaps for the Tier 1
triggers: `northbound-trailhead-rain-shell` (S/M/L/XL, **M=0** — drives size guide
reopened + availability block), `northbound-ridgeline-trail-running-shoe` (8/9/10/11,
**9=0**), `northbound-summit-wool-baselayer` (S/M/L, pairs_with → the shell),
`northbound-daypack-18l` (single variant, pairs_with → the shell),
`northbound-merino-socks-2-pack` (single variant, cheap — pairs with the daypack to
land just under the free-shipping threshold). SKUs: `NB-SHELL-*`, `NB-SHOE-*`,
`NB-BASE-*`, `NB-DAYPACK`, `NB-SOCKS`.

Attributes: **tags** (`waterproof-<tier>`, `layer-<value>`) for anything
`search_catalog` filters at the Storefront query level; **`$app`-namespace metafields**
(`waterproof`, `insulation`, `weight_g`, `fit_note`, `layer`, `pairs_with` as
`list.product_reference`) for display/reasoning-only data Storefront can't filter on.
Definitions already created with `access.storefront: PUBLIC_READ` — confirmed the
`$app` shorthand resolves to this app's real namespace (`app--426201448449`) and reads
back correctly via the Storefront token, no separate access grant needed per query.

**Real gotcha hit while seeding**: `productSet`-created products are published to
**zero sales channels** by default — Storefront API returns nothing for them (looks
identical to a query-syntax bug or indexing lag, it's neither). Fix: `publishablePublish`
each product to the `Online Store` publication (`gid://shopify/Publication/301830111560`
on this store — confirmed by checking which publication an existing visible product
uses, don't assume the ID is stable across stores). If a newly-created product is
invisible via Storefront API, check `resourcePublicationsCount` on it via Admin API
before assuming anything else is wrong.

# Shopify access

Unlike Bloomreach/Databricks, this one has **no MCP/interactive-login layer** for the
app's own data — the app talks to Shopify directly over HTTP with credentials from
`.env`, so it works the same whether it's this session, another session, or the deployed
Cloud Run service making the call. The `shopify-plugin:*` skills (shopify-admin-graphql,
shopify-dev, shopify-use-shopify-cli, etc.) are for authoring/looking up API operations —
separate from actually calling the store, which just needs `fetch` + these credentials.

Store: `team-scandiweb.myshopify.com` (dev store, org "Scandiweb AI Hackathon"), API
version `2026-01` (`SHOPIFY_API_VERSION`).

- **Storefront API** (`src/integrations/shopify.ts`, everything the chat bot itself
  uses — search, cart, checkout, demo login) — `POST
  https://${SHOPIFY_STORE_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json` with header
  `X-Shopify-Storefront-Access-Token: ${SHOPIFY_STOREFRONT_API_TOKEN}`. This token is
  long-lived, already in `.env`, nothing to refresh.
- **Admin API** — same GraphQL endpoint shape but `/admin/api/{version}/graphql.json`
  with header `X-Shopify-Access-Token`. `SHOPIFY_ADMIN_API_TOKEN` in `.env` is
  **short-lived** (client_credentials grant) and will expire — if an Admin call suddenly
  401s, that's why, not a revoked permission. Get a fresh one:
  ```
  POST https://team-scandiweb.myshopify.com/admin/oauth/access_token
  { "client_id": SHOPIFY_APP_CLIENT_ID, "client_secret": SHOPIFY_APP_CLIENT_SECRET, "grant_type": "client_credentials" }
  ```
  Used rarely in this app (e.g. `productsCount`) — the app's own runtime code only uses
  the Storefront API; Admin API calls so far have all been one-off investigation, not
  code in the repo.
- **Theme app extension / Shopify CLI** — separate repo,
  `/home/scandiweb/Development/bloomreach-hackaton-sw-2026-shopify-app` (`shopify.app.toml`,
  `client_id = 6aea90769662205d2d66ecdf0f8a3de4`). `shopify app deploy --allow-updates`
  works fine here. `shopify app dev` (live tunnel preview) does **not** work in this
  sandbox — outbound QUIC is blocked (Cloudflare tunnel times out), and the
  `--use-localhost`/`--install-mkcert` fallbacks need an interactive `sudo` password
  prompt this environment can't supply. Don't retry any of that; go straight to `deploy`.
  This is a non-issue in practice since `widget.js` is hosted on Cloud Run, not bundled
  as an extension asset needing hot-reload.
- The extension's own App Embeds section never appeared in this store's theme editor
  (Online Store → Themes → Customize → theme settings) despite the app being installed
  and the extension-bearing version being active — unresolved, worked around by pasting
  the widget's `<script>` tags directly into `theme.liquid` (Edit code) instead. If a
  future session wants the cleaner merchant-facing toggle, that's the open thread — but
  it's not blocking anything, don't spend time rediscovering the same dead end.

# Google Cloud Run deployment

Project `qwiklabs-gcp-02-9567efd29b14`, region `europe-west1`, service `chat-to-buy`.
Deployed straight from source (no separate CI):
```
gcloud run deploy chat-to-buy --source . --region europe-west1 --allow-unauthenticated \
  --project qwiklabs-gcp-02-9567efd29b14 --env-vars-file <path>/cloudrun-env.yaml --quiet
```
Cloud Run doesn't read `.env` — the `--env-vars-file` YAML has to be regenerated from it
before every deploy (it's gitignored scratch, not checked in). **Must exclude `PORT`** —
Cloud Run reserves it and rejects the whole deploy if it's included (`spec.template.spec.containers[0].env: ... reserved env names ... PORT`), hit for real when this snippet
was written without the filter. A quick way:
```js
node -e "
const fs = require('fs');
const lines = fs.readFileSync('.env', 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'));
const yaml = lines
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })
  .filter(([key, value]) => key !== 'PORT' && value !== '')
  .map(([key, value]) => key + ': ' + JSON.stringify(value))
  .join('\n');
fs.writeFileSync('/path/to/scratchpad/cloudrun-env.yaml', yaml);
"
```
`DATABRICKS_TOKEN` is in `.env` but never makes it into `config.ts`/the deployed env —
harmless to include or omit, the app doesn't read it either way (see "Databricks access"
above — the app has no Databricks wiring at all yet).

# Gemini API

Also no MCP layer — plain REST from `src/integrations/gemini.ts`:
`POST https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`.
`GEMINI_API_KEY`/`GEMINI_MODEL` from `.env`, nothing to refresh or re-authenticate.

This same key can generate real images, not just text — confirmed live this session.
`GET .../v1beta/models?key=...` lists `gemini-2.5-flash-image` (and newer `-preview`
variants) among the available models; the same `generateContent` call returns an
`inlineData` part (`{mimeType, data}`, base64 PNG) instead of/alongside `text` when
prompted for an image. Used to generate the 5 Northbound product photos, then uploaded
to Shopify via the standard `stagedUploadsCreate` → upload → `productCreateMedia` flow
(not `productSet`'s own image field — that mutation doesn't take raw file bytes).

# Known Shopify platform limitations on this store (not bugs to keep re-discovering)

These were each investigated and confirmed as real platform constraints, not
misconfiguration — don't spend time re-diagnosing them if they come up again.

- **No real one-click/embedded checkout.** PayPal, Shop Pay, Google Pay etc. all need a
  verified real business account to activate on a store, which a hackathon dev store
  can't get. Confirmed by the user trying to actually connect PayPal and hitting the
  verification wall directly. Checkout stays a redirect to the real Shopify checkout
  page; don't propose embedding a payment sheet without a way around this.
- **Multipass isn't available.** Settings → Customer accounts has no Multipass option
  because this store uses Shopify's new Customer Accounts system (account URLs look like
  `shopify.com/<id>/account`), which doesn't support the legacy Multipass feature at all.
  Not a plan/permission gap — a hard incompatibility. Relevant if a future session
  revisits "can we log a real shopper in automatically."
- **`cartBuyerIdentityUpdate`'s `customerAccessToken` does not reliably drive checkout
  address autofill** — a documented Shopify Developer Community bug, not something wrong
  in this app's code. The actual fix (already implemented, `ensureDemoCustomerAddress` /
  `attachDemoDeliveryAddress` in `shopify.ts`) is giving the demo customer a real saved
  address on their account (`customerAddressCreate` + `customerDefaultAddressUpdate`),
  not just an ad-hoc cart-level `delivery.addresses`. If checkout ever shows blank
  address fields for a "logged in" cart again, check the customer's saved address book
  first, don't just re-attach `buyerIdentity` and assume that alone will fix it.
- **Order webhooks and direct Customer-object reads both need protected-customer-data
  approval** this app doesn't have (already covered under Bloomreach access above — this
  is the same underlying gate, just noting it applies to *any* future feature that wants
  real order-confirmation or customer PII from the Admin/webhook side, not just the
  Bloomreach purchase-event case it was first found for).
- **Online Store 2.0 themes (at least Horizon) apply a CSS `transform` to `<body>`** for
  page-transition animations, which silently makes `<body>` the containing block for any
  descendant `position: fixed` element instead of the real viewport — breaks a naively
  built fixed-position widget/overlay. Fix used in `widget.js`: append the widget's root
  element to `document.documentElement` instead of `document.body`, and put `!important`
  on the positioning properties. Worth remembering for any *other* fixed-position UI
  added to a theme later, not just this widget.
- **A visible bar covering the bottom of the page in theme preview isn't necessarily a
  bug** — it can be Shopify's own staff/admin preview toolbar (tied to the logged-in
  staff session on an unpublished/preview theme), which is outside any app or theme
  code's control. Confirmed by it persisting even on the canonical published store URL
  while the same staff member was logged in. If this comes up again: check in an
  incognito/private window before concluding the widget or theme layout is broken.

# Local dev gotcha

Restarting the dev server with `pkill ... ; (nohup npm run dev ...)` in the *same* bash
call frequently reports an ambiguous "Exit code 144" even when the server actually starts
fine. Don't treat that exit code as a real failure — `curl http://localhost:8080/health`
to check the truth, and if it's down, just retry the bare `(nohup npm run dev > ... &)`
on its own (no `pkill` in the same call) rather than debugging the exit code itself.

# Cloud Run gotcha: never verify a live deploy with the health route

The health endpoint is `/health`, not `/healthz` — it used to be `/healthz` and was
silently broken in production the entire time, without ever causing a visible problem,
because of a real, documented Cloud Run platform quirk: the default `*.run.app` domain
reserves paths ending in `z` and answers them with Google's own frontend 404 page
*before the request ever reaches the container* — confirmed live this session (`curl
.../healthz` on the deployed service returned a Google-branded HTML 404 with no trace of
this app, while `/`, `/widget.js`, and every real `/api/chat/*` route on the exact same
revision returned 200 normally). Locally this never showed up, since there's no Google
frontend in front of `localhost`. **Never use `/health` (or anything else ending in `z`)
to confirm a Cloud Run deploy is actually serving** — hit a real functional route instead
(e.g. `POST /api/chat/session`), or the "deploy succeeded" check itself will lie.
