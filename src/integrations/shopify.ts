import { config } from "../config.js";
import type { MiaCandidate, CartLineInfo, ClientReportedCart } from "../types.js";

/**
 * Shopify grounds the conversation in real stock/price, then builds the cart.
 * Calls the Storefront API (GraphQL) directly against the dev store.
 */

export interface ProductSummary {
  handle: string;
  title: string;
  priceRange: string;
  available: boolean;
  variantId: string;
  image?: string;
}

interface StorefrontResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function storefrontRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(
    `https://${config.shopify.storeDomain}/api/${config.shopify.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": config.shopify.storefrontToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  const body = (await res.json()) as StorefrontResponse<T>;
  if (body.errors?.length) {
    throw new Error(`Storefront API error: ${body.errors.map((e) => e.message).join(", ")}`);
  }
  if (!body.data) {
    throw new Error("Storefront API returned no data");
  }
  return body.data;
}

const SEARCH_PRODUCTS_QUERY = `
  query SearchProducts($query: String!, $first: Int!, $sortKey: ProductSortKeys!, $reverse: Boolean) {
    products(query: $query, first: $first, sortKey: $sortKey, reverse: $reverse) {
      nodes {
        handle
        title
        productType
        availableForSale
        featuredImage { url }
        priceRange {
          minVariantPrice { amount currencyCode }
        }
        variants(first: 1) {
          nodes { id }
        }
      }
    }
  }
`;

interface SearchProductsData {
  products: {
    nodes: Array<{
      handle: string;
      title: string;
      productType: string;
      availableForSale: boolean;
      featuredImage: { url: string } | null;
      priceRange: { minVariantPrice: { amount: string; currencyCode: string } };
      variants: { nodes: Array<{ id: string }> };
    }>;
  };
}

const BROAD_QUERY_TERMS = /bestsell|best.sell|popular|trending|featured|recommend/i;

// Shopify's product search does plain keyword matching — "cheap"/"cheaper"
// never appears in a product's own title/tags, so a query like "cheaper
// snowboard" matches zero products verbatim. Strip the price-intent word out
// and sort by real price instead of falling through to the unrelated
// bestseller fallback.
const CHEAP_TERMS = /\b(cheap(est|er)?|affordable|budget|inexpensive|low[\s-]?cost)\b/i;
const EXPENSIVE_TERMS = /\b(expensive|priciest|pricier|premium|luxury|top[\s-]?end)\b/i;

function toSummaries(nodes: SearchProductsData["products"]["nodes"]): ProductSummary[] {
  // Out-of-stock items can't be added to cart, so never surface them as an option.
  return nodes
    .filter((node) => node.availableForSale)
    .map((node) => ({
      handle: node.handle,
      title: node.title,
      priceRange: `${node.priceRange.minVariantPrice.amount} ${node.priceRange.minVariantPrice.currencyCode}`,
      available: node.availableForSale,
      variantId: node.variants.nodes[0]?.id ?? "",
      image: node.featuredImage?.url,
    }));
}

/**
 * Fetches a real, sales-ranked slice of the catalog — Shopify's actual
 * BEST_SELLING sort, not an invented list. Used both for genuine "bestsellers"
 * asks and as the fallback when a specific search comes up empty, so the
 * model always has real products to talk about instead of concluding a
 * category doesn't exist.
 */
async function bestSelling(): Promise<ProductSummary[]> {
  const data = await storefrontRequest<SearchProductsData>(SEARCH_PRODUCTS_QUERY, {
    query: "",
    first: 5,
    sortKey: "BEST_SELLING",
  });
  return toSummaries(data.products.nodes);
}

/** Real price order (ascending, or descending for "most expensive"-style asks). */
async function byPrice(query: string, reverse: boolean): Promise<ProductSummary[]> {
  const data = await storefrontRequest<SearchProductsData>(SEARCH_PRODUCTS_QUERY, {
    query,
    first: query ? 10 : 5,
    sortKey: "PRICE",
    reverse,
  });
  const nodes = data.products.nodes;
  if (!query) return toSummaries(nodes);

  // Sorting by PRICE loosens Shopify's own relevance filtering (e.g. a
  // "snowboard" search under PRICE sort can leak in a Gift Card) — keep only
  // results that actually match a real query word, falling back to the
  // unfiltered list only if that leaves nothing.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const onTopic = nodes.filter((n) => words.some((w) => n.title.toLowerCase().includes(w) || n.productType.toLowerCase().includes(w)));
  return toSummaries((onTopic.length > 0 ? onTopic : nodes).slice(0, 5));
}

/** Ground a customer question in real catalog data. */
export async function searchProducts(query: string): Promise<ProductSummary[]> {
  if (!config.shopify.storeDomain) {
    return mockProducts(query);
  }

  if (!query.trim() || BROAD_QUERY_TERMS.test(query)) {
    return bestSelling();
  }

  const isCheap = CHEAP_TERMS.test(query);
  const isExpensive = EXPENSIVE_TERMS.test(query);
  if (isCheap || isExpensive) {
    const strippedQuery = query.replace(CHEAP_TERMS, "").replace(EXPENSIVE_TERMS, "").trim();
    return byPrice(strippedQuery, isExpensive);
  }

  const data = await storefrontRequest<SearchProductsData>(SEARCH_PRODUCTS_QUERY, {
    query,
    first: 5,
    sortKey: "RELEVANCE",
  });
  const results = toSummaries(data.products.nodes);
  // Never dead-end on zero results — fall back to what's actually in stock so
  // the model can say "we don't have that specific thing, but here's what we
  // do have" instead of guessing or wrongly concluding the catalog is empty.
  return results.length > 0 ? results : bestSelling();
}

/**
 * Resolves the real product a customer is currently looking at, by page
 * handle, as a full MiaCandidate — sizes, stock, fit note, everything the
 * size-guide UI and Mia's own page-context awareness need. Unlike search,
 * this doesn't filter out an out-of-stock product, since the bot (and the
 * size guide) still need to know what page it's on regardless of stock.
 */
export async function getCandidateByHandle(handle: string): Promise<MiaCandidate | null> {
  if (!config.shopify.storeDomain) {
    return null;
  }
  const data = await storefrontRequest<{ product: CatalogNode | null }>(
    `query ProductByHandle($handle: String!) { product(handle: $handle) { ${CATALOG_NODE_FIELDS} } }`,
    { handle },
  );
  return data.product ? toMiaCandidate(data.product) : null;
}

/** Real product types/categories in the catalog — used to keep suggestions grounded. */
export async function listProductTypes(): Promise<string[]> {
  if (!config.shopify.storeDomain) {
    return [];
  }
  const data = await storefrontRequest<SearchProductsData>(SEARCH_PRODUCTS_QUERY, {
    query: "",
    first: 50,
    sortKey: "RELEVANCE",
  });
  return [...new Set(data.products.nodes.map((n) => n.productType).filter(Boolean))];
}

// Fixed demo shopper used to simulate a logged-in customer for the hackathon
// demo — a real Customer record in the dev store, not a live sign-up flow.
const DEMO_CUSTOMER_EMAIL = "demo-shopper@chat-to-buy.test";
const DEMO_CUSTOMER_PASSWORD = "Demo1234!";

// A generated shipping address for the demo customer, so a logged-in checkout
// only needs a payment method — never a real address, since this only ever
// attaches to the fixed demo account, not a real shopper.
const DEMO_DELIVERY_ADDRESS = {
  firstName: "Demo",
  lastName: "Shopper",
  address1: "123 Market Street",
  city: "Austin",
  provinceCode: "TX",
  zip: "78701",
  countryCode: "US",
  // Real Austin (512) area code + the 555 exchange's NANP-reserved fictional
  // line range (0100-0199) — "+1 555-555-0123" fails validation because 555
  // isn't a real area code, only a fictional exchange within a real one.
  phone: "+15125550123",
};

const CUSTOMER_LOGIN_MUTATION = `
  mutation Login($input: CustomerAccessTokenCreateInput!) {
    customerAccessTokenCreate(input: $input) {
      customerAccessToken { accessToken expiresAt }
      customerUserErrors { field message code }
    }
  }
`;

interface CustomerLoginData {
  customerAccessTokenCreate: {
    customerAccessToken: { accessToken: string; expiresAt: string } | null;
    customerUserErrors: Array<{ field: string[]; message: string; code: string }>;
  };
}

const CUSTOMER_PROFILE_QUERY = `
  query CustomerProfile($customerAccessToken: String!) {
    customer(customerAccessToken: $customerAccessToken) {
      firstName
      lastName
      email
      defaultAddress { id }
    }
  }
`;

interface CustomerProfileData {
  customer: { firstName: string; lastName: string; email: string; defaultAddress: { id: string } | null } | null;
}

const CREATE_CUSTOMER_ADDRESS_MUTATION = `
  mutation CreateCustomerAddress($customerAccessToken: String!, $address: MailingAddressInput!) {
    customerAddressCreate(customerAccessToken: $customerAccessToken, address: $address) {
      customerAddress { id }
      customerUserErrors { field message }
    }
  }
`;

interface CreateCustomerAddressData {
  customerAddressCreate: {
    customerAddress: { id: string } | null;
    customerUserErrors: Array<{ field: string[]; message: string }>;
  };
}

const SET_DEFAULT_ADDRESS_MUTATION = `
  mutation SetDefaultAddress($customerAccessToken: String!, $addressId: ID!) {
    customerDefaultAddressUpdate(customerAccessToken: $customerAccessToken, addressId: $addressId) {
      customerUserErrors { field message }
    }
  }
`;

/**
 * Checkout ignores the cart's own delivery.addresses once a real customer is
 * attached — it looks at that customer's saved address book instead. So the
 * demo customer needs an actual saved address, not just a cart-level one, or
 * checkout shows a blank "add address" form despite being "logged in".
 */
async function ensureDemoCustomerAddress(customerAccessToken: string): Promise<void> {
  const createData = await storefrontRequest<CreateCustomerAddressData>(CREATE_CUSTOMER_ADDRESS_MUTATION, {
    customerAccessToken,
    address: {
      firstName: DEMO_DELIVERY_ADDRESS.firstName,
      lastName: DEMO_DELIVERY_ADDRESS.lastName,
      address1: DEMO_DELIVERY_ADDRESS.address1,
      city: DEMO_DELIVERY_ADDRESS.city,
      province: "Texas",
      zip: DEMO_DELIVERY_ADDRESS.zip,
      country: "United States",
      phone: DEMO_DELIVERY_ADDRESS.phone,
    },
  });
  const addressId = createData.customerAddressCreate.customerAddress?.id;
  if (!addressId) return;

  await storefrontRequest(SET_DEFAULT_ADDRESS_MUTATION, { customerAccessToken, addressId });
}

export interface CustomerProfile {
  accessToken: string;
  firstName: string;
  lastName: string;
  email: string;
}

/** Logs in the fixed demo customer, simulating an authenticated shopper. */
export async function loginDemoCustomer(): Promise<CustomerProfile> {
  if (!config.shopify.storeDomain) {
    return { accessToken: "mock-token", firstName: "Demo", lastName: "Shopper", email: DEMO_CUSTOMER_EMAIL };
  }

  const loginData = await storefrontRequest<CustomerLoginData>(CUSTOMER_LOGIN_MUTATION, {
    input: { email: DEMO_CUSTOMER_EMAIL, password: DEMO_CUSTOMER_PASSWORD },
  });
  const { customerAccessToken, customerUserErrors } = loginData.customerAccessTokenCreate;
  if (customerUserErrors.length > 0 || !customerAccessToken) {
    throw new Error(`Demo customer login failed: ${customerUserErrors.map((e) => e.message).join(", ")}`);
  }

  const profileData = await storefrontRequest<CustomerProfileData>(CUSTOMER_PROFILE_QUERY, {
    customerAccessToken: customerAccessToken.accessToken,
  });
  if (!profileData.customer) {
    throw new Error("Demo customer login failed: no profile returned");
  }

  if (!profileData.customer.defaultAddress) {
    await ensureDemoCustomerAddress(customerAccessToken.accessToken);
  }

  const { firstName, lastName, email } = profileData.customer;
  return { accessToken: customerAccessToken.accessToken, firstName, lastName, email };
}

// Cart mutations (cartCreate/cartLinesAdd/cartBuyerIdentityUpdate) and the
// old getCart() used to live here — removed when "Add to cart" switched to
// the theme's own native `/cart/add.js` (see CLAUDE.md's "Native cart
// switch"). The backend has no browser session into that native cart, so it
// can't create or mutate it directly the way it could its own Storefront-API
// cart; resolveCartLineProducts below is the read-side replacement, fed by
// what the widget itself reports after reading `/cart.js`.

const CART_LINE_PRODUCTS_QUERY = `
  query CartLineProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        product {
          handle
          title
          productType
          pairsWithMeta: metafield(namespace: "$app", key: "pairs_with") {
            references(first: 5) { nodes { ... on Product { handle } } }
          }
        }
      }
    }
  }
