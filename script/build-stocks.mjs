// One-off: builds stocks.json from the local keeper discovery cache (keeper/src/discover.ts, 2026-10-08).
// The weekly job (script/refresh-stocks.mjs) re-runs the same rules from the chain; both share script/lib/stocks.mjs.
// READ-ONLY: two public lists and eth_call reads.
//
//   node script/build-stocks.mjs [--logs <keeper/logs dir>] [--out <stocks.json>]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rpc, selfTestKeccak, POOL_MANAGER, CHAIN_ID, RPC } from "./lib/chain.mjs";
import { RULES, low, fetchFeedDirectory, validateFeeds, describeToken, usable, selectStocks } from "./lib/stocks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const LOGS = arg("--logs", join(ROOT, "keeper", "logs"));
const OUT = arg("--out", join(ROOT, "stocks.json"));
const MIN_TVL_USD = Number(process.env.MIN_TVL_USD ?? RULES.minTvlUsd);
const MIN_SWAPS = Number(process.env.MIN_SWAPS ?? RULES.minSwaps);
const MIN_SENDERS = Number(process.env.MIN_SENDERS ?? RULES.minSenders);

selfTestKeccak();

// ---- inputs (the 2026-10-08 discovery) ---------------------------------------------------------------------------------
const stockTokens = JSON.parse(readFileSync(join(LOGS, "cache", "stock-tokens.json"), "utf8"));
const tokens = JSON.parse(readFileSync(join(LOGS, "cache", "tokens.json"), "utf8"));
const poolsAll = JSON.parse(readFileSync(join(LOGS, "cache", "pools.json"), "utf8"));
const poolById = new Map(poolsAll.map((p) => [p.id, p]));

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells = [];
    let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}
const csvPools = parseCsv(readFileSync(join(LOGS, "discover-pools.csv"), "utf8"));

// ---- chain head + feeds ----------------------------------------------------------------------------------------------
const chainId = parseInt(await rpc("eth_chainId"), 16);
if (chainId !== CHAIN_ID) throw new Error(`RPC is chain ${chainId}, expected ${CHAIN_ID}`);
const headNum = parseInt(await rpc("eth_blockNumber"), 16);
const headTs = parseInt((await rpc("eth_getBlockByNumber", ["0x" + headNum.toString(16), false])).timestamp, 16);
const BLOCK = "0x" + headNum.toString(16);
console.log(`chain ${chainId}, head block ${headNum} (${new Date(headTs * 1000).toISOString()}), RPC ${RPC}`);

const { total, bySym } = await fetchFeedDirectory();
console.log(`feed directory: ${total} feeds, ${bySym.size} USD feeds`);
const symbolsNeeded = new Set([...stockTokens.map((t) => t.symbol.toUpperCase()), "USDG", "ETH"]);
const feedInfo = await validateFeeds(symbolsNeeded, bySym, BLOCK);

// ---- qualifying pools --------------------------------------------------------------------------------------------------
const ctx = { stockByAddr: new Map(stockTokens.map((t) => [low(t.address), t])), otherTokens: tokens };
const qualifying = [];
for (const r of csvPools) {
  const tvl = Number(r.tvl_usd), swaps = Number(r.real_swaps), senders = Number(r.real_swap_senders);
  if (!(tvl >= MIN_TVL_USD && swaps >= MIN_SWAPS && senders >= MIN_SENDERS)) continue;
  const p = poolById.get(r.pool_id);
  if (!p) continue;
  const t0 = describeToken(p.c0, ctx), t1 = describeToken(p.c1, ctx);
  if (!t0 || !t1) continue;
  qualifying.push({ id: p.id, c0: p.c0, c1: p.c1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, t0, t1, tvl, swaps, senders, pair: r.pair, feeSetting: r.fee_setting, hookName: r.hook_name });
}
console.log(`pools passing TVL >= $${MIN_TVL_USD}, >= ${MIN_SWAPS} real swaps, >= ${MIN_SENDERS} senders: ${qualifying.length} of ${csvPools.length}`);

const { stocks, unresolved } = selectStocks(stockTokens, feedInfo, bySym, qualifying, { minTvlUsd: MIN_TVL_USD, minSwaps: MIN_SWAPS, minSenders: MIN_SENDERS });

const out = {
  generated_at: new Date(headTs * 1000).toISOString(),
  chain_id: CHAIN_ID,
  pool_manager: POOL_MANAGER,
  rule: `main pool = the pool with the highest TVL among pools with TVL >= $${MIN_TVL_USD}, >= ${MIN_SWAPS} real swaps and >= ${MIN_SENDERS} senders in 14 days, preferring a USDG quote, then ETH/WETH, then another Stock Token`,
  discovery: "keeper/logs/discover-pools.csv (block 83608180, 2026-10-08): TVL and swap counts are as of then; liquidity and prices are re-read live by gap-snapshot.mjs",
  counts: { stock_tokens: stockTokens.length, with_feed: stockTokens.filter((t) => usable(feedInfo, t.symbol.toUpperCase())).length, resolved: stocks.length, pools_total: stocks.reduce((n, s) => n + 1 + s.other_pools.length, 0), unresolved: unresolved.length },
  quote_feeds: { USDG: usable(feedInfo, "USDG") && { feed: usable(feedInfo, "USDG").proxy, decimals: usable(feedInfo, "USDG").decimals }, ETH: usable(feedInfo, "ETH") && { feed: usable(feedInfo, "ETH").proxy, decimals: usable(feedInfo, "ETH").decimals } },
  stocks,
  unresolved,
};
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.counts));
console.log(`resolved stocks (${stocks.length}): ${stocks.map((s) => `${s.symbol}[${1 + s.other_pools.length}]`).join(" ")}`);
