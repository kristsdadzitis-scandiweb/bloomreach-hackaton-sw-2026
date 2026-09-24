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