`;

interface CartLineProductsData {
  nodes: Array<{
    id: string;
    title?: string;
    product?: {
      handle: string;
      title: string;
      productType?: string;
      pairsWithMeta: { references: { nodes: Array<{ handle: string }> } } | null;
    };
  } | null>;
}

/**
 * Categories whose real "Size" option value is genuinely a top/upper-body
 * size in this catalog's own S/M/L/XL vocabulary. Deliberately excludes
 * `apparel` (mixes tops like hoodies with bottoms like sweatpants/shorts —
 * no per-product top/bottom flag exists yet to tell them apart) and `pants`
 * (a real, distinct size axis with no CustomerProfile field of its own).
 * Revisit if the catalog/profile schema grows a bottoms-specific property.
 */
const TOP_SIZE_CATEGORIES = new Set(["jacket", "midlayer", "baselayer"]);
const TOP_SIZE_VALUES = new Set(["S", "M", "L", "XL"]);
const SHOE_SIZE_VALUES = new Set(["7", "8", "9", "10", "11", "12"]);

/**
 * Resolves real product data (handle, title, pairs_with) for cart lines the
 * widget read from the theme's own native `/cart.js` — that endpoint only
 * gives real Shopify *variant* ids, never fabricated data, but the backend
 * still needs the product side (handle/pairs_with) itself from Shopify
 * rather than trusting anything else about the product from the client.
 * Mirrors getCart()'s own unmatchedPairsWith logic, just fed from
 * client-reported variant ids instead of a Storefront Cart object, since
 * there's no cartId for a native cart the backend has no session into.
 */
export async function resolveCartLineProducts(
  lines: Array<{ variantId: string; quantity: number; lineTotal: number }>,
): Promise<{
  lines: CartLineInfo[];
  lineHandles: string[];
  unmatchedPairsWith: string[];
  sizeSignals: { usualSizeTop?: string; usualSizeShoe?: string };
}> {
  if (!config.shopify.storeDomain || lines.length === 0) {
    return { lines: [], lineHandles: [], unmatchedPairsWith: [], sizeSignals: {} };
  }

  const gids = lines.map((l) => (l.variantId.startsWith("gid://") ? l.variantId : `gid://shopify/ProductVariant/${l.variantId}`));
  const data = await storefrontRequest<CartLineProductsData>(CART_LINE_PRODUCTS_QUERY, { ids: gids });

  const resolved = lines.map((line, i) => {
    const node = data.nodes[i];
    return {
      variantTitle: node?.title ?? "Default Title",
      quantity: line.quantity,
      lineTotal: line.lineTotal,
      title: node?.product?.title ?? "Item",
      handle: node?.product?.handle,
      productType: node?.product?.productType,
      pairsWithHandles: node?.product?.pairsWithMeta?.references.nodes.map((r) => r.handle) ?? [],
    };
  });

  const lineHandles = resolved.map((r) => r.handle).filter((h): h is string => Boolean(h));
  const lineHandleSet = new Set(lineHandles);
  const unmatchedPairsWith = [
    ...new Set(
      resolved
        .filter((r) => r.pairsWithHandles.some((h) => !lineHandleSet.has(h)))
        .map((r) => r.handle)
        .filter((h): h is string => Boolean(h)),
    ),
  ];

  // A real, deterministic size signal from what's actually in the cart —
  // no chat message or LLM judgment call needed, unlike update_customer_profile.
  // Most Mia replies are chip-driven, so a shopper stating their size in free
  // text is rare; this is a far more reliable source of the same fact. Last
  // matching line wins (cart order mirrors add order), same "latest fact
  // overwrites the old one" spirit as a shopper correcting their own size.
  const sizeSignals: { usualSizeTop?: string; usualSizeShoe?: string } = {};
  for (const line of resolved) {
    if (!line.productType) continue;
    const size = line.variantTitle;
    if (TOP_SIZE_CATEGORIES.has(line.productType) && TOP_SIZE_VALUES.has(size)) {
      sizeSignals.usualSizeTop = size;
    } else if (line.productType === "footwear" && SHOE_SIZE_VALUES.has(size)) {
      sizeSignals.usualSizeShoe = size;
    }
  }

  return {
    lines: resolved.map(({ title, variantTitle, quantity, lineTotal, handle }) => ({ title, variantTitle, quantity, lineTotal, handle: handle ?? "" })),
    lineHandles,
    unmatchedPairsWith,
    sizeSignals,
  };
}

