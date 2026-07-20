// Diagnostic: what does IndexedDB look like in a nested Worker inside a
// null-origin (sandbox="allow-scripts") iframe in headless Chromium?
// Replicates the anon-rpc harness environment without the mixnet.

import { chromium } from "playwright";

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("console", (m) => console.log(`[page:${m.type()}] ${m.text()}`));

await page.setContent("<p>probe</p>");

const result = await page.evaluate(async () => {
  const innerWorkerSrc = `
    (async () => {
    const report = {};
    report.hasIDB = typeof indexedDB;
    try {
      const req = indexedDB.open("probe-db", 1);
      report.openSync = "no-throw";
      await new Promise((resolve) => {
        req.onsuccess = () => { report.openAsync = "success, version=" + req.result.version; resolve(); };
        req.onerror = () => { report.openAsync = "error: " + (req.error?.name + " " + req.error?.message); resolve(); };
        req.onupgradeneeded = () => { report.upgrade = true; };
        setTimeout(() => { report.openAsync = report.openAsync || "timeout"; resolve(); }, 3000);
      });
    } catch (e) {
      report.openSync = "threw: " + e.name + " " + e.message;
    }
    // what smolmix might do: open with explicit version 0
    try { indexedDB.open("probe-db", 0); report.openV0 = "no-throw"; }
    catch (e) { report.openV0 = "threw: " + e.name + ": " + e.message; }
    postMessage(report);
    })();
  `;
  const outerWorkerSrc = `
    const inner = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(innerWorkerSrc)}], { type: "application/javascript" })));
    inner.onmessage = (e) => postMessage({ nested: e.data });
    inner.onerror = (e) => postMessage({ nestedError: e.message });
  `;
  const iframeSrc = `
    <script>
      const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(outerWorkerSrc)}], { type: "application/javascript" })));
      w.onmessage = (e) => parent.postMessage(e.data, "*");
      w.onerror = (e) => parent.postMessage({ workerError: e.message }, "*");
    <\/script>
  `;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.srcdoc = iframeSrc;
  const reply = new Promise((resolve) => {
    window.addEventListener("message", (e) => resolve(e.data), { once: true });
    setTimeout(() => resolve({ timeout: true }), 10_000);
  });
  document.body.appendChild(iframe);
  return await reply;
});

console.log("probe result:", JSON.stringify(result, null, 2));
await browser.close();
