// Entry point of the Nym anon-client (the §3.2 conformance target).
//
// From the harness's point of view this is untrusted, hash-pinned code whose
// only guaranteed platform is the `anonRpcWorker` capability object (§7).
// This client additionally relies on the ambient Worker, WebAssembly, Blob,
// URL.createObjectURL, WebSocket and fetch of a browser-like worker scope:
// @nymproject/mix-tunnel spawns a nested Web Worker (from a blob: URL) that
// runs the smolmix WASM mixnet stack and connects to a Nym gateway over
// WebSocket. See README.md for the platform-support consequences.

import { setupMixTunnel, mixFetch } from "@nymproject/mix-fetch";
import preludeSource from "idb-prelude-source";
import { patchTunnelWorkerBlobs } from "./tunnel-worker-patch.js";
import { runNymWorker } from "./nym-anon-client.js";
import type { AnonRpcWorkerApi } from "./spec-types.js";

declare const anonRpcWorker: AnonRpcWorkerApi;

// Must precede the first tunnel setup: gives the nested WASM worker a
// working (in-memory) IndexedDB in sandboxes that deny the real one.
patchTunnelWorkerBlobs(preludeSource);

void runNymWorker(anonRpcWorker, {
  setupMixTunnel: setupMixTunnel as (opts?: Record<string, unknown>) => Promise<void>,
  mixFetch,
});