// --- Mia / Northbound catalog tools ---
// $app metafields carry display/reasoning-only attributes the Storefront
// query string can't filter on (insulation, weight_g, fit_note, pairs_with);
// tags carry anything search_catalog needs to filter at the query level
// (waterproof tier, layer) — see CLAUDE.md for why the split is this way.

const CATALOG_NODE_FIELDS = `
  handle
  title
  productType
  availableForSale
  featuredImage { url }
  priceRange { minVariantPrice { amount currencyCode } }
  waterproofMeta: metafield(namespace: "$app", key: "waterproof") { value }
  insulationMeta: metafield(namespace: "$app", key: "insulation") { value }
  weightGMeta: metafield(namespace: "$app", key: "weight_g") { value }
  fitNoteMeta: metafield(namespace: "$app", key: "fit_note") { value }
  layerMeta: metafield(namespace: "$app", key: "layer") { value }
  pairsWithMeta: metafield(namespace: "$app", key: "pairs_with") {
    references(first: 5) { nodes { ... on Product { handle } } }
  }
  variants(first: 20) {
    nodes { id sku quantityAvailable selectedOptions { name value } }
  }
`;

interface CatalogNode {
  handle: string;
  title: string;
  productType: string;
  availableForSale: boolean;
  featuredImage: { url: string } | null;
  priceRange: { minVariantPrice: { amount: string; currencyCode: string } };
  waterproofMeta: { value: string } | null;
  insulationMeta: { value: string } | null;
  weightGMeta: { value: string } | null;
  fitNoteMeta: { value: string } | null;
  layerMeta: { value: string } | null;
  pairsWithMeta: { references: { nodes: Array<{ handle: string }> } } | null;
  variants: {
    nodes: Array<{
      id: string;
      sku: string;
      quantityAvailable: number | null;
      selectedOptions: Array<{ name: string; value: string }>;
    }>;
  };
}

