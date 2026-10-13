// Read-only gap snapshot: for every stock in stocks.json, how far is the Uniswap v4 pool price from Chainlink's price?
//
//   node script/gap-snapshot.mjs            (reads ./stocks.json, writes ./gap-snapshot.json, prints a table)
//
// Only eth_call / eth_blockNumber / eth_getBlockByNumber are used; every value is read at ONE block so the numbers are
// consistent with each other. No keys, no transactions, nothing is written outside gap-snapshot.json.
//
// Price conversion
//   pool:      sqrtPriceX96 from the PoolManager (extsload of pools[id].slot0). raw ratio = (sqrtPriceX96 / 2^96)^2 is raw
//              currency1 per raw currency0; token0 price in token1 = ratio * 10^(dec0 - dec1). The stock's price in the quote
//              token is that, or its inverse if the stock is currency1. Times the quote token's Chainlink USD price.
//   chainlink: latestRoundData().answer / 10^decimals (USD per ONE token).
//   gap_bps  = (pool USD price - Chainlink USD price) / Chainlink USD price * 10,000   (signed: + means the pool is ABOVE Chainlink)
//
// Token multiplier: Robinhood Stock Tokens have a `uiMultiplier()` (corporate actions such as splits). Chainlink's Robinhood
// feeds report the price of ONE TOKEN with the multiplier already inside, and the pool prices ONE TOKEN too, so NO scaling is
// applied to either side. The multiplier is read and reported, and anything other than 1.0 (or a pending change) is flagged.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rpc, batch, ethCall, words, toSigned, selfTestKeccak, poolSlot, slotPlus, selector, EXTSLOAD, LATEST_ROUND_DATA, DECIMALS, POOL_MANAGER, CHAIN_ID, RPC } from "./lib/chain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
selfTestKeccak();

const cfg = JSON.parse(readFileSync(join(ROOT, "stocks.json"), "utf8"));
if (cfg.chain_id !== CHAIN_ID) throw new Error("stocks.json is for another chain");

const chainId = parseInt(await rpc("eth_chainId"), 16);
if (chainId !== CHAIN_ID) throw new Error(`RPC is chain ${chainId}, expected ${CHAIN_ID}`);
const headNum = parseInt(await rpc("eth_blockNumber"), 16);
const BLOCK = "0x" + headNum.toString(16);
const headTs = parseInt((await rpc("eth_getBlockByNumber", [BLOCK, false])).timestamp, 16);

// ---- collect what to read ------------------------------------------------------------------------------------------
const feeds = new Map(); // address(lower) -> { address, decimals }
const addFeed = (address, decimals) => feeds.set(address.toLowerCase(), { address, decimals });
const pools = new Map(); // pool id -> pool entry (first seen)
for (const s of cfg.stocks) {
  addFeed(s.feed, s.feed_decimals);
  for (const p of [s.main_pool, ...s.other_pools]) {
    addFeed(p.quote.feed, p.quote.feed_decimals);
    if (!pools.has(p.pool_id)) pools.set(p.pool_id, p);
  }
}
const SEL_MUL = selector("uiMultiplier()");
const SEL_NEW = selector("newUIMultiplier()");
const SEL_PAUSED = selector("oraclePaused()");

const calls = [];
const at = {}; // key -> index in calls
const push = (key, c) => { at[key] = calls.length; calls.push(c); };
for (const f of feeds.values()) {
  push("feed:" + f.address.toLowerCase(), ethCall(f.address, LATEST_ROUND_DATA, BLOCK));
  push("dec:" + f.address.toLowerCase(), ethCall(f.address, DECIMALS, BLOCK));
}
for (const id of pools.keys()) {
  const slot = poolSlot(id);
  push("slot0:" + id, ethCall(POOL_MANAGER, EXTSLOAD + slot.slice(2), BLOCK));
  push("liq:" + id, ethCall(POOL_MANAGER, EXTSLOAD + slotPlus(slot, 3).slice(2), BLOCK));
}
for (const s of cfg.stocks) {
  push("mul:" + s.token.toLowerCase(), ethCall(s.token, SEL_MUL, BLOCK));
  push("new:" + s.token.toLowerCase(), ethCall(s.token, SEL_NEW, BLOCK));
  push("pause:" + s.token.toLowerCase(), ethCall(s.token, SEL_PAUSED, BLOCK));
}
console.log(`snapshot block ${headNum} (${new Date(headTs * 1000).toISOString()}): ${feeds.size} feeds, ${pools.size} pools, ${cfg.stocks.length} stocks, ${calls.length} reads`);
const res = await batch(calls);
const get = (key) => res[at[key]];

