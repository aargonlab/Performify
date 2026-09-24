import type { Config } from "@react-router/dev/config";

// React Router >= 7.18.3 rejects action submissions whose `Origin` header does
// not match `request.url`. Behind a TLS-terminating proxy (the Shopify CLI
// tunnel in development, most hosting platforms in production) the app sees
// `http://<host>` while the browser sends `https://<host>`, so every action
// would fail with 400. Allow the app host explicitly (plus the CLI tunnel
// domain). Admin actions are also protected by Shopify session tokens.
const appHost = process.env.SHOPIFY_APP_URL
  ? new URL(process.env.SHOPIFY_APP_URL).host
  : null;

export default {
  ssr: true,
  allowedActionOrigins: [
    ...(appHost ? [appHost] : []),
    "*.trycloudflare.com",
  ],
} satisfies Config;