function toMiaCandidate(node: CatalogNode): MiaCandidate {
  const sizeOf = (v: CatalogNode["variants"]["nodes"][number]) => v.selectedOptions.find((o) => o.name.toLowerCase() === "size")?.value;

  const sizesInStock = node.variants.nodes
    .filter((v) => (v.quantityAvailable ?? 0) > 0)
    .map(sizeOf)
    .filter((v): v is string => Boolean(v));

  const stockBySize: Record<string, number> = {};
  const variantIdsBySize: Record<string, string> = {};
  for (const v of node.variants.nodes) {
    const size = sizeOf(v);
    if (!size) continue;
    stockBySize[size] = v.quantityAvailable ?? 0;
    variantIdsBySize[size] = v.id;
  }

  const firstVariant = node.variants.nodes[0];
  const available = node.variants.nodes.some((v) => (v.quantityAvailable ?? 0) > 0);

  return {
    id: node.handle,
    sku: firstVariant?.sku || node.handle,
    variantId: firstVariant?.id ?? "",
    name: node.title,
    category: node.productType,
    price: `${node.priceRange.minVariantPrice.amount} ${node.priceRange.minVariantPrice.currencyCode}`,
    available,
    sizesInStock,
    stockBySize,
    variantIdsBySize,
    waterproof: node.waterproofMeta?.value,
    insulation: node.insulationMeta?.value,
    weightG: node.weightGMeta?.value ? Number(node.weightGMeta.value) : undefined,
    fitNote: node.fitNoteMeta?.value,
    layer: node.layerMeta?.value,
    pairsWith: node.pairsWithMeta?.references.nodes.map((p) => p.handle),
    image: node.featuredImage?.url,
  };
}

