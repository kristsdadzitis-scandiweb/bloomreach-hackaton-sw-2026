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
before assuming anything else is wrong. **Also hit again after creating a product**:
a brand-new product's `featuredImage` and a brand-new Bloomreach customer's properties
can both briefly 404/null right after the write — not a bug, just async indexing;
wait a few seconds and re-read before concluding something failed.

## availability_block only listened to our own UI, never the theme's real size selector

Found live this session: `availability_block` fires from `size_unavailable_viewed`
events, but the widget only ever reported that event from its own custom UI — the
floating "📏 Size guide" FAB's popover, and a size pill on a product card Mia shows
inside the chat. Neither is wired to the theme's actual on-page size selector, so a
shopper clicking a real out-of-stock size button on the product page itself produced no
event at all — not a bug in what existed, just a real gap in what was covered.

Fixed by reading the live Horizon theme's own source (`blocks/variant-picker.liquid` /
`snippets/variant-main-picker.liquid`, pulled via the Admin API's `theme { files }`
after adding `read_themes` — see Shopify access section) to find the real markup:
every size option, in every variant style (buttons, swatches, **and** dropdowns) inside
Horizon's `<variant-picker>` custom element, renders as an `<input>`/`<option>` whose
own `value` attribute is the literal size string — the exact same string our own
`stockBySize` keys use. `public/widget.js` now has one delegated `document`-level
`change` listener that matches any `<input type="radio">`/`<select>` inside a
`variant-picker` element, looks its `value` up in `currentProduct.stockBySize` (already
fetched via `/api/chat/session`, the same data the FAB popover uses), and calls
`reportEventAndRecheck` when that size is genuinely at 0 stock — deliberately not
reading the button style's own `data-option-available` attribute, since the dropdown
style doesn't render that attribute at all (only a translated "- Unavailable" text
suffix) — matching on `value` against real stock data we already have works uniformly
across every variant style without depending on theme-specific/locale-specific markup.

**Two compounding bugs fixed in the same pass** (found while chasing this): the in-chat
product card's size pill used fire-and-forget `sendEvent` instead of
`reportEventAndRecheck`, so it never asked the server to check anything; and even the
correct path's `checkSignal()` call had no way to bypass the "don't interrupt an open
panel" gate, which silently no-ops whenever the chat is already open — exactly the state
you're in when looking at a product card inside it. `checkSignal` now takes
`{ bypassOpenGate, fallbackGreeting }` instead of a single overloaded `force` boolean —
see the comments at its definition in `public/widget.js` for which callers need which flag.

## Trigger Screens — Tier 2 expansion (in progress)

A colleague's second design artifact ("Trigger Screens", a Claude Artifact, not in this
repo) specifies 18 total triggers: the 5 we already built are its own "Tier 1 · build
and demo" set (confirms our scope was right). Tier 2 ("build if time") is 4 more:
checkout stall, comparison stall, honest trade-up, functional essential. Tier 3 (8 more)
is explicitly marked "design only" in that artifact — not being built, no catalog/data
work planned for it unless asked. Going through Tier 2 one scenario at a time, adding
only the real Shopify products and Bloomreach data each one actually needs — not yet
wiring the trigger-detection logic itself (that's a separate, later pass per scenario).

**Anna K.** — the artifact's own name for its "known identity" persona, reused verbatim
rather than inventing a new one. A real, persistent Bloomreach customer at a **fixed**
id, `anna-k` (not a throwaway per-test id like the rest of this session's curl tests
used) — set once via `updateCustomerProfile`, meant to be reused across every future
"known"/"mid-session" scenario rather than re-seeded each time. Current real profile:
`firstName: "Anna"`, `usualSizeTop: "L"`, `topCategory: "jackets"`, `ordersCount: 1`,
`lastOrderDate: "2026-08-02"`, `lastOrderItems: ["northbound-trailhead-rain-shell"]`,
`segment: "returning_hiker"`, `consent: true`. To demo the "known" flow for real, use
`customerId: "anna-k"` (e.g. set `localStorage["chat-to-buy-visitor-id"] = "anna-k"` in
the browser before starting a session) — Bloomreach identity in this app is keyed by
that cookie-like customerId, not by the separate Shopify demo-login account. Extend her
profile as later scenarios need more (e.g. `usualSizeShoe`), don't create a second persona.

**Comparison stall** (Tier 2, first one built): needed a real 3-way jacket comparison —
previously only had one jacket (`northbound-trailhead-rain-shell`, 20k/420g/189).  Added:
`northbound-pinnacle-shell` (28k/250g/279 EUR, SKUs `NB-PINNACLE-*`, real image, healthy
stock all sizes — the "lighter and pricier" end) and `northbound-squall-wind-jacket`
(water-repellent only/150g/89 EUR, SKUs `NB-SQUALL-*`, real image, healthy stock — the
"cheap but doesn't hold up in real rain" end). Same creation flow as the original 5:
`productSet` (with `sku` inline this time, not backfilled after) → `publishablePublish` →
`metafieldsSet` for the `$app` fields → Gemini-generated image → `stagedUploadsCreate`/
upload/`productCreateMedia`. Verified via the app's own `searchCatalog({category:"jacket"})`
that all three now come back with correctly differentiated waterproof/weight/price.

**Catalog depth pass** (general, not tied to one trigger): added 8 more products for
comparison/variety, same creation flow as above, all with a deliberate out-of-stock size
gap like the original set (never all sizes fully stocked). New `productType`/category
values introduced here: `midlayer` (layer `mid`) and `pants` (layer `bottom`) — previously
only `jacket`/`footwear`/`baselayer`/`accessory` existed. Full list:
- `northbound-glacier-insulated-parka` (jacket, 20k/620g/329 EUR, SKUs `NB-GLACIER-*`, **S=0**)
- `northbound-windridge-softshell` (jacket, water-repellent/310g/139 EUR, SKUs `NB-WINDRIDGE-*`, **XL=0**)
- `northbound-cascade-hiking-boot` (footwear, 20k/980g/219 EUR, sizes 8-12, SKUs `NB-CASCADE-*`, **10=0**)
- `northbound-trailhead-approach-shoe` (footwear, water-repellent/540g/129 EUR, sizes 7-11, SKUs `NB-APPROACH-*`, **8=0**)
- `northbound-featherline-baselayer` (baselayer, none/140g/59 EUR — a cheaper synthetic alternative to the wool one, SKUs `NB-FEATHERLINE-*`, **M=0**)
- `northbound-ember-fleece` (midlayer, none/380g/99 EUR, SKUs `NB-EMBER-*`, **L=0**)
- `northbound-traverse-hiking-pants` (pants, water-repellent/420g/119 EUR, SKUs `NB-TRAVERSE-*`, **S=0**)
- `northbound-squall-rain-pants` (pants, 20k/280g/99 EUR, SKUs `NB-RAINPANTS-*`, **XL=0** — also added as a
  third `pairs_with` complement on `northbound-trailhead-rain-shell` itself, alongside the
  existing baselayer/daypack, since that's the metafield the anchor product needs per the
  pairs_with direction gotcha above)

Verified all 8 via the Storefront API directly (correct `productType`, stock gaps, real
images) and via the app's own `searchCatalog` for `category`, `layer`, `waterproofMin`,
and `pairsWith` filters. Not yet tied to any new trigger logic — same "products/data first,
wiring later" approach as the rest of Tier 2.

**Catalog realism pass — 50 filler products** (deliberately NOT scenario-tailored): the
17 products above all exist because some Tier 1/2 trigger needed them, which made the
whole catalog look hand-curated for demos. Added 50 more spanning headwear, gloves,
eyewear, hydration, camping gear (shelter/sleep/cook), tools/nav, bags, casual apparel,
extra footwear, extra outerwear, and misc (first aid, sunscreen, water filter, etc.) —
most have no relationship to any trigger at all, on purpose. Two new `productType`
values: `apparel` (tee/pullover/shorts/travel pants/hoodie/sweatpants) — the catalog now
has 65 Northbound products total across `jacket`(7)/`footwear`(5)/`baselayer`(2)/
`accessory`(42)/`midlayer`(1)/`pants`(2)/`apparel`(6). Same creation flow as every batch
above (`productSet` → `publishablePublish` → `metafieldsSet` → Gemini image →
`stagedUploadsCreate`/upload/`productCreateMedia`), scripted this time
(`create-batch3.mjs` + `image-batch3.mjs` in the session scratchpad — not checked into
the repo, same as every other one-off seeding script this project has used) since doing
50 by hand isn't practical. Every sized item still has a realistic partial stock gap
(never fully in stock, never fully out) and 2 single-variant items are deliberately at
0 stock (`northbound-solo-bivy-tent`, `northbound-insect-repellent-spray`) for the same
reason. `waterproof`/`layer` metafields are only set where they genuinely apply (gloves,
the down vest, the windbreaker) — left unset on camping/misc gear rather than forcing
irrelevant tags onto them, which is itself part of what makes this batch read as filler
rather than curated.

**Shopify's real Standard Product Taxonomy** (a `category` field on `Product`, confirmed
present on both Admin and Storefront APIs this store's `2026-01` version, entirely
separate from our own `productType`/tags/metafields) was set on all 65 products —
resolved live via `taxonomy.categories(search:)` and `taxonomy.categories(childrenOf:)`
on the Admin API, then set through `productSet`'s/`productUpdate`'s `category` input
field (a taxonomy node gid, e.g. `gid://shopify/TaxonomyCategory/aa-1-10-2-10` for "Rain
Coats"). **This has zero effect on Mia or `search_catalog`** — the app never reads this
field, it only exists for Shopify's own storefront collection/filter UI (Search &
Discovery app) if the theme's collection pages ever use it; no theme edit was made or
needed for the app itself. A few items have no `category` set at all
(`northbound-multi-tool`, `northbound-trail-map-case`) because no taxonomy node in
Shopify's ~10,000-node standard list was a reasonable match — left unset rather than
forcing a wrong one.

