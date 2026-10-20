import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    silent: "passed-only",
    name: "bb-plugin-sketch",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 20_000,
    globalSetup: ["./vitest.global-tmpdir.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