const WATERPROOF_TIERS = ["none", "water-repellent", "10k", "20k", "28k"];

const SEARCH_CATALOG_QUERY = `
  query SearchCatalog($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      nodes { ${CATALOG_NODE_FIELDS} }
    }
  }
`;

interface SearchCatalogData {
  products: { nodes: CatalogNode[] };
}

export interface SearchCatalogFilters {
  category?: string;
  waterproofMin?: string;
  maxPrice?: number;
  maxWeightG?: number;
  size?: string;
  layer?: "base" | "mid" | "shell" | "bottom" | "footwear" | "accessory";
  pairsWith?: string;
}

/**
 * The search_catalog tool's real implementation. Filters that Storefront's
 * `query:` string supports (category/tag/price) run there; everything else
 * (weight, size-in-stock) is filtered in-process after real data comes back,
 * since Storefront can't filter on metafield values or variant options in
 * the query string itself.
 */
export async function searchCatalog(filters: SearchCatalogFilters): Promise<MiaCandidate[]> {
  if (filters.pairsWith) {
    return searchCatalogPairsWith(filters.pairsWith);
  }
  if (!config.shopify.storeDomain) return [];

  const clauses: string[] = [];
  if (filters.category) clauses.push(`product_type:'${filters.category}'`);
  if (filters.layer) clauses.push(`tag:'layer-${filters.layer}'`);
  if (filters.waterproofMin) {
    const minIndex = WATERPROOF_TIERS.indexOf(filters.waterproofMin);
    const qualifyingTiers = minIndex >= 0 ? WATERPROOF_TIERS.slice(minIndex) : [filters.waterproofMin];
    clauses.push(`(${qualifyingTiers.map((t) => `tag:'waterproof-${t}'`).join(" OR ")})`);
  }
  if (filters.maxPrice) clauses.push(`variants.price:<=${filters.maxPrice}`);

  const data = await storefrontRequest<SearchCatalogData>(SEARCH_CATALOG_QUERY, {
    query: clauses.join(" AND "),
    first: 20,
  });

  let candidates = data.products.nodes.filter((n) => n.availableForSale).map(toMiaCandidate);
  if (filters.maxWeightG) {
    candidates = candidates.filter((c) => c.weightG === undefined || c.weightG <= filters.maxWeightG!);
  }
  if (filters.size) {
    candidates = candidates.filter((c) => c.sizesInStock.includes(filters.size!));
  }
  return candidates.slice(0, 8);
}

