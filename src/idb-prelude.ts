// Prelude injected at the top of the mix-tunnel nested worker (prepended to
// its blob source by tunnel-worker-patch.ts — this file is bundled separately
// to text by build.mjs and never imported by the worker directly).
//
// Why: in the anon-rpc sandbox (Web Worker inside a null-origin iframe, §6)
// `indexedDB` exists but `open()` throws a synchronous SecurityError, and
// smolmix's storage layer fails tunnel setup on it ("failed to open the db
// file: Version cannot be zero"). When that happens, swap in an in-memory
// IndexedDB (fake-indexeddb) before the WASM boots: the Nym client identity
// becomes ephemeral per boot, which is privacy-fine for an anon-client.
//
// The wasm-bindgen glue does `instanceof IDBDatabase` / `instanceof
// IDBRequest` against the globals, so those classes are replaced together
// with the factory.

import {
  indexedDB as memIndexedDB,
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
} from "fake-indexeddb";

function idbUsable(): boolean {
  try {
    // A denied context throws SecurityError synchronously.
    const req = indexedDB.open("__anon-rpc-idb-probe__");
    req.onsuccess = () => {
      req.result.close();
      indexedDB.deleteDatabase("__anon-rpc-idb-probe__");
    };
    return true;
  } catch {
    return false;
  }
}

if (typeof indexedDB === "undefined" || !idbUsable()) {
  const overrides: Record<string, unknown> = {
    indexedDB: memIndexedDB,
    IDBCursor,
    IDBCursorWithValue,
    IDBDatabase,
    IDBFactory,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBOpenDBRequest,
    IDBRequest,
    IDBTransaction,
    IDBVersionChangeEvent,
  };
  for (const [name, value] of Object.entries(overrides)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  console.warn(
    "[nym-anon-rpc idb-shim] IndexedDB is denied in this context; using in-memory storage (client identity is ephemeral per boot)",
  );
}
