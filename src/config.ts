import "dotenv/config";

function required(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),

  bloomreach: {
    loomiConnectUrl: required("BLOOMREACH_LOOMI_CONNECT_URL"),
    apiBaseUrl: required("BLOOMREACH_API_BASE_URL", "https://api-engagement.bloomreach.com"),
    projectToken: required("BLOOMREACH_PROJECT_TOKEN"),
    apiToken: required("BLOOMREACH_API_TOKEN"),
    customerIdField: required("BLOOMREACH_CUSTOMER_ID_FIELD", "cookie"),
    webhookSecret: required("BLOOMREACH_WEBHOOK_SECRET"),
    // A Private-access API group's Key ID/Secret — structurally different from
    // apiToken (a Public group's single token, used for Track API writes).
    // Needed for the Customer API's Basic-auth-protected reads.
    privateKeyId: required("BLOOMREACH_API_PRIVATE_ID"),
    privateSecret: required("BLOOMREACH_API_PRIVATE_SECRET"),
  },

  google: {
    projectId: required("GOOGLE_PROJECT_ID"),
    geminiApiKey: required("GEMINI_API_KEY"),
    geminiModel: required("GEMINI_MODEL", "gemini-2.5-pro"),
  },

  shopify: {
    storeDomain: required("SHOPIFY_STORE_DOMAIN"),
    storefrontToken: required("SHOPIFY_STOREFRONT_API_TOKEN"),
    adminToken: required("SHOPIFY_ADMIN_API_TOKEN"),
    apiVersion: required("SHOPIFY_API_VERSION", "2026-01"),
  },
} as const;
