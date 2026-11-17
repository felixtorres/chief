import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pipeline tests drive real git repos and spawn the fake agents several times per test;
    // on a busy laptop that regularly takes longer than vitest's 5s default.
    testTimeout: 30_000,
  },
});
