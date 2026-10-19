import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ["tests/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      ALLOW_PRIVATE_HOSTS: "true",
      ALLOWED_HOSTS: "127.0.0.1,localhost",
      CLOUDSCRAPER_ENABLED: "false",
      CACHE_TTL_SECONDS: "30",
    },
  },
});
