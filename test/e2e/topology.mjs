// Shared assessment of live Nym directory health, used by probe-network.mjs
// (standalone report) and run-e2e.mjs (gate). Smolmix needs nodes in every
// mix layer; the active set is rebuilt at each hourly epoch boundary, and
// runs that straddle a rollover see "mixing layer does not have any valid
// nodes" — so a fresh rollover counts as not-settled.

const API = process.env.NYM_API ?? "https://validator.nymtech.net/api";
const MIN_MIXNODES = 9; // 3 layers need nodes; below this routing is implausible
const MIN_GATEWAYS = 3;
const ROLLOVER_SETTLE_MS = 2 * 60_000;

async function get(path) {
  const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

export async function assessTopology() {
  const epoch = await get("/v1/epoch/current");
  const epochElapsedMs = Date.now() - new Date(epoch.current_epoch_start).getTime();
  const epochRemainingMs = Math.max(0, epoch.epoch_length.secs * 1000 - epochElapsedMs);

  const mixnodes = await get(
    "/v1/unstable/nym-nodes/skimmed/mixnodes/active?semver_compatibility=1.1.0",
  );
  const gateways = await get(
    "/v1/unstable/nym-nodes/skimmed/entry-gateways/all?no_legacy=true",
  );
  const mixCount = mixnodes.nodes?.data?.length ?? mixnodes.nodes?.length ?? 0;
  const gwCount = gateways.nodes?.data?.length ?? gateways.nodes?.length ?? 0;

  const justRolled = epochElapsedMs < ROLLOVER_SETTLE_MS;
  const thin = mixCount < MIN_MIXNODES || gwCount < MIN_GATEWAYS;
  return {
    ok: !thin && !justRolled,
    reason: thin
      ? `topology too thin (${mixCount} mixnodes, ${gwCount} gateways)`
      : justRolled
        ? `epoch ${epoch.current_epoch_id} rolled over ${Math.round(epochElapsedMs / 1000)}s ago — active set may still be settling`
        : undefined,
    epochId: epoch.current_epoch_id,
    epochElapsedMs,
    epochRemainingMs,
    mixCount,
    gwCount,
  };
}