/** "pairs_with: find complements for this product id" — reads the anchor's own real metafield, not a reverse search. */
async function searchCatalogPairsWith(productHandle: string): Promise<MiaCandidate[]> {
  const data = await storefrontRequest<{ product: CatalogNode | null }>(
    `query PairsWith($handle: String!) { product(handle: $handle) { ${CATALOG_NODE_FIELDS} } }`,
    { handle: productHandle },
  );
  const pairedHandles = data.product?.pairsWithMeta?.references.nodes.map((p) => p.handle) ?? [];
  if (pairedHandles.length === 0) return [];

  const results = await Promise.all(
    pairedHandles.map((handle) =>
      storefrontRequest<{ product: CatalogNode | null }>(
        `query PairedProduct($handle: String!) { product(handle: $handle) { ${CATALOG_NODE_FIELDS} } }`,
        { handle },
      ),
    ),
  );
  return results
    .map((r) => r.product)
    .filter((p): p is CatalogNode => Boolean(p) && p!.availableForSale)
    .map(toMiaCandidate);
}

const CHECK_STOCK_QUERY = `
  query CheckStock($query: String!) {
    products(first: 20, query: $query) {
      nodes {
        handle
        variants(first: 20) {
          nodes { sku quantityAvailable selectedOptions { name value } }
        }
      }
    }
  }
`;