A product can only ever hold **one** `productType` and **one** taxonomy `category` —
both are single-value fields, confirmed via the Admin schema, not lists. Tags and
collection membership are the only many-valued mechanisms Shopify actually has for a
product to be reachable under more than one grouping.

**"Northbound" collection + Search & Discovery filter setup**: created a real smart
collection (`collectionCreate`, handle `northbound`, rule `vendor EQUALS Northbound`,
published to Online Store) so the catalog has somewhere to actually be filtered — Search
& Discovery's filters only apply within a collection/search page, and none existed
before this (the store only had a stray 4-product price-rule "Automated Collection").
**Enabling the actual filter UI is merchant-only, no Admin API for it**: Search &
Discovery → Filters → Edit filters → enable "Product type" (confirmed via shopify.dev
docs — by default only Availability/Price are on). Use **Product type**, not the
taxonomy "Product category" filter, for anything like "show me jackets" — our jacket-like
products are spread across several different taxonomy leaf categories (Rain Coats,
Windbreakers, Parkas, Vests), so a category-based filter would fragment them into
separate checkboxes instead of one unified "jacket" option; `productType` is exactly
"jacket" for all of them. Search & Discovery itself is a free first-party Shopify app —
if it's not already in this store's sidebar under Apps/Sales channels, it's a one-click
install from the Shopify App Store, not a real integration.

**Footwear depth pass**: added 8 more footwear products (3 boots, 5 shoes) on top of the
original 5, same creation flow, each with a realistic single out-of-stock size —
`northbound-summit-mountaineering-boot` (28k/1400g/349 EUR), `northbound-winter-pac-boot`
(20k/1200g/179 EUR), `northbound-everyday-chukka-boot` (none/750g/139 EUR),
`northbound-road-to-trail-runner` (none/280g/109 EUR), `northbound-cushion-walking-shoe`
(none/320g/89 EUR), `northbound-amphibious-water-shoe` (none/230g/69 EUR, taxonomy
"Water Shoes" rather than "Athletic Shoes"), `northbound-speed-trail-runner`
(none/210g/149 EUR), `northbound-all-terrain-hiking-shoe` (water-repellent/420g/119 EUR).
Footwear is now 13 products total. Since the "Northbound" collection above is a smart
collection matching `vendor:Northbound`, these were included automatically — no manual
step needed to add them to it.

