// mix-tunnel spawns its nested WASM worker via
// `URL.createObjectURL(new Blob([source], { type: "application/javascript" }))`.
// That worker gets a fresh global scope we cannot reach from here — so this
// patch, installed in OUR scope before the first tunnel setup, wraps
// createObjectURL and prepends a prelude to every javascript blob created in
// this worker. The only such blob is mix-tunnel's worker source.

export function patchTunnelWorkerBlobs(preludeSource: string): void {
  const original = URL.createObjectURL.bind(URL);
  URL.createObjectURL = ((obj: Blob): string => {
    if (obj instanceof Blob && obj.type === "application/javascript") {
      return original(new Blob([preludeSource, "\n;\n", obj], { type: obj.type }));
    }
    return original(obj);
  }) as typeof URL.createObjectURL;
}
