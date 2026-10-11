import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The first test in a file that plans a route pays for building the
    // routing engine (decoding the 211k-edge graph, scoring every edge,
    // computing crash hotspots) - several seconds, more when many files
    // start at once. The 5 s default made the suite fail at random on
    // timing, not on answers.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
});
