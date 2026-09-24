// ---------------------------------------------------------------------------
// Vitest setup file (runs before every test file, before any app import).
// Sets the same environment defaults docker-compose.test.yml provides, but
// ONLY when the variable is missing/empty, so host runs behave like Docker
// runs while explicit env vars always win.
// ---------------------------------------------------------------------------

const ENV_DEFAULTS: Record<string, string> = {
  SHOPIFY_API_KEY: "test-api-key",
  SHOPIFY_API_SECRET: "test-api-secret",
  SHOPIFY_APP_URL: "https://test-app.example.com",
  SCOPES: "read_content,read_locales,read_markets,read_products,read_themes",
  PSI_API_KEY: "test-psi-key",
  // Dedicated *_test database — NEVER the dev one: resetDb() truncates every
  // table, and pointing tests at the dev DB would wipe real local data.
  DATABASE_URL:
    "postgresql://performify:performify@localhost:5432/performify_test",
  REDIS_URL: "redis://localhost:6379",
};

for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
