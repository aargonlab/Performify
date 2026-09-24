import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/helpers/setup.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // Integration tests share one Postgres/Redis: avoid cross-file races
    fileParallelism: false,
  },
});
