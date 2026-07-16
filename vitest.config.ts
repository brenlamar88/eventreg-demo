import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // One shared test database; tests isolate themselves by minting fresh orgs,
    // so files run sequentially to keep the connection/GUC story deterministic.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