/** The check_stock tool: real per-size stock counts for the given SKUs, from Shopify. */
export async function checkStock(skus: string[]): Promise<Record<string, Record<string, number>>> {
  if (!config.shopify.storeDomain || skus.length === 0) return {};

  const query = skus.map((sku) => `sku:'${sku}'`).join(" OR ");
  const data = await storefrontRequest<{ products: { nodes: Array<{ variants: CatalogNode["variants"] }> } }>(
    CHECK_STOCK_QUERY,
    { query },
  );

  const result: Record<string, Record<string, number>> = {};
  for (const product of data.products.nodes) {
    for (const variant of product.variants.nodes) {
      if (!skus.includes(variant.sku)) continue;
      const size = variant.selectedOptions.find((o) => o.name.toLowerCase() === "size")?.value ?? "default";
      result[variant.sku] = { ...(result[variant.sku] ?? {}), [size]: variant.quantityAvailable ?? 0 };
    }
  }
  return result;
}

/**
 * Resolves a real Shopify variantId from a merchant SKU — create_cart works
 * by SKU per the playbook, addToCart by variantId internally.
 *
 * Found live: the Storefront API's `products(query:)` search does NOT
 * support `sku:` as a filter key on this store — confirmed by testing
 * `sku:'<any real SKU>'`, `sku:'<garbage>'`, and an empty query string, all
 * three returning the exact same fixed 5 products (this store's original
 * seed, i.e. whatever a plain unfiltered query happens to return first) —
 * not an escaping/quoting issue, the filter term is silently ignored
 * entirely. Combined with the old `first: 5` cap, this meant SKU resolution
 * only ever "worked" for those original 5 products by coincidence, and
 * silently failed (no error, no exception, just a correct-looking `null`)
 * for every one of the 60 products added since — including ordinary,
 * in-stock items like the Trailhead Approach Shoe. The exact-match check
 * below was never the bug (it correctly refused to return a wrong product);
 * the bug was that the real product was never in the candidate set to begin
 * with. Fixed by not relying on server-side SKU filtering at all: fetch the
 * catalog unfiltered and match client-side, which is correct regardless of
 * what the search index supports. `first: 250` covers the full real catalog
 * (65 products) in one request — revisit with real cursor pagination if the
 * catalog ever grows past that.
 */
export async function resolveVariantIdBySku(sku: string): Promise<string | null> {
  if (!config.shopify.storeDomain) return null;
  const data = await storefrontRequest<{ products: { nodes: Array<{ variants: { nodes: Array<{ id: string; sku: string }> } }> } }>(
    `query AllSkus { products(first: 250) { nodes { variants(first: 20) { nodes { id sku } } } } }`,
    {},
  );
  for (const product of data.products.nodes) {
    const match = product.variants.nodes.find((v) => v.sku === sku);
    if (match) return match.id;
  }
  return null;
}

function mockProducts(query: string): ProductSummary[] {
  return [
    {
      handle: "mock-product-1",
      title: `Mock result for "${query}"`,
      priceRange: "$49.00",
      available: true,
      variantId: "gid://shopify/ProductVariant/0",
    },
  ];
}