**`type-<slug>` tags** (via `tagsAdd`, not `productSet`, since these were added to
already-existing products): a finer subtype tag for jackets and footwear, since
`productType` is the same flat "jacket"/"footwear" for all of them and can't distinguish
a rain coat from a windbreaker, or a running shoe from a hiking boot, the way Search &
Discovery's **tag** filter can once enabled (Search & Discovery → Filters → Edit filters
→ enable "Product tag" — confirmed via shopify.dev docs as a real built-in filter type,
same place as the "Product type" filter). Jackets: `type-rain-coat` (trailhead-rain-shell,
pinnacle-shell), `type-windbreaker` (squall-wind-jacket, windridge-softshell,
packable-windbreaker), `type-parka` (glacier-insulated-parka), `type-vest` (down-vest).
Footwear: `type-running-shoe` (ridgeline-trail-running-shoe, road-to-trail-runner,
speed-trail-runner), `type-hiking-boot` (cascade-hiking-boot), `type-approach-shoe`,
`type-sandal`, `type-bootie`, `type-mountaineering-boot`, `type-winter-boot`,
`type-chukka-boot`, `type-walking-shoe`, `type-water-shoe`, `type-hiking-shoe`. Verified
live via Storefront `tag:'type-...'` queries. **Not read by Mia's own `search_catalog`**
— that only ever filters on `waterproof-*`/`layer-*` tags, so this is purely for the
storefront's own filter UI, same as the taxonomy `category` field above. A generic
"Product tag" filter in Search & Discovery will likely surface every tag on these
products (including `waterproof-*`/`layer-*`), not just `type-*` — the `type-` prefix at
least keeps them visually distinct; whether Search & Discovery lets a merchant curate a
named filter down to just the `type-*` values needs checking in the app itself, not
confirmed from docs alone.

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
- **Changing `[access_scopes] scopes` in `shopify.app.toml` and running `shopify app
  deploy --allow-updates` is NOT enough on its own** — confirmed live this session
  (added `read_themes` to read the live Horizon theme's own markup): the token kept
  coming back without the new scope after deploy, contrary to the shopify.dev docs'
  claim that "if your app acts only on stores in your own organization, you approve
  that change yourself when you release the version." In practice, for this app (a
  custom app using the client_credentials grant, installed via Settings → Apps and
  sales channels → Develop apps), no approval banner ever appeared there either. The
  fix that actually worked: **uninstall and reinstall the same app entry** from Develop
  apps — this reruns the full scope-consent screen (approve all scopes shown) and
  actually grants the new one, confirmed via a fresh `client_credentials` token
  afterward. Doesn't regenerate `client_id`/`client_secret` (same app entry, not a new
  one) and doesn't affect the live Cloud Run service or widget at all, since neither
  touches the Admin API at runtime — safe to do anytime investigation needs a new scope.
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

## Native cart switch — "Add to cart" no longer creates its own Storefront cart

Found live this session: the chat's "Add to cart" button created a real cart via the
Storefront GraphQL Cart API (`cartCreate`/`cartLinesAdd`), entirely separate from the
one the theme's own cart drawer/checkout reads (the classic `cart` cookie + `/cart.js`
AJAX API). Genuinely never showed up in the store's own cart panel — not a regression,
that's how it was built from the start. Fixed by switching to the theme's native
`/cart/add.js` for every add, and reworking every cart-aware feature to learn about that
cart from the client instead of fetching it server-side (the backend has no browser
session into the shopper's native cart — it never did, and can't get one).

