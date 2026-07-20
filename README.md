# nym-anon-rpc-worker

[![ci](https://github.com/voltrevo/poc-nym-anon-rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/voltrevo/poc-nym-anon-rpc/actions/workflows/ci.yml)

An [anon-rpc](https://github.com/privacy-ethereum/anon-rpc) conforming worker
(anon-client, SPEC §3.2) that fulfils `fetch` calls over the **Nym mixnet**,
using [`@nymproject/mix-fetch`](https://www.npmjs.com/package/@nymproject/mix-fetch) v2
(the smolmix WASM stack).

The wallet/host runs this worker's hash-pinned bundle inside an anon-rpc
harness (e.g. `@anon-rpc/browser-harness`); every `worker.fetch()` the host
issues is carried through the mixnet and egresses at a Nym IP Packet Router
(IPR), so no single gateway learns "who asks for what".

```
wallet ── AnonRpcWorker.fetch() ──▶ harness sandbox (null-origin iframe ▸ Web Worker)
                                      └─ this bundle: acceptCall loop
                                          └─ @nymproject/mix-fetch → @nymproject/mix-tunnel
                                              └─ nested Worker (blob: URL)
                                                  └─ smolmix WASM: Sphinx + smoltcp + TLS
                                                      └─ WebSocket ⇒ Nym gateway ⇒ mixnet ⇒ IPR ⇒ RPC endpoint
```

## Why mix-fetch and not raw `@nymproject/sdk`

`@nymproject/sdk` (`createNymMixnetClient`) exposes raw mixnet messaging:
send/receive bytes to a Nym address. Turning that into HTTP requires an
exit-side counterpart (network requester / IPR) and a full client-side
HTTP-over-mixnet protocol — exactly what Nym already packages as
**mix-fetch v2**: `mixFetch(url, init)` is a drop-in `fetch` that returns a
real `Response`. The v2 stack (`mix-fetch → mix-tunnel → smolmix-wasm`) ships
as a single self-contained ESM chunk (WASM + nested worker inlined as base64,
zero runtime deps), which is ideal for anon-rpc's single-file, hash-pinned
artifact model.

## Layout

| File | Role |
| --- | --- |
| `src/spec-types.ts` | Worker-facing spec types (§7–§13), deliberately a copy per spec convention |
| `src/nym-anon-client.ts` | Core: accept loop, tunnel lifecycle, request/response conversion. Dependency-injected (no Nym imports) so it unit-tests in Node |
| `src/worker-main.ts` | Entry point: wires `anonRpcWorker` + real `mix-fetch` into the core |
| `build.mjs` | esbuild → `dist/nym-anon-rpc-worker.js` (single IIFE, the §4 artifact) and prints its keccak256 `workerHash` |
| `test/` | Unit tests against fakes + a smoke test that boots the built bundle in Node |

## Published specifier (Ethereum mainnet)

This worker is published per SPEC §4: a
[`WorkerSpecifier`](https://github.com/privacy-ethereum/anon-rpc/blob/main/impl/specifier/src/WorkerSpecifier.sol)
contract pins the bundle's keccak256 and points at a resolver that serves the
bytes (the [`keccak` branch](https://github.com/voltrevo/poc-nym-anon-rpc/tree/keccak)
of this repo — content-addressed, so the URL is immutable).

| | |
| --- | --- |
| specifier | [`0xfCc24f66E2F8bdF17537f2b117c80707219e91AD`](https://etherscan.io/address/0xfCc24f66E2F8bdF17537f2b117c80707219e91AD) (source verified on [Sourcify](https://repo.sourcify.dev/1/0xfCc24f66E2F8bdF17537f2b117c80707219e91AD)) |
| workerHash | `0x9cfb7effc56217ef03929c4ba1cae8d1733edc338457161a76534d831fcbc49f` |
| resolver | [raw.githubusercontent.com/voltrevo/poc-nym-anon-rpc/keccak/9c/fb7eff…](https://raw.githubusercontent.com/voltrevo/poc-nym-anon-rpc/keccak/9c/fb7effc56217ef03929c4ba1cae8d1733edc338457161a76534d831fcbc49f) |
| built from | [`e66dda5`](https://github.com/voltrevo/poc-nym-anon-rpc/commit/e66dda5) with the locked deps — `@nymproject/mix-fetch` 2.0.0, `@nymproject/mix-tunnel` 0.1.0, `fake-indexeddb` 6.2.5, `esbuild` 0.24.2. The build is deterministic: `npm ci && npm run build` reproduces the pinned hash (CI does, every run). |

```js
const worker = new AnonRpcWorker({
  address: "0xfCc24f66E2F8bdF17537f2b117c80707219e91AD",
  preExisting: { rpcProvider },
});
```

### Try it in the anon-rpc demo

Paste the specifier address into the balance-watcher demo at
**<https://privacy-ethereum.github.io/anon-rpc/demo/>** and hit *Start
watching* — the harness reads the specifier on-chain, fetches this bundle
from the resolver, verifies its keccak256, and polls a balance through the
mixnet.

Expect mixnet weather: tunnel setup can take anywhere from ~15 s to a couple
of minutes (failed attempts are retried with backoff), and the first query or
two on a cold tunnel sometimes fail with a transient
`hyper error: connection closed before message completed` — the demo keeps
polling every 12 s and recovers on its own. Give it ~2 minutes before
concluding anything is wrong.

## Build & test

```sh
npm install
npm run typecheck
npm run build     # dist/nym-anon-rpc-worker.js (~12.8 MiB) + keccak256 workerHash
npm test          # node --test: conversion, accept loop, retry, abort, bundle smoke
```

## Behaviour

- **Boot**: starts the `acceptCall` loop immediately (the harness buffers
  host calls regardless), and starts mixnet tunnel setup in the background
  with exponential-backoff retries (capped at 30 s). `signalReady()` fires
  only once the tunnel is actually up — the host's `ready` promise means
  "anonymous fetch works now".
- **Fetch calls**: `AnonRequestInit` → `RequestInit` (streaming bodies are
  buffered; `AbortSignal` is stripped because it cannot structured-clone
  across mix-tunnel's Comlink boundary — aborts are honoured worker-side by
  failing the call), then `mixFetch(url, init)`, then `Response` →
  `AnonFetchResponse` (ordered header pairs, buffered `Uint8Array` body,
  final URL).
- **Tunnel down**: a call that rides a failing setup attempt fails with the
  real error; the next call (and the boot loop) trigger a fresh attempt.
- **Unknown call kinds**: ignored, per §8.
- **Configuration**: optional. If the host writes UTF-8 JSON to storage key
  `nym/setup-opts` (worker-scoped, §11) before boot, it is passed to
  `setupMixTunnel` as `SetupMixTunnelOpts` — e.g. `preferredIpr` (pin the
  exit), `disableCoverTraffic`, `connectTimeoutMs`, `debug`.
- **Ethereum RPC** (§3.2): satisfied via general web request access — any
  `https://` RPC endpoint works through `mixFetch`.

## e2e: verified against the live mixnet

`npm run test:e2e` drives headless Chromium with the real
`@anon-rpc/browser-harness`: a mock specifier pins this bundle's keccak256
hash (the §4 integrity path runs for real), the harness boots it in the
null-origin sandbox, and the test asserts `eth_blockNumber` + `eth_chainId`
round-trip through the **live Nym mainnet mixnet** to a public Ethereum RPC.
Verified green 2026-07-20. Observed timings: tunnel ready ~15 s, first RPC
~3.3–4.9 s, warm RPC ~1.0 s.

Because the live network has weather (the hourly epoch rollover rebuilds the
active node set, and runs straddling it fail inside smolmix with "mixing
layer does not have any valid nodes"), the e2e is **gated**: it first checks
directory health and epoch position, re-checks up to 3× a minute apart, and
SKIPs with a clear marker rather than failing on network conditions.

Granular probes (each isolates one failure domain):

| Script | Needs | Checks |
| --- | --- | --- |
| `test/e2e/probe-network.mjs` | network only | epoch position, active mixnode/gateway counts |
| `test/e2e/probe-sandbox.mjs` | browser only | nested Worker, WASM, IndexedDB state, WebSocket to a real gateway from `Origin: null`, CORS on the directory API |
| `test/e2e/probe-idb.mjs` | browser only | the exact IndexedDB failure mode in the sandbox |
| `test/e2e/run-e2e.mjs` | browser + live mixnet | the full §4→§9 path with real RPC |

## Findings from the e2e (formerly open risks)

1. **Nested Workers: works.** Chromium spawns mix-tunnel's WASM worker from a
   `blob:` URL inside the sandboxed anon-rpc worker. (Safari remains
   untested.)
2. **IndexedDB: denied, now shimmed.** In the null-origin sandbox
   `indexedDB` exists but `open()` throws a synchronous `SecurityError`, and
   smolmix fails tunnel setup on it (`storage error: … Version cannot be
   zero`) instead of degrading. Fix: `src/tunnel-worker-patch.ts` wraps
   `URL.createObjectURL` so `src/idb-prelude.ts` (bundled to text at build
   time) is prepended to the tunnel worker's blob; it probes IDB and, when
   denied, installs an in-memory implementation (`fake-indexeddb`),
   including the `IDBDatabase`/`IDBRequest` classes the wasm-bindgen glue
   `instanceof`-checks. Consequence: the Nym client identity is ephemeral
   per boot — privacy-fine for an anon-client.
3. **CORS / null origin: works.** The Nym directory API serves
   `Access-Control-Allow-Origin: *`, and gateways accept WebSocket upgrades
   with `Origin: null`.
4. **Ambient API usage.** SPEC §3.2 says a worker SHOULD minimise ambient
   APIs. This worker needs `Worker`, `WebAssembly`, `Blob`,
   `URL.createObjectURL`, `WebSocket`, `fetch`, `crypto.getRandomValues` —
   i.e. it runs on browser-like harnesses only, not on a hypothetical
   minimal native harness (which would want a KPS-based client instead).
5. **KPS is unused.** Anonymity comes from the mixnet over WebSocket, which
   the spec permits (KPS is a capability, not an obligation). A future
   variant could tunnel gateway traffic over `anonRpcWorker.kps` to shed the
   WebSocket/CORS constraints — that needs a KPS↔gateway bridge peer to
   exist.
6. **Abort ≠ cancel.** Aborting a call fails it promptly at the worker, but
   the in-flight mixnet transfer runs to completion inside the WASM stack
   (mix-tunnel exposes no per-request cancellation).
7. **Bundle size.** ~12.9 MiB (inlined WASM). Hash-verification and boot cost
   are one-time per session; resolvers just need to serve a big file.
8. **`redirect: "manual" | "error"`.** Passed through to mixFetch, but
   smolmix follows redirects internally (`maxRedirects` tunnel option);
   per-request redirect modes may not be honoured. Treat as best-effort.
9. **Mixnet weather.** Tunnel setup can fail around hourly epoch rollovers;
   the worker's retry loop (capped exponential backoff) rides it out, and
   the e2e gates on directory health instead of flaking.
10. **Gateway identity livelock: fixed.** A failed setup attempt can leave
    its gateway WebSocket orphaned; retrying with the same stored identity
    is then refused ("There is already an open connection to this client")
    forever. Unless the host pins `clientId` in config, the worker now
    passes a fresh random `clientId` per setup attempt — smolmix namespaces
    its stored identity by it, so each retry registers cleanly. Ephemeral
    identity per attempt also suits the anon-client threat model.
11. **Not a secure context.** The sandbox's opaque origin means
    secure-context-only APIs (`crypto.randomUUID`, `crypto.subtle`, …) are
    absent; `crypto.getRandomValues` is the dependable primitive. Worth
    knowing for any future worker code.
