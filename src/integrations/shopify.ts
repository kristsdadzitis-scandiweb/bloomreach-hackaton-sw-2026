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
  query SearchProducts($query: String!, $first: Int!, $sortKey: ProductSortKeys!) {
    products(query: $query, first: $first, sortKey: $sortKey) {
      nodes {
        handle
        title
        productType
        availableForSale
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
      priceRange: { minVariantPrice: { amount: string; currencyCode: string } };
      variants: { nodes: Array<{ id: string }> };
    }>;
  };
}

const BROAD_QUERY_TERMS = /bestsell|best.sell|popular|trending|featured|recommend/i;

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

/** Ground a customer question in real catalog data. */
export async function searchProducts(query: string): Promise<ProductSummary[]> {
  if (!config.shopify.storeDomain) {
    return mockProducts(query);
  }

  if (!query.trim() || BROAD_QUERY_TERMS.test(query)) {
    return bestSelling();
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

const CREATE_CART_MUTATION = `
  mutation CreateCart($lines: [CartLineInput!]!) {
    cartCreate(input: { lines: $lines }) {
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
    : (await storefrontRequest<CreateCartData>(CREATE_CART_MUTATION, { lines })).cartCreate;

  if (userErrors.length > 0) {
    throw new Error(`Cart update failed: ${userErrors.map((e) => e.message).join(", ")}`);
  }
  if (!cart) {
    throw new Error("Cart update failed: no cart returned");
  }

  return { cartId: cart.id, checkoutUrl: cart.checkoutUrl, lineItems, totalQuantity: cart.totalQuantity };
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
