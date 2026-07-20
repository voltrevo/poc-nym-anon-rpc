import test from "node:test";
import assert from "node:assert/strict";
import {
  runNymWorker,
  toRequestInit,
  toAnonResponse,
  abortable,
  readSetupOpts,
  CONFIG_KEY,
} from "../dist-test/nym-anon-client.mjs";

// ---- fakes ---------------------------------------------------------------

function makeFakeApi({ storage = new Map() } = {}) {
  const queue = [];
  const waiters = [];
  const logs = [];
  let readySignals = 0;
  const api = {
    signalReady: () => {
      readySignals += 1;
    },
    acceptCall: () =>
      new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        waiters.push({ resolve, reject });
      }),
    kps: {},
    storage: {
      get: async (k) => storage.get(k),
      set: async (k, v) => void storage.set(k, v),
      delete: async (k) => void storage.delete(k),
      has: async (k) => storage.has(k),
      list: async function* () {
        yield* storage.keys();
      },
      clear: async () => storage.clear(),
    },
    log: {
      debug: (...a) => logs.push(["debug", ...a]),
      info: (...a) => logs.push(["info", ...a]),
      warn: (...a) => logs.push(["warn", ...a]),
      error: (...a) => logs.push(["error", ...a]),
    },
  };
  const push = (call) => {
    const w = waiters.shift();
    if (w) w.resolve(call);
    else queue.push(call);
  };
  const failAccept = (err) => {
    const w = waiters.shift();
    if (w) w.reject(err);
  };
  return { api, push, failAccept, logs, readySignals: () => readySignals };
}

function makeFetchCall(url, requestInit) {
  let respondCount = 0;
  const result = {};
  result.settled = new Promise((resolve) => {
    result.call = {
      kind: "fetch",
      url,
      requestInit,
      respond(response) {
        respondCount += 1;
        if (respondCount > 1) throw new Error("respond called twice");
        Promise.resolve(response).then(
          (value) => resolve({ ok: true, value }),
          (error) => resolve({ ok: false, error }),
        );
      },
    };
  });
  return result;
}

const enc = (s) => new TextEncoder().encode(s);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- toRequestInit -------------------------------------------------------

test("toRequestInit: undefined passes through", async () => {
  assert.equal(await toRequestInit(undefined), undefined);
});

test("toRequestInit: buffers a stream body and strips signal", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc("hello "));
      c.enqueue(enc("world"));
      c.close();
    },
  });
  const out = await toRequestInit({
    method: "POST",
    headers: [["content-type", "application/json"]],
    body: stream,
    redirect: "manual",
    signal: new AbortController().signal,
  });
  assert.equal(out.method, "POST");
  assert.deepEqual(out.headers, [["content-type", "application/json"]]);
  assert.ok(out.body instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(out.body), "hello world");
  assert.equal(out.redirect, "manual");
  assert.ok(!("signal" in out), "AbortSignal must not reach structured clone");
});

// ---- toAnonResponse ------------------------------------------------------

test("toAnonResponse: converts Response, preserves repeated headers", async () => {
  const headers = new Headers();
  headers.append("x-a", "1");
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  const resp = new Response(enc("body!"), { status: 201, headers });
  const out = await toAnonResponse(resp);
  assert.equal(out.status, 201);
  assert.equal(new TextDecoder().decode(out.body), "body!");
  const cookies = out.headers.filter(([k]) => k === "set-cookie").map(([, v]) => v);
  assert.deepEqual(cookies.sort(), ["a=1", "b=2"]);
  assert.equal(out.url, undefined); // empty Response.url → undefined
});

// ---- abortable -----------------------------------------------------------

test("abortable: rejects on abort, resolves otherwise", async () => {
  const ctrl = new AbortController();
  const hang = new Promise(() => {});
  const p = abortable(hang, ctrl.signal);
  ctrl.abort(new Error("stop"));
  await assert.rejects(p, /stop/);

  assert.equal(await abortable(Promise.resolve(42), new AbortController().signal), 42);
});

// ---- readSetupOpts -------------------------------------------------------

test("readSetupOpts: absent, valid, and invalid config", async () => {
  const { api } = makeFakeApi();
  assert.equal(await readSetupOpts(api), undefined);

  await api.storage.set(CONFIG_KEY, enc('{"preferredIpr":"abc","debug":true}'));
  assert.deepEqual(await readSetupOpts(api), { preferredIpr: "abc", debug: true });

  await api.storage.set(CONFIG_KEY, enc("not json"));
  assert.equal(await readSetupOpts(api), undefined);
});

// ---- runNymWorker end-to-end against fakes -------------------------------

