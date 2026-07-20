// End-to-end test: the built nym worker bundle, hash-pinned behind a mock
// specifier, loaded by the REAL @anon-rpc/browser-harness in headless
// Chromium, serving eth_blockNumber over the LIVE Nym mixnet.
//
// Pipeline (modeled on the anon-rpc reference impl/test/run-e2e.mjs):
//   1. build dist/nym-anon-rpc-worker.js
//   2. keccak-hash it and ABI-encode a mock specifier (workerHash() /
//      workerResolvers()) so the §4 integrity path runs for real
//   3. serve the page + harness bundle + worker bundle over local http
//   4. drive headless Chromium: new AnonRpcWorker(...), await ready
//      (= mixnet tunnel is up), POST a JSON-RPC eth_blockNumber to a public
//      Ethereum RPC through the mixnet, assert a well-formed result
//
// Run: npm run test:e2e            (or: node test/e2e/run-e2e.mjs)
// Env: RPC_URL to override the target endpoint;
//      READY_TIMEOUT_MS (default 180000) for slow mixnet days.

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { chromium } from "playwright";
import { build as esbuild } from "esbuild";
import { assessTopology } from "./topology.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../..", import.meta.url).pathname;

const RPC_URL = process.env.RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 180_000);
const WORKER_ADDR = "0xabc0000000000000000000000000000000000001";

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} });
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  cleanup();
  process.exit(1);
}

function check(label, ok, detail) {
  if (!ok) fail(`${label}${detail ? `\n   ${detail}` : ""}`);
  console.log(`  ✓ ${label}`);
}

/* --- minimal ABI encoders matching the harness's specifier decoders --- */

const enc = new TextEncoder();
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const selector = (sig) => "0x" + toHex(keccak_256(enc.encode(sig))).slice(0, 8);

