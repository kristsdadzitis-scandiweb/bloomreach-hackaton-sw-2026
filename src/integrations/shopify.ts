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
  query SearchProducts($query: String!, $first: Int!) {
    products(query: $query, first: $first) {
      nodes {
        handle
        title
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
      availableForSale: boolean;
      priceRange: { minVariantPrice: { amount: string; currencyCode: string } };
      variants: { nodes: Array<{ id: string }> };
    }>;
  };
}

/** Ground a customer question in real catalog data. */
export async function searchProducts(query: string): Promise<ProductSummary[]> {
  if (!config.shopify.storeDomain) {
    return mockProducts(query);
  }

  const data = await storefrontRequest<SearchProductsData>(SEARCH_PRODUCTS_QUERY, {
    query,
    first: 5,
  });

  return data.products.nodes.map((node) => ({
    handle: node.handle,
    title: node.title,
    priceRange: `${node.priceRange.minVariantPrice.amount} ${node.priceRange.minVariantPrice.currencyCode}`,
    available: node.availableForSale,
    variantId: node.variants.nodes[0]?.id ?? "",
  }));
}

const CREATE_CART_MUTATION = `
  mutation CreateCart($lines: [CartLineInput!]!) {
    cartCreate(input: { lines: $lines }) {
      cart {
        id
        checkoutUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface CreateCartData {
  cartCreate: {
    cart: { id: string; checkoutUrl: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

/** Build the cart and hand back a checkout URL. */
export async function createCart(
  lineItems: Array<{ variantId: string; quantity: number }>,
): Promise<CartHandoff> {
  if (!config.shopify.storeDomain) {
    return { checkoutUrl: "https://example-dev-store.myshopify.com/cart/mock-checkout", lineItems };
  }

  const lines = lineItems.map((item) => ({
    quantity: item.quantity,
    merchandiseId: item.variantId.startsWith("gid://")
      ? item.variantId
      : `gid://shopify/ProductVariant/${item.variantId}`,
  }));

  const data = await storefrontRequest<CreateCartData>(CREATE_CART_MUTATION, { lines });
  const { cart, userErrors } = data.cartCreate;

  if (userErrors.length > 0) {
    throw new Error(`Cart creation failed: ${userErrors.map((e) => e.message).join(", ")}`);
  }
  if (!cart) {
    throw new Error("Cart creation failed: no cart returned");
  }

  // Note: dev store checkout pages are password-protected — factor that into the demo.
  return { checkoutUrl: cart.checkoutUrl, lineItems };
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
