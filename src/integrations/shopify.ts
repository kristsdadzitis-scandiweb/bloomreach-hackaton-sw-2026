import { config } from "../config.js";
import type { CartHandoff, MiaCandidate } from "../types.js";

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

const CREATE_CART_MUTATION = `
  mutation CreateCart($lines: [CartLineInput!]!, $buyerIdentity: CartBuyerIdentityInput, $delivery: CartDeliveryInput) {
    cartCreate(input: { lines: $lines, buyerIdentity: $buyerIdentity, delivery: $delivery }) {
      cart {
        id
        checkoutUrl
        totalQuantity
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ADD_CART_DELIVERY_ADDRESS_MUTATION = `
  mutation AddDeliveryAddress($cartId: ID!, $addresses: [CartSelectableAddressInput!]!) {
    cartDeliveryAddressesAdd(cartId: $cartId, addresses: $addresses) {
      cart { id }
      userErrors { field message }
    }
  }
`;

interface AddDeliveryAddressData {
  cartDeliveryAddressesAdd: { cart: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> };
}

/** Retroactively attaches the demo shipping address — used when login happens after a cart already exists. */
export async function attachDemoDeliveryAddress(cartId: string): Promise<void> {
  if (!config.shopify.storeDomain) return;
  await storefrontRequest<AddDeliveryAddressData>(ADD_CART_DELIVERY_ADDRESS_MUTATION, {
    cartId,
    addresses: [{ selected: true, oneTimeUse: false, address: { deliveryAddress: DEMO_DELIVERY_ADDRESS } }],
  });
}

const ADD_CART_LINES_MUTATION = `
  mutation AddCartLines($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart {
        id
        checkoutUrl
        totalQuantity
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_CART_BUYER_IDENTITY_MUTATION = `
  mutation UpdateBuyerIdentity($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
    cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
      cart { id checkoutUrl totalQuantity }
      userErrors { field message }
    }
  }
`;

interface UpdateBuyerIdentityData {
  cartBuyerIdentityUpdate: CartResult;
}

/**
 * Attaches (or clears, passing undefined) the logged-in customer's identity on
 * an already-created cart — used when the customer logs in/out mid-session,
 * after a cart already exists, so switching the toggle visibly changes who
 * checkout will recognize.
 */
export async function updateCartBuyerIdentity(cartId: string, customerAccessToken: string | undefined): Promise<void> {
  if (!config.shopify.storeDomain) return;
  await storefrontRequest<UpdateBuyerIdentityData>(UPDATE_CART_BUYER_IDENTITY_MUTATION, {
    cartId,
    buyerIdentity: { customerAccessToken: customerAccessToken ?? null },
  });
}

interface CartResult {
  cart: { id: string; checkoutUrl: string; totalQuantity: number } | null;
  userErrors: Array<{ field: string[]; message: string }>;
}

interface CreateCartData {
  cartCreate: CartResult;
}

interface AddCartLinesData {
  cartLinesAdd: CartResult;
}

export interface CartState extends CartHandoff {
  cartId: string;
  totalQuantity: number;
}

/**
 * Add items to the customer's cart for this session — creates it on the first
 * add, appends lines to the existing cart (so repeated "Add to cart" clicks
 * build up one real cart) on every add after that.
 */
export async function addToCart(
  existingCartId: string | undefined,
  lineItems: Array<{ variantId: string; quantity: number }>,
  customerAccessToken?: string,
): Promise<CartState> {
  if (!config.shopify.storeDomain) {
    return {
      cartId: existingCartId ?? "mock-cart",
      checkoutUrl: "https://example-dev-store.myshopify.com/cart/mock-checkout",
      lineItems,
      totalQuantity: lineItems.reduce((sum, item) => sum + item.quantity, 0),
    };
  }

  const lines = lineItems.map((item) => ({
    quantity: item.quantity,
    merchandiseId: item.variantId.startsWith("gid://")
      ? item.variantId
      : `gid://shopify/ProductVariant/${item.variantId}`,
  }));

  const { cart, userErrors } = existingCartId
    ? (await storefrontRequest<AddCartLinesData>(ADD_CART_LINES_MUTATION, { cartId: existingCartId, lines }))
        .cartLinesAdd
    : (
        await storefrontRequest<CreateCartData>(CREATE_CART_MUTATION, {
          lines,
          buyerIdentity: customerAccessToken ? { customerAccessToken } : undefined,
          // Only the demo login gets a pre-filled address — a real guest
          // checkout should still look like a normal empty checkout.
          delivery: customerAccessToken
            ? { addresses: [{ selected: true, oneTimeUse: false, address: { deliveryAddress: DEMO_DELIVERY_ADDRESS } }] }
            : undefined,
        })
      ).cartCreate;

  if (userErrors.length > 0) {
    throw new Error(`Cart update failed: ${userErrors.map((e) => e.message).join(", ")}`);
  }
  if (!cart) {
    throw new Error("Cart update failed: no cart returned");
  }

  return { cartId: cart.id, checkoutUrl: cart.checkoutUrl, lineItems, totalQuantity: cart.totalQuantity };
}

const GET_CART_QUERY = `
  query GetCart($cartId: ID!) {
    cart(id: $cartId) {
      checkoutUrl
      totalQuantity
      lines(first: 20) {
        nodes {
          merchandise {
            ... on ProductVariant {
              product {
                handle
                pairsWithMeta: metafield(namespace: "$app", key: "pairs_with") {
                  references(first: 5) { nodes { ... on Product { handle } } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface GetCartData {
  cart: {
    checkoutUrl: string;
    totalQuantity: number;
    lines: {
      nodes: Array<{
        merchandise: {
          product?: {
            handle: string;
            pairsWithMeta: { references: { nodes: Array<{ handle: string }> } } | null;
          };
        };
      }>;
    };
  } | null;
}

export interface CartSnapshot {
  checkoutUrl: string;
  totalQuantity: number;
  /** Real product handles already in the cart — the complete_the_kit trigger's "not yet in cart" check. */
  lineHandles: string[];
  /**
   * Handles of cart items that themselves have a real pairs_with complement
   * missing from the cart — i.e. exactly the id search_catalog's own
   * `pairs_with` filter expects ("Product id to find real complements for
   * that specific product"), not the missing complement's own handle. The
   * model already knows how to turn this into the actual complement
   * candidate via that tool; this only needs to say which cart item has one.
   */
  unmatchedPairsWith: string[];
}

/**
 * Re-fetches an existing cart's current state — used to restore the cart bar
 * after a page navigation, and to compute the complete_the_kit trigger's
 * real "cart item pairs with X, X isn't in the cart yet" evidence. The cart
 * itself lives on in Shopify regardless of page reloads; only the widget's
 * in-memory knowledge of it was ever lost.
 */
export async function getCart(cartId: string): Promise<CartSnapshot | null> {
  if (!config.shopify.storeDomain) return null;
  const data = await storefrontRequest<GetCartData>(GET_CART_QUERY, { cartId });
  if (!data.cart) return null;

  const lineHandles = data.cart.lines.nodes.map((n) => n.merchandise.product?.handle).filter((h): h is string => Boolean(h));
  const lineHandleSet = new Set(lineHandles);
  const unmatchedPairsWith = [
    ...new Set(
      data.cart.lines.nodes
        .filter((n) => {
          const complements = n.merchandise.product?.pairsWithMeta?.references.nodes ?? [];
          return complements.some((ref) => !lineHandleSet.has(ref.handle));
        })
        .map((n) => n.merchandise.product?.handle)
        .filter((h): h is string => Boolean(h)),
    ),
  ];

  return { checkoutUrl: data.cart.checkoutUrl, totalQuantity: data.cart.totalQuantity, lineHandles, unmatchedPairsWith };
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

/** Resolves a real Shopify variantId from a merchant SKU — create_cart works by SKU per the playbook, addToCart by variantId internally. */
export async function resolveVariantIdBySku(sku: string): Promise<string | null> {
  if (!config.shopify.storeDomain) return null;
  const data = await storefrontRequest<{ products: { nodes: Array<{ variants: { nodes: Array<{ id: string; sku: string }> } }> } }>(
    `query BySku($query: String!) { products(first: 5, query: $query) { nodes { variants(first: 20) { nodes { id sku } } } } }`,
    { query: `sku:'${sku}'` },
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