function pad32(b) {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32 || 32);
  out.set(b);
  return out;
}
function word(n) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0; i--) { out[i] = n & 0xff; n = Math.floor(n / 256); }
  return out;
}
function concat(arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function encodeStringArray(strings) {
  const items = strings.map((s) => enc.encode(s));
  const heads = [];
  const tails = [];
  let tailOffset = items.length * 32;
  for (const item of items) {
    heads.push(word(tailOffset));
    const tail = concat([word(item.length), pad32(item)]);
    tails.push(tail);
    tailOffset += tail.length;
  }
  return concat([word(0x20), word(items.length), ...heads, ...tails]);
}

async function main() {
  // 0. gate on live directory health: a run started against a thin topology
  // or a fresh epoch rollover fails for network reasons, not code reasons.
  // Re-check a few times, then SKIP (exit 0) with a clear marker.
  for (let i = 0; ; i += 1) {
    let t;
    try {
      t = await assessTopology();
    } catch (e) {
      fail(`cannot reach the Nym directory API: ${e.message}`);
    }
    if (t.ok) {
      console.log(
        `topology gate: epoch ${t.epochId}, ${t.mixCount} mixnodes, ${t.gwCount} gateways — proceeding`,
      );
      break;
    }
    if (i >= 3) {
      console.log(`\n⏭ SKIPPED: ${t.reason} (live-network condition, not a code failure)`);
      cleanup();
      process.exit(0);
    }
    const waitMs = 60_000;
    console.log(`topology gate: ${t.reason}; re-checking in ${waitMs / 1000}s (${i + 1}/3)`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  // 1. build the worker bundle
  await run("npm", ["run", "build"], { cwd: ROOT });
  const workerBytes = new Uint8Array(await readFile(`${ROOT}dist/nym-anon-rpc-worker.js`));

  // 2. bundle the published harness entry the way a consumer's bundler would
  const bundled = await esbuild({
    entryPoints: [`${ROOT}node_modules/@anon-rpc/browser-harness/dist/host.js`],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "warning",
  });
  const hostBundle = bundled.outputFiles[0].contents;
  const pageHtml = await readFile(`${HERE}page.html`);

  // 3. local http server (CORS-open: the sandbox fetches from a null origin)
  const server = createServer((req, res) => {
    const url = req.url.split("?")[0];
    const send = (status, type, body) => {
      res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
      res.end(body);
    };
    if (url === "/") return send(200, "text/html", pageHtml);
    if (url === "/dist/host.js") return send(200, "text/javascript", hostBundle);
    if (url === "/dist/nym-anon-rpc-worker.js") return send(200, "text/javascript", workerBytes);
    send(404, "text/plain", "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`http server: ${origin}`);

  // mock specifier: address -> selector -> ABI-encoded return data
  const ethCallMap = {
    [WORKER_ADDR]: {
      [selector("workerHash()")]: "0x" + toHex(keccak_256(workerBytes)),
      [selector("workerResolvers()")]:
        "0x" + toHex(encodeStringArray([`${origin}/dist/nym-anon-rpc-worker.js`])),
    },
  };

  // 4. drive chromium
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  // full console history goes to a file too — terminal scrollback truncates
  const logFile = `${HERE}.last-run.log`;
  writeFileSync(logFile, `# e2e ${new Date().toISOString()}\n`);
  const logLine = (line) => {
    console.log(`  ${line}`);
    appendFileSync(logFile, `${line}\n`);
  };
  page.on("console", (m) => logLine(`[page:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logLine(`[page:error] ${e.message}`));

  await page.goto(`${origin}/`);
  await page.waitForFunction(() => "AnonRpcWorker" in window, null, { timeout: 5000 });

  console.log(`\nwaiting for mixnet tunnel (up to ${READY_TIMEOUT_MS / 1000}s)…`);
  const result = await page.evaluate(
    async (cfg) => {
      const provider = {
        request: async ({ method, params }) => {
          if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
          const ret = cfg.ethCallMap[params[0].to]?.[params[0].data.slice(0, 10)];
          if (!ret) throw new Error(`no mock eth_call for ${params[0].to}`);
          return ret;
        },
      };
      const w = new window.AnonRpcWorker({
        address: cfg.workerAddr,
        preExisting: { rpcProvider: provider },
      });

      // ready resolves only when the worker signalReady()s, i.e. the mixnet
      // tunnel is actually up.
      const t0 = performance.now();
      await Promise.race([
        w.ready,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`worker not ready after ${cfg.readyTimeoutMs}ms`)), cfg.readyTimeoutMs),
        ),
      ]);
      const readyMs = Math.round(performance.now() - t0);

      // read after ready: the harness has appended its sandboxed iframe by now
      const sandbox = document.querySelector("iframe")?.getAttribute("sandbox");

      // eth_blockNumber through the mixnet
      const t1 = performance.now();
      const resp = await w.fetch(cfg.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      const rpcMs = Math.round(performance.now() - t1);
      const status = resp.status;
      const json = await resp.json();

      // a second call on the warm tunnel
      const t2 = performance.now();
      const resp2 = await w.fetch(cfg.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] }),
      });
      const rpc2Ms = Math.round(performance.now() - t2);
      const json2 = await resp2.json();

      w.close();
      return { sandbox, readyMs, status, json, rpcMs, json2, rpc2Ms };
    },
    { ethCallMap, workerAddr: WORKER_ADDR, rpcUrl: RPC_URL, readyTimeoutMs: READY_TIMEOUT_MS },
  );

  console.log(`\ntunnel ready in ${result.readyMs / 1000}s;` +
    ` eth_blockNumber in ${result.rpcMs / 1000}s; eth_chainId in ${result.rpc2Ms / 1000}s`);
  console.log(`responses: ${JSON.stringify(result.json)} ${JSON.stringify(result.json2)}`);

  check("iframe sandbox is allow-scripts only (§6)", result.sandbox === "allow-scripts", result.sandbox);
  check("worker became ready (mixnet tunnel up)", typeof result.readyMs === "number");
  check("HTTP 200 from RPC endpoint via mixnet", result.status === 200, `status=${result.status}`);
  check(
    "eth_blockNumber returns a hex quantity",
    typeof result.json?.result === "string" && /^0x[0-9a-f]+$/i.test(result.json.result),
    JSON.stringify(result.json),
  );
  check(
    "eth_chainId is Ethereum mainnet (0x1)",
    result.json2?.result === "0x1",
    JSON.stringify(result.json2),
  );

  console.log("\n✅ all e2e assertions passed — anonymous RPC over the live Nym mixnet works");
  cleanup();
  process.exit(0);
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

main().catch((e) => fail(e.stack || String(e)));