test("worker: sets up tunnel with stored opts, signals ready, serves fetch", async () => {
  const fake = makeFakeApi();
  await fake.api.storage.set(CONFIG_KEY, enc('{"preferredIpr":"pinned"}'));

  const seen = { setupOpts: null, fetches: [] };
  const deps = {
    setupMixTunnel: async (opts) => {
      seen.setupOpts = opts;
    },
    mixFetch: async (url, init) => {
      seen.fetches.push({ url, init });
      return new Response(enc(`echo:${url}`), { status: 200 });
    },
  };

  const done = runNymWorker(fake.api, deps);
  await tick();
  assert.equal(fake.readySignals(), 1, "signalReady after tunnel setup");
  assert.equal(seen.setupOpts.preferredIpr, "pinned");
  assert.match(seen.setupOpts.clientId, /^anon-rpc-/, "ephemeral clientId injected");

  const { call, settled } = makeFetchCall("https://example.com/rpc", {
    method: "POST",
    body: enc("{}"),
  });
  fake.push(call);
  const result = await settled;
  assert.ok(result.ok);
  assert.equal(result.value.status, 200);
  assert.equal(new TextDecoder().decode(result.value.body), "echo:https://example.com/rpc");
  assert.equal(seen.fetches[0].init.method, "POST");

  fake.failAccept(new Error("shutdown"));
  await done;
});

test("worker: fetch fails while tunnel is down, then succeeds after retry", async () => {
  const fake = makeFakeApi();
  let attempts = 0;
  const deps = {
    setupMixTunnel: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("gateway unreachable");
    },
    mixFetch: async () => new Response(enc("ok")),
  };

  const done = runNymWorker(fake.api, deps);

  // First call rides the first (failing) setup attempt.
  const first = makeFetchCall("https://example.com/");
  fake.push(first.call);
  const r1 = await first.settled;
  assert.equal(r1.ok, false);
  assert.match(String(r1.error), /gateway unreachable/);
  assert.equal(fake.readySignals(), 0);

  // Second call triggers a fresh attempt, which succeeds.
  const second = makeFetchCall("https://example.com/");
  fake.push(second.call);
  const r2 = await second.settled;
  assert.equal(r2.ok, true);
  assert.equal(new TextDecoder().decode(r2.value.body), "ok");

  fake.failAccept(new Error("shutdown"));
  await done;
});

test("worker: fresh clientId per setup attempt; pinned clientId respected", async () => {
  // fresh per attempt (identity livelock fix: a failed attempt can orphan a
  // gateway connection, and re-registering the same client is refused)
  {
    const fake = makeFakeApi();
    const clientIds = [];
    let attempts = 0;
    const deps = {
      setupMixTunnel: async (opts) => {
        clientIds.push(opts.clientId);
        attempts += 1;
        if (attempts === 1) throw new Error("gateway conflict");
      },
      mixFetch: async () => new Response(enc("ok")),
    };
    const done = runNymWorker(fake.api, deps);

    const first = makeFetchCall("https://example.com/");
    fake.push(first.call);
    await first.settled;
    const second = makeFetchCall("https://example.com/");
    fake.push(second.call);
    const r2 = await second.settled;
    assert.ok(r2.ok);
    assert.equal(clientIds.length, 2);
    assert.match(clientIds[0], /^anon-rpc-/);
    assert.notEqual(clientIds[0], clientIds[1], "retry must use a fresh identity");

    fake.failAccept(new Error("shutdown"));
    await done;
  }

  // pinned in stored config: passed through verbatim on every attempt
  {
    const fake = makeFakeApi();
    await fake.api.storage.set(CONFIG_KEY, enc('{"clientId":"pinned-id"}'));
    const clientIds = [];
    const deps = {
      setupMixTunnel: async (opts) => void clientIds.push(opts.clientId),
      mixFetch: async () => new Response(enc("ok")),
    };
    const done = runNymWorker(fake.api, deps);
    const call = makeFetchCall("https://example.com/");
    fake.push(call.call);
    await call.settled;
    assert.deepEqual(clientIds, ["pinned-id"]);
    fake.failAccept(new Error("shutdown"));
    await done;
  }
});

test("worker: ignores unknown call kinds", async () => {
  const fake = makeFakeApi();
  const deps = {
    setupMixTunnel: async () => {},
    mixFetch: async () => new Response(enc("ok")),
  };
  const done = runNymWorker(fake.api, deps);

  fake.push({ kind: "mystery-kind" });
  const { call, settled } = makeFetchCall("https://example.com/");
  fake.push(call);
  const r = await settled;
  assert.ok(r.ok, "fetch after unknown kind still served");

  fake.failAccept(new Error("shutdown"));
  await done;
});

test("worker: aborted call rejects without waiting on tunnel", async () => {
  const fake = makeFakeApi();
  const deps = {
    setupMixTunnel: () => new Promise(() => {}), // tunnel never comes up
    mixFetch: async () => new Response(enc("ok")),
  };
  const done = runNymWorker(fake.api, deps);

  const ctrl = new AbortController();
  const { call, settled } = makeFetchCall("https://example.com/", { signal: ctrl.signal });
  fake.push(call);
  await tick();
  ctrl.abort();
  const r = await settled;
  assert.equal(r.ok, false);

  fake.failAccept(new Error("shutdown"));
  await done;
});