**The mechanics**: `public/widget.js`'s `addProductToCart` now calls `/cart/add.js`
directly (numeric variant id, converted from the `gid://shopify/ProductVariant/<id>`
form everywhere else in this app uses — `nativeVariantId()`). After any add, or on every
page load, `syncCartFromTheme()` reads `/cart.js` (real `variant_id`/`quantity`/
`line_price`/`item_count`/`total_price`/`token` — confirmed via Shopify's own Ajax Cart
API reference, not guessed) and reports it to a new `POST /api/chat/event` case,
`cart_synced`. The backend resolves each variant id to real product data (handle, title,
`pairs_with`) via a new `resolveCartLineProducts()` in `shopify.ts` (Storefront API
`nodes(ids:)` on `ProductVariant`) and stores the result on `session.cart`
(`ClientReportedCart` in `types.ts`) — the same shape `complete_the_kit`,
`cart_left_behind`, `comparison_stall`'s cart-empty check, and the free-shipping
guardrail all already reasoned from, just sourced differently now. The `/event` response
for `cart_synced` hands back this resolved cart so the widget's order-summary card
renders from Shopify's own real titles, not from parsing `/cart.js`'s own field names
(some of which — `product_title`/`variant_title` as separate fields — weren't
confirmable from docs, so the code deliberately doesn't depend on them).

**`create_cart` (Gemini adding to cart via a typed "add this to my cart" message)** no
longer executes a mutation server-side either — it still resolves real SKU → variant id
(genuine ground truth, `resolveVariantIdBySku`, unchanged), but hands the result back as
`pendingCartAdds` on `MiaTurnResult`/the `/api/chat/message` response instead of calling
a Storefront mutation. The widget performs the actual `/cart/add.js` call for those after
appending Mia's reply, then syncs — landing in the exact same native cart the button
uses. This closes a second, related bug found while investigating: before this, a
chat-typed add never showed an order-summary card at all (`/api/chat/message`'s response
never carried cart data anywhere), which looked like "the cart card is missing" even
though a real cart genuinely existed server-side.

**What this removed, deliberately**: `addToCart`/`getCart`/`attachDemoDeliveryAddress`/
`updateCartBuyerIdentity`/`CartState`/`CartHandoff`/`CartSnapshot` and `ChatSession.cartId`/
`customerAccessToken` are all gone — nothing in the app calls them anymore. `get_checkout`
now just reads `session.cart` directly (already resolved) instead of a fresh Shopify
fetch, and its `checkoutUrl` is now the static real `/checkout` (the theme's own entry
point) rather than a per-cart URL, since there's no separate Storefront-API cart object
to link to.

**The one real regression, confirmed, not just theoretical**: the demo login's real
address prefill (`cartBuyerIdentityUpdate` + a saved customer address, built specifically
to work around the documented autofill bug noted elsewhere in this file) was wired to the
backend's own Storefront-API cart. There is no equivalent client-side way to attach that
same identity to the theme's native cart/checkout — its identity comes only from the
shopper being genuinely logged into a real Shopify customer account in their browser, a
separate authentication flow this app doesn't drive. So logging in as the demo customer
in chat still personalizes everything Mia says (Bloomreach `firstName` write,
`identityTier`, the "Hi, X 👋" greeting) — none of that touched the cart and all of it
still works — but checkout through the (now-native) cart shows blank address fields
again, same as any real guest checkout. Accepted tradeoff, confirmed with the user before
making the change; don't try to "fix" this by re-adding a second, separate cart for the
demo flow — that's exactly the kind of split that caused the two bugs this section fixes
in the first place.

**A real, separate client-side bug found and fixed in the same pass**: a fast
double-click/double-tap on a quick-reply chip could fire `sendMessage()` twice before the
first click's request even started clearing the chip row, producing one customer bubble
but two identical agent replies once both requests resolved (reported live as "I got a
second identical message"). Fixed with a synchronous chip-clear on click (before
`sendMessage`'s own async work starts) plus a `sendInFlight` guard inside `sendMessage`
itself covering every other call path into it.

**The fetch-patch above only ever caught some real cart mutations, not all of
them** — reported live as the order-summary card only updating after a reload
or page navigation, never on the same page right after a real native add.
Couldn't confirm exactly why against the live theme's own component
internals (no browser access to inspect it directly), so rather than keep
guessing at Horizon's exact cart-add implementation, added a reliable,
theme-agnostic backstop: `startCartPolling()` (`widget.js`) calls
`syncCartFromTheme()` on a plain 4s interval once a session exists, alongside
the existing signal poll. This doesn't care how the cart changed, only that
it did. Made cheap via a new dedup in `syncCartFromTheme()` itself
(`lastCartSnapshotKey`, a `token:item_count:total_price` string) — an
unchanged cart never gets past the local `/cart.js` GET, so no redundant
`cart_synced` POST, no repeated Storefront resolve, no repeated Bloomreach
write on every tick. The key only commits after the round trip actually
succeeds, so a failed POST retries on the next tick instead of silently
believing an update landed that didn't. The fetch-patch itself was kept as a
fast, no-latency path for whatever it does catch — harmless now that the
poll is the real guarantee, not a redundant cost source.

## Pinned to exactly one instance — don't remove this

`chat_router.ts`'s `sessions` Map is in-memory only, in one Node process — there is no
database behind it. This service is deployed with **`--min-instances=1
--max-instances=1`** (always include both flags on every future deploy, they don't
persist from the service config unless explicitly passed on `gcloud run deploy` again —
confirmed a plain `gcloud run deploy` without them can reset scaling to defaults).
Without `minScale=1`, Cloud Run scales to zero after a few idle minutes and the next
request cold-starts a brand-new container with an empty session Map — every open chat
silently vanishes, which is exactly what happened for real once already this project
(reported as "the chat clears out after a while" and later "the message call returns a
404"). Without `maxScale=1`, concurrent requests from the *same* visitor could land on
*different* instances, each with its own separate session state — same failure, subtler
trigger. Given the app's actual traffic (a single hackathon demo, not real concurrent
load), pinning to one always-on instance is the correct fix for this architecture, not
a workaround — don't "optimize" it back to autoscaling without adding real session
persistence (Bloomreach, a database, anything durable) first.

**This does not make sessions survive a redeploy.** A new revision means a brand new
container — any deploy (even one that only changes scaling flags, confirmed: running
`gcloud run services update --min-instances=1 --max-instances=1` alone created a new
revision and wiped every session that existed the moment traffic cut over) resets every
open chat. That's an accepted, known-in-advance event under our control, unlike the
random cold-start case above — but warn whoever's testing live before deploying while
they're mid-session, and don't deploy silently mid-demo.

**The widget itself now recovers gracefully from a dead session** either way (see
`public/widget.js`'s `resetSession`/404-handling in `performSignalCheck` and
`sendMessage`) — a `/message` or `/signal-check` call against a sessionId the server no
longer recognizes used to silently pop open an empty, message-less chat panel or drop
the customer's own typed message with no response at all; it now quietly re-establishes
a fresh session in the background (and resends the message once, for `sendMessage`)
instead. It cannot recover the lost conversation history itself — only real persistence
would do that — but it stops looking broken.

## Four widget/session-state bugs found and fixed live this session

**Order-summary card never learned about a real native cart change.** The
card only ever resynced after the widget's own two add paths (its
product-card button, or `pendingCartAdds` from a typed message) —
adding/removing/changing quantity through the theme's *own* PDP "Add to
cart" button or cart drawer told it nothing, so the card looked stale or
never appeared even though the real cart genuinely changed (reported live as
"the checkout panel is still not updated"). Fixed by patching `window.fetch`
in `widget.js` to detect any POST to Shopify's real Ajax Cart API
(`/cart/add(.js)`, `/cart/change.js`, `/cart/update.js`, `/cart/clear.js`)
and calling `syncCartFromTheme()` afterward, regardless of which theme
markup/custom element triggered it — this is the one place that reliably
sees every real mutation without depending on a theme-specific event. It's
intentionally redundant with the widget's own explicit `syncCartFromTheme()`
calls after its two flows (an extra resync is harmless, just one more
`/cart.js` read).

**Quick-reply chips never survived a page reload.** A real storefront
reloads the whole page on every navigation, wiping the widget's DOM —
`ensureSession()`'s history replay correctly rebuilt every past bubble/
product card, but chips were never part of `ChatTurn` at all, so the last
turn's real options silently vanished on the very next page (reported live
as "the suggested reply options disappear after reopening the bot"). Fixed
by adding `chips?: string[]` to `ChatTurn` (`types.ts`), persisting
`response.reply.chips` on every agent turn pushed in both `/message` and
`/signal-check` (`chat.ts`), and having the widget's history-replay loop
track and re-render the last agent turn's chips via `renderQuickReplies`.

**A stale-but-still-genuinely-open chat was being treated as explicitly
closed.** `ensureSession()`'s reopen check compared `getStoredOpenState()`
against a `REOPEN_STALE_MS` window off the last real turn's timestamp — a
sensible guard against resurrecting a conversation abandoned days ago, but
it also *wrote* `setStoredOpenState(false)` whenever that single read
happened to land past the threshold, permanently downgrading a shopper's
real "I still have this open" intent into "closed" for the rest of the
visit (surfaced live as "switching pages is treated as closing it"). The
recency check alone already fully guards against reviving an ancient
conversation — it's re-derived fresh from the real last-turn timestamp on
every single page load, so nothing was actually gained by also writing the
flag. Fixed by removing that write entirely (the flag now only ever changes
to closed from an actual close-button click) and raising `REOPEN_STALE_MS`
from 2 minutes to 10, matching `comparison_stall`'s own window — the
longest gap this app's triggers already expect between two real actions in
the same browsing session.