// ---- decode --------------------------------------------------------------------------------------------------------
const feedData = new Map();
for (const f of feeds.values()) {
  const k = f.address.toLowerCase();
  const r = get("feed:" + k), d = get("dec:" + k);
  if (r.error || d.error) { feedData.set(k, { error: r.error || d.error }); continue; }
  const dec = Number(words(d.result)[0]);
  const w = words(r.result);
  const answer = toSigned(w[1]);
  feedData.set(k, {
    decimals: dec,
    decimalsMismatch: dec !== f.decimals,
    price: Number(answer) / 10 ** dec,
    updatedAt: Number(w[3]),
    roundId: w[0].toString(),
    error: answer > 0n ? undefined : "non-positive answer",
  });
}
const poolData = new Map();
for (const id of pools.keys()) {
  const s0 = get("slot0:" + id), lq = get("liq:" + id);
  if (s0.error || lq.error) { poolData.set(id, { error: s0.error || lq.error }); continue; }
  const w0 = BigInt(s0.result), wl = BigInt(lq.result);
  const sqrtPriceX96 = w0 & ((1n << 160n) - 1n);
  let tick = Number((w0 >> 160n) & 0xffffffn);
  if (tick >= 1 << 23) tick -= 1 << 24;
  poolData.set(id, { sqrtPriceX96, tick, liquidity: wl & ((1n << 128n) - 1n) });
}

const iso = (t) => new Date(t * 1000).toISOString();
function readPool(stock, p, stockFeed) {
  const out = { pool_id: p.pool_id, main: p.main, pair: p.pair, quote: p.quote.symbol, fee_setting: p.fee_setting, hook: p.hook_name, flags: [] };
  const pd = poolData.get(p.pool_id);
  const qf = feedData.get(p.quote.feed.toLowerCase());
  if (!pd || pd.error) { out.flags.push("pool read failed: " + (pd?.error ?? "?")); return out; }
  out.pool_liquidity = pd.liquidity.toString();
  out.pool_tick = pd.tick;
  out.tvl_usd_at_discovery = p.tvl_usd_at_discovery;
  if (pd.sqrtPriceX96 === 0n) { out.flags.push("pool not initialised (price 0)"); return out; }
  if (pd.liquidity === 0n) out.flags.push("ZERO in-range liquidity");
  if (!qf || qf.error) { out.flags.push("quote feed unusable: " + (qf?.error ?? "?")); return out; }
  const dec0 = p.stock_is_currency0 ? stock.decimals : p.quote.decimals;
  const dec1 = p.stock_is_currency0 ? p.quote.decimals : stock.decimals;
  const sq = Number(pd.sqrtPriceX96) / 2 ** 96;
  const token0InToken1 = sq * sq * 10 ** (dec0 - dec1);
  const stockInQuote = p.stock_is_currency0 ? token0InToken1 : 1 / token0InToken1;
  out.pool_price_usd = stockInQuote * qf.price;
  out.pool_price_in_quote = stockInQuote;
  out.quote_price_usd = qf.price;
  out.gap_bps = stockFeed.price ? ((out.pool_price_usd - stockFeed.price) / stockFeed.price) * 1e4 : undefined;
  // virtual in-range depth (what the discovery called "in-range depth"; NOT the money in the pool)
  const L = Number(pd.liquidity);
  const q0 = p.stock_is_currency0 ? out.pool_price_usd : qf.price;
  const q1 = p.stock_is_currency0 ? qf.price : out.pool_price_usd;
  out.virtual_in_range_depth_usd = (L / sq / 10 ** dec0) * q0 + ((L * sq) / 10 ** dec1) * q1;
  const quoteAge = (headTs - qf.updatedAt) / 60;
  out.quote_feed_age_minutes = quoteAge;
  if (Math.abs(out.gap_bps) > 300) out.flags.push(`|gap| above 300 bps (${out.gap_bps.toFixed(0)})`);
  return out;
}

const MUL_ONE = 10n ** 18n;
const rows = [];
const odd = [];
for (const s of cfg.stocks) {
  const sf = feedData.get(s.feed.toLowerCase());
  const row = { symbol: s.symbol, token: s.token, feed: s.feed, flags: [] };
  if (!sf || sf.error) { row.flags.push("feed unusable: " + (sf?.error ?? "?")); rows.push(row); odd.push(`${s.symbol}: feed unusable (${sf?.error})`); continue; }
  if (sf.decimalsMismatch) row.flags.push("feed decimals differ from stocks.json");
  row.chainlink_price_usd = sf.price;
  row.chainlink_updated_at = iso(sf.updatedAt);
  row.feed_age_minutes = Math.round(((headTs - sf.updatedAt) / 60) * 10) / 10;
  // multiplier
  const mul = get("mul:" + s.token.toLowerCase()), nxt = get("new:" + s.token.toLowerCase()), pz = get("pause:" + s.token.toLowerCase());
  if (!mul.error && mul.result.length >= 66) {
    const m = BigInt(mul.result);
    row.ui_multiplier = Number(m) / 1e18;
    if (m !== MUL_ONE) row.multiplier_not_one = true; // informational: summarised below, not an error
    if (!nxt.error && nxt.result.length >= 66 && BigInt(nxt.result) !== m) row.flags.push(`PENDING multiplier change to ${Number(BigInt(nxt.result)) / 1e18}`);
  } else row.ui_multiplier = null;
  if (!pz.error && pz.result.length >= 66 && BigInt(pz.result) === 1n) row.flags.push("token oracle is PAUSED");
  const main = readPool(s, s.main_pool, sf);
  row.main_pool = main;
  row.pool_price_usd = main.pool_price_usd;
  row.gap_bps = main.gap_bps === undefined ? undefined : Math.round(main.gap_bps * 100) / 100;
  row.pool_liquidity = main.pool_liquidity;
  row.other_pools = s.other_pools.map((p) => readPool(s, p, sf));
  row.snapshot_at = iso(headTs);
  rows.push(row);
}

