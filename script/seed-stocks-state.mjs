// One-off, LOCAL ONLY: seeds stocks-state.json from the keeper discovery cache (keeper/logs/cache, 2026-10-08) so the weekly
// refresh starts from the same pool index and positions instead of rescanning the chain from block 0. Not used in CI.
//
//   node --max-old-space-size=8192 script/seed-stocks-state.mjs [--logs <keeper/logs>] [--stocks <stocks.json>] [--out <stocks-state.json>]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { USDG, WETH, ZERO } from "./lib/chain.mjs";
import { fetchFeedDirectory } from "./lib/stocks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const LOGS = arg("--logs", join(ROOT, "keeper", "logs"));
const STOCKS = arg("--stocks", join(ROOT, "stocks.json"));
const OUT = arg("--out", join(ROOT, "stocks-state.json"));
const DISCOVERY_HEAD = 83608180; // discover-pools.txt: "Pool discovery at block 83608180"
const low = (a) => a.toLowerCase();
const big = (v) => (v && typeof v === "object" && "$b" in v ? BigInt(v.$b) : BigInt(v));
const rev = (k, v) => (v && typeof v === "object" && "$b" in v ? BigInt(v.$b) : v);

const assets = JSON.parse(readFileSync(join(LOGS, "cache", "stock-tokens.json"), "utf8"));
const poolsAll = JSON.parse(readFileSync(join(LOGS, "cache", "pools.json"), "utf8"), rev);
const stocksJson = JSON.parse(readFileSync(STOCKS, "utf8"));
const { bySym } = await fetchFeedDirectory();

const byAddr = new Map(assets.map((a) => [low(a.address), a]));
const feedStock = (a) => { const s = byAddr.get(low(a)); return !!s && bySym.has(s.symbol.toUpperCase()); };
const priced = (a) => { const k = low(a); return k === low(USDG) || k === low(WETH) || k === ZERO || feedStock(a); };

const pools = {};
for (const p of poolsAll) {
  if (!(priced(p.c0) && priced(p.c1))) continue;
  if (!(feedStock(p.c0) || feedStock(p.c1))) continue;
  pools[p.id] = { c0: p.c0, c1: p.c1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, created: Number(big(p.block)), mod_block: null, ranges: {} };
}
console.log(`pool index: ${Object.keys(pools).length} priced pairs containing a stock with a feed`);

// positions of the pools the 2026-10-08 discovery looked at (net liquidity per sender|ticks|salt, positive keys only)
console.log("reading modify-liquidity.json (large)...");
const mods = JSON.parse(readFileSync(join(LOGS, "cache", "modify-liquidity.json"), "utf8"), rev);
const perKey = new Map();
for (const m of mods) {
  if (!pools[m.id]) continue;
  const k = `${m.id}|${low(m.sender)}|${m.lo}|${m.hi}|${m.salt}`;
  perKey.set(k, (perKey.get(k) ?? 0n) + m.delta);
}
const seeded = new Set();
for (const [k, L] of perKey) {
  if (L <= 0n) continue;
  const [id, , lo, hi] = k.split("|");
  const r = pools[id].ranges;
  const rk = `${lo}:${hi}`;
  r[rk] = (BigInt(r[rk] ?? "0") + L).toString();
  seeded.add(id);
}
const histPools = new Set(mods.map((m) => m.id));
for (const id of histPools) if (pools[id]) pools[id].mod_block = DISCOVERY_HEAD;
console.log(`positions seeded for ${histPools.size} pools (${perKey.size} position keys)`);

const feedStocks = assets.filter((a) => bySym.has(a.symbol.toUpperCase()));
const stocks = {};
for (const s of stocksJson.stocks) stocks[s.symbol] = { status: "tracked", passes: 2, fails: 0, tracked_since: "2026-10-08", last_pass: "2026-10-08" };
const state = {
  version: 1,
  chain_id: 4663,
  updated_at: "2026-10-08T20:50:24.000Z",
  init_scanned_block: DISCOVERY_HEAD,
  last_refresh_block: DISCOVERY_HEAD,
  assets_count: assets.length,
  feeds_count: feedStocks.length,
  feed_stocks: feedStocks.map((a) => a.address),
  pools,
  stocks,
};
writeFileSync(OUT, JSON.stringify(state));
const kb = (Buffer.byteLength(JSON.stringify(state)) / 1024).toFixed(0);
console.log(`wrote ${OUT}: ${Object.keys(pools).length} pools, ${Object.keys(stocks).length} tracked stocks, ${kb} KB`);
