// Boots the built §4 artifact (dist/nym-anon-rpc-worker.js) in Node against a
// stub `anonRpcWorker`. Node has no Web Worker global, so the mix-tunnel
// nested worker cannot spawn — the test asserts the bundle parses, starts its
// accept loop, retries tunnel setup, and does NOT signal ready prematurely.
// Run `npm run build` first; the test is skipped if the bundle is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const bundlePath = fileURLToPath(new URL("../dist/nym-anon-rpc-worker.js", import.meta.url));

const src = await readFile(bundlePath, "utf8").catch(() => undefined);

test("built bundle boots against a stub capability API", { skip: !src && "dist bundle not built" }, async () => {
  const logs = [];
  let readySignals = 0;
  let acceptCalls = 0;

  const anonRpcWorker = {
    signalReady: () => {
      readySignals += 1;
    },
    acceptCall: () => {
      acceptCalls += 1;
      return new Promise(() => {}); // never deliver a call
    },
    kps: {},
    storage: { get: async () => undefined },
    log: {
      debug: (...a) => logs.push(a),
      info: (...a) => logs.push(a),
      warn: (...a) => logs.push(a),
      error: (...a) => logs.push(a),
    },
  };

  const context = vm.createContext({
    anonRpcWorker,
    console,
    // unref'd timers: the worker's tunnel-retry loop schedules forever, and
    // referenced timers would keep the test process alive after the run.
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args).unref(),
    clearTimeout,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    TextEncoder,
    TextDecoder,
    URL,
    Blob,
    // deliberately no Worker: tunnel setup must fail gracefully, not crash the loop
  });
  context.globalThis = context;
  context.self = context;

  vm.runInContext(src, context, { filename: "nym-anon-rpc-worker.js" });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(acceptCalls, 1, "accept loop started at boot");
  assert.equal(readySignals, 0, "must not signal ready while the tunnel is down");
  assert.ok(
    logs.some((a) => String(a[0]).includes("tunnel setup failed")),
    `tunnel setup failure logged; got: ${JSON.stringify(logs)}`,
  );
});