// feed oddities
const stale = rows.filter((r) => r.feed_age_minutes !== undefined && r.feed_age_minutes > 24 * 60);
const mults = rows.filter((r) => r.multiplier_not_one);
const out = {
  snapshot_at: iso(headTs),
  block: headNum,
  chain_id: CHAIN_ID,
  rpc: RPC,
  multiplier_policy: "uiMultiplier is read and reported but NOT applied: Chainlink's feed and the pool both price ONE TOKEN. Non-1.0 or pending multipliers are flagged.",
  gap_definition: "(pool USD price - Chainlink USD price) / Chainlink USD price, in bps; + means the pool is above Chainlink",
  stocks: rows,
};
writeFileSync(join(ROOT, "gap-snapshot.json"), JSON.stringify(out, null, 1));

// ---- console table -------------------------------------------------------------------------------------------------
const fmt = (n, d = 2) => (n === undefined || n === null || Number.isNaN(n) ? "n/a" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pad = (v, n, left = false) => (left ? String(v).padStart(n) : String(v).padEnd(n));
const ranked = rows.filter((r) => r.gap_bps !== undefined).sort((a, b) => Math.abs(b.gap_bps) - Math.abs(a.gap_bps));
console.log(`\nGap snapshot at ${iso(headTs)} (block ${headNum}); main pool per stock, sorted by |gap|`);
console.log(pad("symbol", 7) + pad("pair", 12) + pad("chainlink $", 13, 1) + pad("pool $", 13, 1) + pad("gap bps", 9, 1) + pad("feed age", 10, 1) + pad("in-range L", 12, 1) + pad("uiMult", 9, 1) + "  flags");
for (const r of ranked) {
  const m = r.main_pool;
  const age = r.feed_age_minutes >= 120 ? `${fmt(r.feed_age_minutes / 60, 1)} h` : `${fmt(r.feed_age_minutes, 0)} min`;
  console.log(pad(r.symbol, 7) + pad(m.pair, 12) + pad(fmt(r.chainlink_price_usd), 13, 1) + pad(fmt(r.pool_price_usd), 13, 1) + pad(fmt(r.gap_bps, 1), 9, 1) + pad(age, 10, 1) + pad(m.pool_liquidity ? Number(m.pool_liquidity).toExponential(2) : "n/a", 12, 1) + pad(r.ui_multiplier === null ? "none" : r.ui_multiplier.toFixed(4), 9, 1) + "  " + [...r.flags, ...m.flags].join("; "));
}
const allOther = rows.flatMap((r) => (r.other_pools ?? []).map((p) => ({ symbol: r.symbol, ...p }))).filter((p) => p.gap_bps !== undefined).sort((a, b) => Math.abs(b.gap_bps) - Math.abs(a.gap_bps));
console.log(`\nOther pools (${allOther.length}), 10 largest |gap|:`);
for (const p of allOther.slice(0, 10)) console.log(`  ${pad(p.symbol, 6)} ${pad(p.pair, 12)} fee ${pad(p.fee_setting, 8)} gap ${pad(fmt(p.gap_bps, 1), 8, 1)} bps  L ${p.pool_liquidity}  ${p.flags.join("; ")}`);

console.log("\nAnything odd:");
const notes = [];
for (const r of rows) {
  for (const f of r.flags) notes.push(`${r.symbol}: ${f}`);
  for (const p of [r.main_pool, ...(r.other_pools ?? [])]) if (p) for (const f of p.flags) notes.push(`${r.symbol} ${p.pair} ${p.pool_id.slice(0, 10)}: ${f}`);
}
for (const r of rows.filter((x) => x.feed_age_minutes > 12 * 60)) notes.push(`${r.symbol}: Chainlink feed last updated ${fmt(r.feed_age_minutes / 60, 1)} h ago (${r.chainlink_updated_at})`);
if (mults.length) {
  const v = mults.map((r) => r.ui_multiplier);
  console.log(`  - uiMultiplier differs from 1.0 on ${mults.length} of ${rows.length} tokens (${Math.min(...v).toFixed(5)} to ${Math.max(...v).toFixed(5)}); none has a pending change. Not applied to either side (both are per token), listed in the uiMult column.`);
}
if (notes.length === 0 && !mults.length) console.log("  (nothing)");
for (const n of notes) console.log("  - " + n);