**Two different triggers could fire back-to-back within seconds of each
other.** `runExclusive` (chat.ts) already serializes every turn per session,
and `triggersFiredThisSession` already stops the *same* trigger firing
twice, so no two Gemini calls ever ran concurrently or double-fired one
trigger — but nothing stopped two genuinely *different* triggers (e.g. the
background poll finding `cart_left_behind` right as an event-triggered
recheck from an out-of-stock size click finds `availability_block`) from
each independently deciding to speak, producing two proactor messages
seconds apart. Fixed with a new quiet-gap in `evaluateSignalCase`
(`signals.ts`): `SessionBehavior.lastProactiveSpokeAt` is stamped whenever a
proactive (signal-driven, no customer message) turn actually speaks, and any
proactive evaluation within `MIN_PROACTIVE_SPEAK_GAP_MS` (15s) of that
defers to `hold_back` regardless of which trigger would otherwise fire — the
deferred trigger isn't consumed or marked fired, it's simply re-evaluated
fresh (and usually fires normally) on the next check a few seconds later.
Deliberately scoped to proactive turns only (`isProactive` param, `true`
when `runMiaTurn`'s `latestMessage` is `undefined`) — a direct reply to
something the shopper just typed must never be delayed by this.

## cart_left_behind fired but Gemini inconsistently held back anyway

Found live via the admin panel: the rule layer correctly detected a real
`cart_left_behind` (cart modified, idle past `CART_IDLE_MS`, checkout never
started) and sent it to Gemini, but Gemini sometimes chose `stay_closed`
anyway when the shopper had moved on to browsing a different product in the
meantime. Root cause was in the prompt, not the rule or the data: the
`HOW YOU DECIDE` section of `SYSTEM_PROMPT` (`gemini.ts`) enumerated exactly
three valid `open_chat` reasons (`availability_block`, `complete_the_kit`,
`comparison_stall` — described generically, not by trigger name) and never
mentioned cart abandonment at all, while its `stay_closed` list said "when
the shopper is simply browsing" with no exception for an abandoned cart. A
shopper who added something and wandered to another product genuinely *is*
browsing, so Gemini had no explicit instruction telling it that reading
doesn't apply when a real `cart_left_behind` signal case is present — an
honest ambiguity, not a one-off mistake, so it went either way from one
check to the next.

Fixed by adding `cart_left_behind` as an explicit 4th `open_chat` condition
("the cart has sat idle past the threshold... even if the shopper has since
moved on to browsing something else... never a reason to treat a
cart_left_behind signal case as 'just browsing'") and narrowing the
`stay_closed` browsing condition to "browsing with nothing in the cart".
Verified live with two full end-to-end reproductions (real cart add via
`cart_synced`, a real ~95s wait past `CART_IDLE_MS`, simulating a page move
to a different product, then a deliberate signal-check) — one against the
already-live prompt (happened to land on `open_chat` anyway, illustrating
the non-determinism rather than disproving the bug) and one against the
fixed prompt (`open_chat`, confidence `high`, no ambiguity in the reasoning
this time). Since this is a prompt-level fix for an LLM's judgment call, not
a deterministic code fix, it raises the odds rather than guaranteeing the
outcome every single time — that's expected, not a sign the fix didn't take.

## The context block never actually contained the real cart

Found live via the admin panel right after the fix above: with the decision
ambiguity gone, `cart_left_behind` now fired `open_chat` consistently, but
every single reply's `readAs` said things like `"Without knowing the cart
contents, there is no specific blocker to address"` — six declines in a row,
all citing the same reason. Root cause: `buildContextBlock` (`gemini.ts`)
never included `session.cart` at all. The server has always fully resolved
it (real product titles, via `resolveCartLineProducts`) and used it for
`cartValue`/`cartNonEmpty`/guardrails/`complete_the_kit`'s pairs_with
matching — but never actually put it in the JSON block Gemini reads, so for
a proactive turn (no tool-calling phase, see the latency note above) Gemini
had no way to know what was in the cart at all, only the generic
`cart_last_modified_Xs_ago` evidence in `SIGNAL_CASE`. Fixed by adding a
`CART: session.cart ?? null` field, plus a line in `FACTS` clarifying that
`CART`/`CANDIDATES`/`pageProduct` are equally real, already-verified Shopify
data — not something to treat as less trustworthy than a tool result, and
not something to claim not to know when populated. Verified live end to end,
including specifically **off a PDP entirely** (no `productHandle`, no
`pageProduct` at all) — the reply correctly named the exact cart item and
its variant ("the Northbound Speed Trail Runner in size 7") from `CART`
alone, ruling out the alternative explanation that it was just reading the
current page's product instead of the actual cart.

## Chips silently went empty on some replies, even ones ending in a question

Found in the same live test: after the cart_left_behind reply above, the
shopper picked "Yes, how do they fit?" and Mia's follow-up ("What size do
you usually wear?") came back with zero quick-reply chips — a real,
separate bug, not a rendering issue (the widget's history-replay/chip fixes
from earlier this session were unrelated; this was the model's own JSON
output). Root cause: `chips` was a required schema field but the prose
`SYSTEM_PROMPT` never actually instructed Mia to use it — nothing told her
that ending a message with a question obligates her to also populate
`chips` with real answers to it, so the schema requirement alone wasn't
enough to make her do it every time. Fixed with a new bullet in `HOW YOU
SPEAK`: whenever a message asks a question, `chips` must hold 2-4 concrete
answers to that exact question (real sizes via `check_stock` if asking about
sizing, yes/no if asking yes/no), never left empty and never a generic
filler unrelated to what was just asked. Verified live: the same "what size
do you usually wear" follow-up now returns real chips
(`["Yes, usually a 7", "I'm between 7 and 7.5", "No, it varies"]`).

## Pacing — a product suggestion should not take more than ~2 messages

Requested directly (not a live bug find): conversations were allowed to drag
— nothing in `HOW YOU SPEAK` said how quickly Mia should get to naming an
actual product versus asking clarifying questions first. Added a bullet:
get to a concrete suggestion (a shown product, a recommended size, or a
named complement) within the first two messages, with a stated exception for
a genuine sizing/fit conversation (`size_guide_reopened`, or discussing what
layer goes underneath) where working through fit first is expected, not
stalling. This sits above the pre-existing "never more than four messages
before a cart is offered" rule — a different, later checkpoint that was left
unchanged. Verified live: an open-ended "I need a jacket for autumn hiking,
it rains a lot" got real product cards and sizing chips on the very first
reply; a `size_guide_reopened` case still discusses fit/layering by name
before asking for a size, unaffected.

## Testing as a known customer, and Bloomreach visibility in the admin panel

**`anna-k`** (see the "Anna K." section above) is real and live on Bloomreach
right now — confirmed via `list_customers`/`get_customer_properties`
(project `dusty-waffle`, internal `_id: 6ab51e4b1de6ed660966499b`). To browse
the storefront as her: open any page once with `?ctb_customer=anna-k` in the
URL — the widget persists it to `localStorage["chat-to-buy-visitor-id"]`, so
every later session on that browser presents `customerId: "anna-k"` and
`identityTier` resolves to `known` from a real Bloomreach read. To find any
other test customer yourself: `list_cloud_organizations` → `list_projects`
(`dusty-waffle`) → `list_customers` with a `query` for the id/cookie →
`get_customer_properties` with the returned `_id`. `list_customer_events`
(same `_id`) shows the real event history, most recent first.

**Bloomreach reads/writes were previously invisible in the admin panel** —
asked directly, and the honest answer at the time was no. Added: `TurnLog`
now carries `profile` (the real `session.profile` snapshot the decision was
actually made with — answers "did the known-identity read reach Mia") and
`bloomreachWrites` (every real attempted write this turn: the tool loop's own
`log_event` calls plus the phase B `writeBack`, each with `success`/`failed`
and the real error message on failure). `admin.html` renders both under a new
"Bloomreach" section per entry, plus a summary-row badge — green
`Bloomreach ×N` when every write succeeded, red `Bloomreach write failed`
when any didn't. A real, separate bug surfaced by wiring this up: `log_event`
had no `try/catch` around its `recordEvent` call at all — a Bloomreach
failure there didn't just go unlogged, it threw and crashed the *entire
turn* (bubbling up through the tool loop to a 500), since nothing caught it
before this fix. Both `log_event` and the phase B `writeBack` (`chat.ts`) now
wrap their write in try/catch and record success or failure either way,
instead of the previous bare `.catch(() => {})` that made a failure and "no
write happened" indistinguishable everywhere, panel included.

**Verified fully live, round-trip**: sent "Actually I usually wear a Medium
now, not Large" as `anna-k`, confirmed the admin panel showed two real writes
this turn (`log_event: size_updated {new_size: "M"}` and
`write_back: update_profile {}`, both `failed: false`), then independently
confirmed via `list_customer_events` that both landed on the real Bloomreach
customer with matching timestamps and properties — the panel's claim and
Bloomreach's own event history agree.

**Real gap found in the same test, not yet fixed**: Mia said "I'll remember
to look for a Medium from now on," but `usual_size_top` on the real
Bloomreach profile is still `"L"` — confirmed via `get_customer_properties`
right after. `log_event`/`writeBack` can only ever write an Engagement
*event* (`trackEvent`), never a durable *customer property*
(`writeCustomerProperties`/`updateCustomerProfile`, the mechanism `/login`
uses) — there is currently no tool that lets Mia update a property Bloomreach
will still remember next session, only ones that log a historical event
about the change. So the size update is genuinely recorded (visible in
`list_customer_events` forever), but `get_customer_context`'s own profile
read next session will still say "L", contradicting what Mia told the
shopper. Flagged live, then fixed on request with a 7th tool, distinct from
`log_event` rather than folding into it (a clean split: one tool for "this
happened once", one for "this is still true going forward").

## 7th tool: `update_customer_profile` — a real, durable Bloomreach write

New tool in `MIA_TOOLS` (`gemini.ts`), fields `usual_size_top`/
`usual_size_shoe`/`top_category`/`consent` — only send the ones that
genuinely changed. Handler calls the real `updateCustomerProfile`
(`writeCustomerProperties`/`trackEvent`'s Track API, the same mechanism
`/login` already used) — a real push to the live customer, not a local-only
change — and also updates `session.profile` in-memory immediately, so the
rest of *that* conversation reflects the correction without waiting on a
fresh Bloomreach read. Wrapped in try/catch like `log_event`, logged into
`bloomreachWrites` as `source: "update_customer_profile"` either way. Added a
line to `WHO YOU ARE TALKING TO` telling Mia when to use this over
`log_event`, and corrected `log_event`'s own tool description (it previously
said to use it for "any attribute you've just learned," which was the
misleading root cause — `log_event` genuinely cannot make that durable).

**Verified live, full round trip, on the real `anna-k` customer**: told Mia
"I usually wear a Medium now" → `bloomreachWrites` showed
`update_customer_profile {usualSizeTop: "Medium"}` → confirmed via
`get_customer_properties` that `usual_size_top` was genuinely now `"Medium"`
with a fresh `last_update` timestamp (not just an event in her history this
time). Then told Mia "actually set it back to L" → confirmed it read back
`"L"` again — restored to the profile documented in the "Anna K." section
above, since her profile is meant to stay a stable, reusable baseline across
sessions. One loose end, fixed on request: the model wrote `"Medium"` the
first time and the literal `"L"` the second — no canonical size format was
enforced, just whatever fit the sentence.

**Fixed with real `enum` constraints** on `update_customer_profile`'s
`usual_size_top` (`["S","M","L","XL"]`) and `usual_size_shoe`
(`["7","8","9","10","11","12"]`, matching the real range across the
footwear catalog) — Gemini's function-calling schema supports `enum` on a
string parameter the same way `responseSchema` does, so the model is
constrained to the catalog's own vocabulary rather than free text. Also
added a line to the tool description telling it to convert the shopper's own
wording (“a medium”, “a nine”) into that vocabulary rather than passing
through what they said verbatim. Verified live: "I actually wear a medium
now, and my shoe size is a nine" wrote exactly `{usualSizeTop: "M",
usualSizeShoe: "9"}` — confirmed via a real Bloomreach read after. This
also durably added `usual_size_shoe` to Anna K.'s real profile for the first
time (previously undocumented/unset) — anticipated already by this file's
own "Anna K." note ("extend her profile as later scenarios need more, e.g.
usualSizeShoe") — left in place rather than cleared.

**A separate, real, minor honesty gap found in the same test, not fixed**:
asked Mia to also "forget the shoe size" — she confidently replied "I've
cleared out the shoe size," but a Bloomreach read right after showed it was
still `"9"`. Neither the tool schema (only accepts a value from the enum,
never null) nor Bloomreach's property-write API here really models "unset a
property" — so the tool silently no-ops on a clear request while Mia
narrates success anyway. Left as-is (a real shopper asking to have a
preference *forgotten* rather than *corrected* is an edge case, and this
was tangential to the vocabulary fix actually requested) — worth knowing if
it comes up live.

## Mia claimed "I've added it to your cart" when nothing was ever added

Found live via the admin panel on a real customer session: after a short
"The Ember Fleece" reply, Mia said "Great choice, I've added the Ember
Fleece in XL to your cart" — the widget screenshot showed no chip-driven add
in progress, and the store's own cart drawer confirmed the item was never
actually there. The admin log for that exact turn showed
`pendingCartAddsCount: 0` — `create_cart` never resolved a real variant (or
was never called) — yet the reply confidently claimed success, and worse,
`writeBack` recorded a fabricated `added_to_cart` event that had already
been written to the real customer's Bloomreach profile before this fix, a
permanent false conversion signal, not just a wrong sentence in chat.

**Root cause**: nothing validated `reply.text`'s prose claim, or
`writeBack.event`, against the one real signal that a cart add was actually
attempted — `pendingCartAdds.length` from this turn's `create_cart` tool
call. `enforceGuardrails` already validated `show`/`recommendSizes`/
`addToCart`/`openCheckout`/the free-shipping offer against ground truth, but
had no cart-add check at all, and — separately discovered while fixing this
— its own `violations` return value was computed but never used anywhere,
not even logged, so this class of bug had no visibility path even in the
admin panel built specifically for troubleshooting.

**Fixed with three changes**:
1. `GroundTruth` (`guardrails.ts`) gained `pendingCartAddsCount`. A new check
   drops `writeBack` entirely (rewrites to `{event: "", properties: {}}`,
   logged as a violation) whenever its event name matches an add-to-cart
   pattern (`/add(ed)?[_-]?to[_-]?cart|cart[_-]?updated/i`) but
   `pendingCartAddsCount === 0` this turn — this is the one deliberately
   scoped to a *structured* field (`writeBack.event`), not `reply.text`
   itself, since free text can't be reliably rewritten by a guardrail
   without another LLM call; the Bloomreach write is also the more
   permanent, damaging half of the two, so it's the one worth blocking hard.
2. Reinforced `FACTS` in `SYSTEM_PROMPT`: never claim an add succeeded
   unless `create_cart` returned real pending items this turn, report its
   error honestly if it didn't, and the add itself happens in the shopper's
   browser after the reply is sent, not by Mia directly.
3. `violations` is now threaded all the way through — `MiaTurnResult` →
   `TurnLog` → `admin.html`, with a summary-row `guardrail caught N` badge
   and a full list per entry. This is a real, general-purpose fix: *any*
   future guardrail violation (not just this one) is now visible per turn,
   which the panel had no way to show before despite already computing it.

**Also fixed in the same pass**: `replyText`/`chips` in `recordTurnLog` were
gated on bare `spoke` (`decision.action === "open_chat"`), but a direct
message reply is shown to the customer regardless of `action` — `/message`
returns `reply.text` unconditionally. This hid the real reply text for every
"continue"-action direct turn, which is most of them, including the exact
turn with the false cart claim — it was only visible via a screenshot, not
in the log meant to show it. Now gated on `!isProactive || spoke`, the
actual condition for whether a reply was shown.

**Verified**: live conversation reproduction confirmed a legitimate
create_cart failure (asking for a nonexistent XXL) is now handled honestly
with no violation. Since Gemini's original hallucination can't be forced on
command, the guardrail logic itself was unit-tested directly
(`enforceGuardrails` called with a hand-built response matching the exact
observed bug): a fabricated `added_to_cart` writeBack with
`pendingCartAddsCount: 0` is caught and scrubbed, while the identical
writeBack with `pendingCartAddsCount: 1` (a genuine add) survives untouched
— confirming the fix targets the real bug without breaking the real case.

## comparison_stall was mathematically unreachable in small categories

Asked directly: how many real baselayer products exist, since the trigger
seemed to only ever fire per-category. Checked live via `searchCatalog`
rather than trusting memory: `baselayer` has exactly 2 products (Summit Wool,
Featherline), `midlayer` has 1 (Ember Fleece), `pants` has 2 (Traverse
Hiking, Squall Rain) — `jacket`(7)/`footwear`(8+)/`accessory`(8+) are all
comfortably above the threshold. `COMPARISON_STALL_MIN_PRODUCTS` was a flat
`3` for every category, which made the trigger genuinely impossible to fire
in baselayer or pants no matter how thoroughly a shopper compared the two
real options that exist there — not "hasn't stalled long enough yet," a hard
ceiling with no path to ever crossing it.

Fixed with `COMPARISON_STALL_MIN_PRODUCTS_BY_CATEGORY` (`signals.ts`): an
explicit override map (`{baselayer: 2, midlayer: 2, pants: 2}`), falling back
to the original `3` for every other category. Deliberately not a global
lowering to 2 — jackets/footwear/accessories have enough real products that
2 views isn't yet a genuine stall, only the categories where 3 is literally
unreachable get the lower bar. Also fixed the evidence text, which
previously hardcoded "requires 3+" regardless of which threshold actually
applied — now reports the real number for that category. `signals.ts` has no
live catalog access (by design — a cheap, pure, session-data-only layer), so
this is a small static map matching the catalog's actual real shape rather
than a live per-request category-count lookup; revisit if the catalog's
category sizes change materially. Verified live: viewing both real baselayer
products now correctly fires `comparison_stall` ("going back and forth
between the Summit Wool and the Featherline… weight, price, or
waterproofing?") — previously impossible with only 2 real products to view.

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

# Admin/reasoning log panel (public/admin.html)

A troubleshooting and demo tool, served by the same Cloud Run service as the
widget/storefront (`https://.../admin.html`) — not a separate app/deploy.
Shows every real turn's actual reasoning, `hold_back` included: which Tier
1/2 trigger's rule matched (if any), the full evidence/`alsoTrue`/
`quietRulesInForce` trail from `evaluateSignalCase`, and Mia's real decision
(`action`/`readAs`/`confidence`/`rejected`/`offer`) from Gemini — this is
exactly what demonstrates a scenario like "the rule fired but the model
chose not to interrupt," not just the messages a shopper actually saw.

**Two distinct "held back" states, both worth showing separately** — don't
collapse them into one badge: (1) `signalCase.trigger === "hold_back"` means
no Tier 1/2 condition matched at all (nothing to decide on); (2) a *real*
trigger matched (`signalCase.trigger` is e.g. `availability_block`) but
Gemini's own `decision.action` came back `"stay_closed"` — the rule opened
the question, the model declined it, with its own stated `readAs`/`rejected`
reasoning. `admin.html` flags this second case explicitly ("rule fired, held
back") since it's the more interesting one for testing/demoing hold-back
behavior.

**Implementation**: `src/services/telemetry.ts` is a bounded in-memory ring
buffer (`MAX_LOGS = 500`, same lifetime as the session store — a
demo/troubleshooting aid, not a real audit log needing to survive a
restart). `runMiaTurn` (`chat.ts`) calls `recordTurnLog(...)` after *every*
turn, proactive or direct-message, spoke or not — logging only the spoken
ones would defeat the whole point. Two new routes, `GET /api/chat/admin/
sessions` (a live snapshot of the in-memory `sessions` Map) and `GET
/api/chat/admin/logs` (optionally filtered by `sessionId`), both gated by
`requireAdminToken` — a shared-secret check (`ADMIN_PANEL_TOKEN` in `.env`,
new `config.adminPanel.token`, unrelated to `config.shopify.adminToken`,
a completely different Shopify credential despite the similar name) via an
`x-admin-token` header or `?token=` query param. Gated because this exposes
internal reasoning and session-level profile data on the same public
`*.run.app` URL the storefront widget calls — not something every visitor
should be able to load. If `ADMIN_PANEL_TOKEN` is unset, both routes 503
rather than silently running open.

`admin.html` is a single self-contained page (inline CSS/JS, no build step,
consistent with `widget.js` living directly in `public/`) — same-origin
fetches to `/api/chat/admin/*` (unlike `widget.js`, which is cross-origin
from the Shopify storefront and needs the CORS config in `server.ts`), a
token field persisted to `localStorage` (or passed as `?token=` once), a
session list to filter by, and an auto-refreshing (4s) log feed with
expandable `<details>` entries per turn. Remember to add `ADMIN_PANEL_TOKEN`
to the `cloudrun-env.yaml` regeneration step before deploying (it already is
— that script reads every `.env` key generically) or the deployed panel will
503.

**Watching the panel live surfaced two more real issues, both fixed:**

1. **The background poll was the actual driver of Gemini call volume, not
   just log volume.** The widget polls `/signal-check` for as long as any tab
   stays open, and — before this fix — *every* tick made a real Gemini Phase B
   call, even when `evaluateSignalCase` itself found nothing
   (`trigger: "hold_back"`). Confirmed live: a real such call took 7+ seconds
   and, as expected from the system prompt's own design ("a rule opens the
   question, you decide"), never once returned anything but `stay_closed` —
   Gemini has no evidence beyond what the rule layer already looked for, so
   it can't legitimately override a bare hold_back with a reason of its own.
   Fixed in `chatWithMia` (`gemini.ts`): a proactive check (`latestMessage`
   undefined) with `signalCase.trigger === "hold_back"` now returns a
   synthetic `stay_closed` response immediately, no request sent — confirmed
   live, an 8ms round trip instead of ~7s. A genuine trigger match (any
   `signalCase.trigger` other than `hold_back`) always still calls Gemini in
   full, and so does every direct customer message — nothing demo-relevant
   lost. `chat.ts`'s `runMiaTurn` also skips `recordTurnLog` for this exact
   skipped case (computed from the same `isProactive`/`trigger` check, no new
   flag needed) — a poll that found nothing and never even asked Gemini isn't
   a decision worth showing, and was the actual source of the "logs every
   second" clutter reported live. The widget's own poll interval
   (`startSignalPolling`, `widget.js`) was also widened from 9s to 20s on top
   of this — no Tier 1/2 threshold needs sub-20s granularity (90s cart idle,
   10min comparison window), so this mainly cuts raw request volume for a tab
   left open a long time, not responsiveness.

2. **Log cards visually compressed as more accumulated — a real flexbox bug,
   not a rendering illusion.** `.log-entry` in `admin.html` is a flex child of
   `#logs` (`display:flex; flex-direction:column; overflow-y:auto`) and
   itself has `overflow:hidden` (for the rounded-corner clip on its
   `<summary>`). That combination collapses the item's effective
   `min-height` to `0` in Flexbox's sizing algorithm, so once accumulated
   entries overflow the viewport, the browser's default `flex-shrink`
   squeezes every card progressively shorter instead of the container simply
   scrolling — worse the more piled up, exactly matching what was reported
   live. Fixed with an explicit `flex-shrink: 0` on `.log-entry`. Worth
   remembering for any other flex-column-plus-overflow-hidden-child layout
   added to this panel later.

3. **The skip above went too far — it also silenced genuinely useful
   partial-evidence hold_backs**, e.g. opening the size guide once (below
   `SIZE_GUIDE_REOPEN_THRESHOLD`) produced *nothing* in the log at all,
   reported live as "now it looks like it is not logging anything." The real
   distinction isn't "did Gemini get called" — it's "did this check have a
   specific reason behind it, or was it just the timer." `checkSignal`'s
   existing `bypassOpenGate` flag (`widget.js`) already captured exactly that
   split (true for an event-triggered recheck or a launcher click, false for
   the plain interval poll), so it's threaded straight through as `deliberate`
   in the `/signal-check` request body, into `runMiaTurn`
   (`chat.ts`), no new client-side concept needed. Logging condition is now
   `!skippedGemini || deliberate`: a routine poll finding nothing still stays
   silent (no repeat spam just because time passed — confirmed live, a second
   routine poll right after logging nothing produced no new entry), but a
   deliberate check always logs even when it lands on hold_back — confirmed
   live opening a size guide once now logs `"a size guide was opened, but not
   enough times yet to fire"` at 0ms (still no Gemini call), and opening it a
   second time crosses the threshold and logs a real ~9s Gemini-backed
   `size_guide_reopened` entry right after it.

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
