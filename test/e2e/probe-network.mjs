// Granular probe 1 (no browser): is the live Nym directory healthy enough to
// build a route right now? Distinguishes "our stack is broken" from "the
// mixnet is unhealthy / mid-epoch-rollover" before any expensive browser run.

import { assessTopology } from "./topology.mjs";

const t = await assessTopology();
console.log(
  `epoch ${t.epochId}: ${Math.round(t.epochElapsedMs / 60000)}min in, ` +
    `${Math.round(t.epochRemainingMs / 60000)}min left`,
);
console.log(`active mixnodes: ${t.mixCount}; entry gateways: ${t.gwCount}`);
console.log(t.ok ? "✅ topology looks routable" : `❌ not routable: ${t.reason}`);
process.exit(t.ok ? 0 : 1);
