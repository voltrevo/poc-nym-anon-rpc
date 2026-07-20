// Bundles the DI'd core (no @nymproject imports) to ESM for node --test.

import { build } from "esbuild";

await build({
  entryPoints: ["src/nym-anon-client.ts"],
  outfile: "dist-test/nym-anon-client.mjs",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  logLevel: "warning",
});
