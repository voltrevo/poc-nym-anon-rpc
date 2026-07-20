// Core logic of the Nym anon-rpc worker, kept free of any import of
// @nymproject/mix-fetch so it can be unit-tested in Node without WASM,
// nested Workers, or a mixnet. The entry point (worker-main.ts) injects the
// real tunnel functions via `TunnelDeps`.

import type {
  AnonRpcWorkerApi,
  AnonRequestInit,
  AnonFetchResponse,
  ByteBody,
  HeaderList,
} from "./spec-types.js";

// The subset of @nymproject/mix-fetch this worker consumes.
export type TunnelDeps = {
  setupMixTunnel(opts?: Record<string, unknown>): Promise<void>;
  mixFetch(url: string, init?: RequestInit): Promise<Response>;
};

// Optional worker configuration, stored by the host (via its own tooling)
// under this key as UTF-8 JSON. The value is passed to setupMixTunnel as
// SetupMixTunnelOpts: preferredIpr, disableCoverTraffic, connectTimeoutMs, …
export const CONFIG_KEY = "nym/setup-opts";

const RETRY_MAX_MS = 30_000;

export async function readSetupOpts(
  api: AnonRpcWorkerApi,
): Promise<Record<string, unknown> | undefined> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await api.storage.get(CONFIG_KEY);
  } catch (e) {
    api.log.warn("storage.get(config) failed:", errMsg(e));
    return undefined;
  }
  if (!bytes) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    api.log.warn("config is not a JSON object; ignoring");
  } catch (e) {
    api.log.warn("config is not valid JSON; ignoring:", errMsg(e));
  }
  return undefined;
}

export async function runNymWorker(api: AnonRpcWorkerApi, deps: TunnelDeps): Promise<void> {
  // One tunnel-setup attempt at a time. A failed attempt clears the slot so
  // the next fetch call (or the boot retry loop) starts a fresh one; the call
  // that awaited the failed attempt rejects rather than waiting forever.
  let tunnelReady: Promise<void> | undefined;
  const ensureTunnel = (): Promise<void> => {
    if (!tunnelReady) {
      tunnelReady = (async () => {
        const opts = (await readSetupOpts(api)) ?? {};
        // Fresh clientId per attempt unless the host pinned one: smolmix
        // namespaces its stored identity by clientId, and a failed attempt
        // can leave its gateway connection orphaned — retrying with the same
        // identity then livelocks on "already an open connection to this
        // client". A fresh identity re-registers cleanly (and is ephemeral
        // anyway wherever the IndexedDB shim is active).
        if (opts["clientId"] === undefined) {
          opts["clientId"] = `anon-rpc-${randomId()}`;
        }
        await deps.setupMixTunnel(opts);
      })();
      tunnelReady.catch(() => {
        tunnelReady = undefined;
      });
    }
    return tunnelReady;
  };

  // §7: signalReady() once the worker can actually fulfil fetch calls, i.e.
  // when the mixnet tunnel is up. The harness buffers calls until then, and
  // the accept loop below runs from boot, so nothing is dropped meanwhile.
  void (async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await ensureTunnel();
        api.signalReady();
        api.log.info("nym tunnel ready");
        return;
      } catch (e) {
        const delay = Math.min(RETRY_MAX_MS, 1000 * 2 ** attempt);
        api.log.warn(`tunnel setup failed (attempt ${attempt + 1}):`, errMsg(e));
        await sleep(delay);
      }
    }
  })();

  for (;;) {
    let call;
    try {
      call = await api.acceptCall();
    } catch (e) {
      api.log.error("acceptCall failed:", errMsg(e));
      return;
    }
    if (call.kind !== "fetch") continue; // §8: ignore unknown call kinds
    call.respond(handleFetch(call.url, call.requestInit));
  }

  async function handleFetch(url: string, init?: AnonRequestInit): Promise<AnonFetchResponse> {
    init?.signal?.throwIfAborted();
    await abortable(ensureTunnel(), init?.signal);
    const resp = await abortable(deps.mixFetch(url, await toRequestInit(init)), init?.signal);
    return toAnonResponse(resp);
  }
}

// AnonRequestInit → the RequestInit handed to mixFetch. Everything in the
// result must survive structured clone: mix-tunnel ships it over Comlink to
// its tunnel worker. So headers stay a plain pair array, a streaming body is
// buffered to a Uint8Array, and `signal` is never included (AbortSignal is
// not cloneable — cancellation is handled outside via `abortable`).
export async function toRequestInit(init?: AnonRequestInit): Promise<RequestInit | undefined> {
  if (!init) return undefined;
  const out: RequestInit = {};
  if (init.method) out.method = init.method;
  if (init.headers) out.headers = init.headers as [string, string][];
  if (init.body) out.body = (await readAll(init.body)) as BodyInit;
  if (init.redirect) out.redirect = init.redirect;
  return out;
}

export async function toAnonResponse(resp: Response): Promise<AnonFetchResponse> {
  const headers: HeaderList = [];
  resp.headers.forEach((v, k) => headers.push([k, v]));
  return {
    status: resp.status,
    headers,
    body: new Uint8Array(await resp.arrayBuffer()),
    url: resp.url || undefined,
  };
}

// Reject when `signal` aborts, so the host's cancellation is observed even
// though an in-flight mixnet transfer itself cannot be cancelled mid-way.
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readAll(body: ByteBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// crypto.randomUUID is unavailable here: the sandboxed worker has an opaque
// origin, which is not a secure context. getRandomValues always exists.
function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
