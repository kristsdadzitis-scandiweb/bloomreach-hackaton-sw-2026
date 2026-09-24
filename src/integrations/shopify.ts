import { config } from "../config.js";
import type { CartHandoff } from "../types.js";

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

const PRODUCT_BY_HANDLE_QUERY = `
  query ProductByHandle($handle: String!) {
    product(handle: $handle) {
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
`;

interface ProductByHandleData {
  product: SearchProductsData["products"]["nodes"][number] | null;
}

/**
 * Resolves the real product a customer is currently looking at, by page
 * handle — unlike search, this doesn't filter out an out-of-stock product,
 * since the bot still needs to know what page it's on to answer questions.
 */
export async function getProductByHandle(handle: string): Promise<ProductSummary | null> {
  if (!config.shopify.storeDomain) {
    return null;
  }
  const data = await storefrontRequest<ProductByHandleData>(PRODUCT_BY_HANDLE_QUERY, { handle });
  const node = data.product;
  if (!node) return null;
  return {
    handle: node.handle,
    title: node.title,
    priceRange: `${node.priceRange.minVariantPrice.amount} ${node.priceRange.minVariantPrice.currencyCode}`,
    available: node.availableForSale,
    variantId: node.variants.nodes[0]?.id ?? "",
    image: node.featuredImage?.url,
  };
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
    }
  }
`;

interface GetCartData {
  cart: { checkoutUrl: string; totalQuantity: number } | null;
}

export interface CartSnapshot {
  checkoutUrl: string;
  totalQuantity: number;
}

/**
 * Re-fetches an existing cart's current state — used to restore the cart bar
 * after a page navigation. The cart itself lives on in Shopify regardless of
 * page reloads; only the widget's in-memory knowledge of it was ever lost.
 */
export async function getCart(cartId: string): Promise<CartSnapshot | null> {
  if (!config.shopify.storeDomain) return null;
  const data = await storefrontRequest<GetCartData>(GET_CART_QUERY, { cartId });
  if (!data.cart) return null;
  return { checkoutUrl: data.cart.checkoutUrl, totalQuantity: data.cart.totalQuantity };
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
