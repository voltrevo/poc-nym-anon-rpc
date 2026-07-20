// Granular probe 2 (browser, no mixnet): does the anon-rpc sandbox
// environment (Web Worker inside a null-origin iframe) provide what the Nym
// stack needs? Checks each capability separately so a failure names the
// exact missing primitive rather than a generic tunnel error:
//   - nested Worker spawn from a blob: URL
//   - WebAssembly compile+instantiate inside the nested worker
//   - IndexedDB state (expected: denied -> our in-memory shim path)
//   - WebSocket from the nested worker to a real Nym gateway (Origin: null)
//   - fetch of the Nym directory API from the sandbox (CORS from Origin: null)

import { chromium } from "playwright";

const GATEWAY_WS = process.env.GATEWAY_WS ?? ""; // e.g. wss://host:9001/; discovered if empty
const API = "https://validator.nymtech.net/api";

// discover a live gateway websocket endpoint from the directory
async function discoverGatewayWs() {
  if (GATEWAY_WS) return GATEWAY_WS;
  const r = await fetch(`${API}/v1/unstable/nym-nodes/skimmed/entry-gateways/all?no_legacy=true`);
  const j = await r.json();
  const nodes = j.nodes?.data ?? j.nodes ?? [];
  const candidates = nodes
    .filter((n) => n.entry?.hostname && n.entry?.wss_port && Number(n.performance) >= 0.9)
    .sort((a, b) => Number(b.performance) - Number(a.performance));
  const pick = candidates[0];
  if (!pick) throw new Error("no gateway with wss endpoint found in directory");
  return `wss://${pick.entry.hostname}:${pick.entry.wss_port}/`;
}

const wsUrl = await discoverGatewayWs();
console.log(`probing gateway websocket: ${wsUrl}`);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("console", (m) => console.log(`[page:${m.type()}] ${m.text()}`));
await page.setContent("<p>sandbox probe</p>");

const result = await page.evaluate(
  async ({ wsUrl, apiUrl }) => {
    const innerWorkerSrc = `
      (async () => {
        const report = {};
        // WASM
        try {
          const mod = await WebAssembly.instantiate(new Uint8Array([
            0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00
          ]));
          report.wasm = "ok";
        } catch (e) { report.wasm = "FAIL: " + e.message; }
        // IndexedDB
        try { indexedDB.open("probe"); report.idb = "usable"; }
        catch (e) { report.idb = "denied (" + e.name + ") — shim path"; }
        // WebSocket to a real gateway
        report.ws = await new Promise((resolve) => {
          try {
            const ws = new WebSocket(${JSON.stringify(wsUrl)});
            const t = setTimeout(() => { ws.close(); resolve("FAIL: timeout"); }, 10000);
            ws.onopen = () => { clearTimeout(t); ws.close(); resolve("ok (open from Origin: null)"); };
            ws.onerror = () => { clearTimeout(t); resolve("FAIL: error event"); };
          } catch (e) { resolve("FAIL: " + e.message); }
        });
        // CORS fetch of the directory API
        try {
          const r = await fetch(${JSON.stringify(apiUrl)} + "/v1/epoch/current");
          report.apiFetch = r.ok ? "ok (CORS allows null origin)" : "FAIL: HTTP " + r.status;
        } catch (e) { report.apiFetch = "FAIL: " + e.message; }
        postMessage(report);
      })();
    `;
    const outerWorkerSrc = `
      try {
        const inner = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(innerWorkerSrc)}], { type: "application/javascript" })));
        inner.onmessage = (e) => postMessage({ nestedWorker: "ok", ...e.data });
        inner.onerror = (e) => postMessage({ nestedWorker: "FAIL: " + e.message });
      } catch (e) {
        postMessage({ nestedWorker: "FAIL: " + e.message });
      }
    `;
    const iframeSrc = `
      <script>
        const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(outerWorkerSrc)}], { type: "application/javascript" })));
        w.onmessage = (e) => parent.postMessage(e.data, "*");
        w.onerror = (e) => parent.postMessage({ outerWorker: "FAIL: " + e.message }, "*");
      <\/script>
    `;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.srcdoc = iframeSrc;
    const reply = new Promise((resolve) => {
      window.addEventListener("message", (e) => resolve(e.data), { once: true });
      setTimeout(() => resolve({ timeout: true }), 30_000);
    });
    document.body.appendChild(iframe);
    return await reply;
  },
  { wsUrl, apiUrl: API },
);

console.log("sandbox capability report:", JSON.stringify(result, null, 2));
await browser.close();

const failed = Object.entries(result).filter(([, v]) => String(v).startsWith("FAIL"));
console.log(failed.length ? `❌ ${failed.length} capability failure(s)` : "✅ sandbox provides everything the Nym stack needs");
process.exit(failed.length ? 1 : 0);
