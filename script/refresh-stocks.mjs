// Weekly refresh of stocks.json: re-runs the discovery rules from the chain and applies safety rules before changing the list.
// READ-ONLY (eth_call / eth_getLogs / eth_blockNumber / eth_getBlockByNumber + two public HTTP lists). No keys, no secrets.
//
//   node script/refresh-stocks.mjs [--dry-run] [--max-pools N] [--dir <folder with the three files>]
//
// Rules (the same as the 2026-10-08 discovery): the stock token has a Chainlink USD feed and one of its pools, valued at the
// current price, has TVL >= $20,000, >= 100 real swaps (both amounts non-zero) and >= 10 distinct swap senders in 14 days.
// Safety:
//   - a tracked stock that fails is NOT removed: it is marked "failing since <date>" and removed after 3 failed refreshes in a row;
//   - a new stock is added only after it passes 2 refreshes in a row;
//   - if a data source errors, or far fewer results than last time come back (< 50%), the old list is kept unchanged and the
//     script exits 0 so it never breaks the snapshot workflow;
//   - gap-snapshot.json and history.json are never touched (history of removed stocks stays).
// Files: stocks.json (the list), stocks-state.json (pool index, positions, per-stock counters), stocks-changes.json (change log).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  rpc, batch, ethCall, words, selfTestKeccak, poolSlot, slotPlus, getLogsChunked, stats, EXTSLOAD, TOPIC, addrTopic,
  decodeInitialize, decodeModify, decodeSwap, POOL_MANAGER, USDG, WETH, ZERO, CHAIN_ID, RPC,
} from "./lib/chain.mjs";
import { RULES, low, fetchAssets, fetchFeedDirectory, validateFeeds, describeToken, usable, positionAmounts, selectStocks, applyHysteresis } from "./lib/stocks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && !process.argv[i + 1]?.startsWith("--") ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry-run");
const MAX_POOLS = Number(arg("--max-pools", process.env.REFRESH_MAX_POOLS ?? 400));
const DIR = arg("--dir", ROOT); // where stocks.json, stocks-state.json and stocks-changes.json live (tests use a temp dir)
const PATHS = { stocks: join(DIR, "stocks.json"), state: join(DIR, "stocks-state.json"), changes: join(DIR, "stocks-changes.json") };
const MIN_RESULT_RATIO = 0.5;
const iso = (t) => new Date(t * 1000).toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const t0 = Date.now();
const log = (m) => console.log(m);

/** Anything that must stop the refresh WITHOUT changing the list. */
class Keep extends Error {}

async function main() {
  selfTestKeccak();
  if (!existsSync(PATHS.state) || !existsSync(PATHS.stocks)) throw new Keep("stocks-state.json or stocks.json is missing (run script/seed-stocks-state.mjs once)");
  const state = JSON.parse(readFileSync(PATHS.state, "utf8"));
  const current = JSON.parse(readFileSync(PATHS.stocks, "utf8"));
  const changes = existsSync(PATHS.changes) ? JSON.parse(readFileSync(PATHS.changes, "utf8")) : { last_refreshed: null, events: [] };

  // ---- chain head -------------------------------------------------------------------------------------------------
  const chainId = parseInt(await rpc("eth_chainId"), 16);
  if (chainId !== CHAIN_ID) throw new Keep(`RPC is chain ${chainId}, expected ${CHAIN_ID}`);
  const headNum = parseInt(await rpc("eth_blockNumber"), 16);
  const head = await rpc("eth_getBlockByNumber", ["0x" + headNum.toString(16), false]);
  const headTs = parseInt(head.timestamp, 16);
  const BLOCK = "0x" + headNum.toString(16);
  log(`chain ${chainId}, head ${headNum} (${iso(headTs)}), RPC ${RPC}${DRY ? ", DRY RUN" : ""}`);

  // ---- 1. assets and feeds ------------------------------------------------------------------------------------------
  let assets;
  try { assets = await fetchAssets(); } catch (e) { throw new Keep(`Robinhood asset list unavailable: ${e.message}`); }
  if (assets.length < MIN_RESULT_RATIO * (state.assets_count ?? 1)) throw new Keep(`asset list has ${assets.length} tokens, last time ${state.assets_count}`);
  let dir;
  try { dir = await fetchFeedDirectory(); } catch (e) { throw new Keep(`Chainlink feed directory unavailable: ${e.message}`); }
  const symbols = new Set([...assets.map((a) => a.symbol.toUpperCase()), "USDG", "ETH"]);
  const feedInfo = await validateFeeds(symbols, dir.bySym, BLOCK);
  const stockFeeds = assets.filter((a) => usable(feedInfo, a.symbol.toUpperCase()));
  if (!usable(feedInfo, "USDG") || !usable(feedInfo, "ETH")) throw new Keep("USDG or ETH USD feed unusable");
  if (stockFeeds.length < MIN_RESULT_RATIO * (state.feeds_count ?? 1)) throw new Keep(`only ${stockFeeds.length} stock feeds usable, last time ${state.feeds_count}`);
  log(`assets ${assets.length}; usable stock feeds ${stockFeeds.length} (last time ${state.feeds_count})`);

  const ctx = { stockByAddr: new Map(assets.map((a) => [low(a.address), a])), otherTokens: {} };
  const priceOf = (addr) => {
    const t = describeToken(addr, ctx);
    const f = t && usable(feedInfo, t.feedSym);
    return f ? f.answer : undefined;
  };
  const feedStockAddrs = new Set(stockFeeds.map((a) => low(a.address)));

  // ---- 2. pool index: new pools since the last scan, and pools of stocks that just got a feed ---------------------------
  const pools = state.pools;
  let added = 0;
  const addPool = (p) => {
    if (pools[p.id]) return;
    const a = describeToken(p.c0, ctx), b = describeToken(p.c1, ctx);
    if (!a || !b || !(a.kind === "stock" || b.kind === "stock")) return; // a pair of non-stock tokens is not ours
    if (!(feedStockAddrs.has(low(p.c0)) || feedStockAddrs.has(low(p.c1)))) return;
    if (!usable(feedInfo, a.feedSym) || !usable(feedInfo, b.feedSym)) return; // both sides must have a USD price
    pools[p.id] = { c0: p.c0, c1: p.c1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, created: p.block, mod_block: null, ranges: {} };
    added++;
  };
  const initTopics = (pos, addrs) => (pos === 0 ? [TOPIC.Initialize, null, addrs, null] : [TOPIC.Initialize, null, null, addrs]);
  const from = (state.init_scanned_block ?? 0) + 1;
  const addrTopics = [...feedStockAddrs].map(addrTopic);
  for (const pos of [0, 1]) {
    const logs = await getLogsChunked({ address: POOL_MANAGER, topics: initTopics(pos, addrTopics) }, from, headNum, 100_000);
    for (const l of logs) addPool(decodeInitialize(l));
  }
  // stocks that gained a feed since the last refresh: their older pools are not in the index yet
  const known = new Set((state.feed_stocks ?? []).map(low)); // compare lower-case: the seeded list is checksummed
  const gained = stockFeeds.filter((a) => !known.has(low(a.address)));
  if (known.size > 0) {
    for (const a of gained) {
      for (const pos of [0, 1]) {
        const logs = await getLogsChunked({ address: POOL_MANAGER, topics: initTopics(pos, [addrTopic(a.address)]) }, 0, headNum, 9_000_000);
        for (const l of logs) addPool(decodeInitialize(l));
      }
    }
  }
  log(`pool index: ${Object.keys(pools).length} priced pairs (+${added} new); stocks that gained a feed: ${gained.map((g) => g.symbol).join(",") || "none"}`);

  // ---- 3. live price and in-range liquidity of every indexed pool ------------------------------------------------------
  const ids = Object.keys(pools);
  const calls = ids.flatMap((id) => { const s = poolSlot(id); return [ethCall(POOL_MANAGER, EXTSLOAD + s.slice(2), BLOCK), ethCall(POOL_MANAGER, EXTSLOAD + slotPlus(s, 3).slice(2), BLOCK)]; });
  const res = await batch(calls, 50, 100);
  const live = new Map();
  let readErrors = 0;
  ids.forEach((id, i) => {
    const a = res[2 * i], b = res[2 * i + 1];
    if (a.error || b.error) { readErrors++; return; }
    const w0 = BigInt(a.result), wl = BigInt(b.result);
    live.set(id, { sqrtP: Number(w0 & ((1n << 160n) - 1n)) / 2 ** 96, L: wl & ((1n << 128n) - 1n) });
  });
  if (readErrors > 0.2 * ids.length) throw new Keep(`${readErrors} of ${ids.length} pool state reads failed`);

  // ---- 4. shortlist: liquidity now and in-range depth >= $1,000 --------------------------------------------------------
  const tokenMeta = (addr) => describeToken(addr, ctx);
  const depthUsd = (id) => {
    const p = pools[id], s = live.get(id);
    if (!s || s.L === 0n || s.sqrtP === 0) return undefined;
    const a = tokenMeta(p.c0), b = tokenMeta(p.c1), pa = priceOf(p.c0), pb = priceOf(p.c1);
    if (!a || !b || pa === undefined || pb === undefined) return undefined;
    const L = Number(s.L);
    return (L / s.sqrtP / 10 ** a.decimals) * pa + ((L * s.sqrtP) / 10 ** b.decimals) * pb;
  };
  const shortlist = ids.map((id) => ({ id, d: depthUsd(id) })).filter((x) => x.d !== undefined && x.d >= RULES.minDepthUsd).sort((x, y) => y.d - x.d);
  const capped = shortlist.slice(0, MAX_POOLS);
  log(`pools with liquidity and in-range depth >= $${RULES.minDepthUsd}: ${shortlist.length}${shortlist.length > MAX_POOLS ? ` (evaluating the ${MAX_POOLS} deepest)` : ""}`);

  // ---- 5. positions (incremental ModifyLiquidity) -> TVL ---------------------------------------------------------------------
  for (const { id } of capped) {
    const p = pools[id];
    const start = (p.mod_block ?? Math.max(p.created - 1, 0)) + 1;
    if (start > headNum) continue;
    const logs = await getLogsChunked({ address: POOL_MANAGER, topics: [TOPIC.ModifyLiquidity, id] }, start, headNum, 9_000_000);
    for (const l of logs) {
      const m = decodeModify(l);
      const k = `${m.lo}:${m.hi}`;
      p.ranges[k] = (BigInt(p.ranges[k] ?? "0") + m.delta).toString();
    }
    p.mod_block = headNum;
  }
  const tvlOf = (id) => {
    const p = pools[id], s = live.get(id);
    const a = tokenMeta(p.c0), b = tokenMeta(p.c1), pa = priceOf(p.c0), pb = priceOf(p.c1);
    let a0 = 0, a1 = 0;
    for (const [k, v] of Object.entries(p.ranges)) {
      const L = BigInt(v);
      if (L <= 0n) continue;
      const [lo, hi] = k.split(":").map(Number);
      const x = positionAmounts(Number(L), lo, hi, s.sqrtP);
      a0 += x.a0 / 10 ** a.decimals;
      a1 += x.a1 / 10 ** b.decimals;
    }
    return a0 * pa + a1 * pb;
  };

  // ---- 6. swaps and senders over 14 days (newest first, stop as soon as both thresholds are met) -----------------------------
  const refBlock = headNum - 5_000_000;
  const refTs = parseInt((await rpc("eth_getBlockByNumber", ["0x" + refBlock.toString(16), false])).timestamp, 16);
  const rate = 5_000_000 / (headTs - refTs); // blocks per second
  const sinceBlock = headNum - Math.floor(RULES.days * 86400 * rate);
  const evals = [];
  for (const { id, d } of capped) {
    const p = pools[id];
    const tvl = tvlOf(id);
    const row = { id, depth: d, tvl, swaps: 0, senders: 0, scanned: false, early: false };
    // swaps are only needed to decide a pass (TVL >= limit); pools within 50% of the TVL limit are scanned too, for the report
    if (tvl >= RULES.minTvlUsd * 0.5) {
      const senders = new Set();
      const STEP = 300_000;
      for (let hi = headNum; hi >= sinceBlock; hi -= STEP) {
        const lo = Math.max(hi - STEP + 1, sinceBlock);
        const logs = await getLogsChunked({ address: POOL_MANAGER, topics: [TOPIC.Swap, id] }, lo, hi, STEP);
        for (const l of logs) {
          const s = decodeSwap(l);
          if (s.a0 !== 0n && s.a1 !== 0n) { row.swaps++; senders.add(s.sender); }
        }
        row.senders = senders.size;
        row.scanned = true;
        if (row.swaps >= RULES.minSwaps && senders.size >= RULES.minSenders) { row.early = hi - STEP >= sinceBlock; break; } // early exit: counts are lower bounds
      }
    }
    evals.push(row);
  }
  const evalById = new Map(evals.map((e) => [e.id, e]));
  const passing = evals.filter((e) => e.tvl >= RULES.minTvlUsd && e.swaps >= RULES.minSwaps && e.senders >= RULES.minSenders);
  log(`evaluated ${evals.length} pools; passing the rules: ${passing.length}`);

  // ---- 7. stock-level decision --------------------------------------------------------------------------------------------
  const qualifying = passing.map((e) => {
    const p = pools[e.id], a = tokenMeta(p.c0), b = tokenMeta(p.c1);
    const prev = findPool(current, e.id);
    return {
      id: e.id, c0: p.c0, c1: p.c1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, t0: a, t1: b, tvl: Math.round(e.tvl * 100) / 100,
      swaps: e.swaps, senders: e.senders, pair: `${a.symbol}/${b.symbol}`, feeSetting: String(p.fee),
      hookName: prev?.hook_name ?? (low(p.hooks) === ZERO ? "(none)" : `hook ${p.hooks.slice(0, 10)}`),
    };
  });
  const selection = selectStocks(assets, feedInfo, dir.bySym, qualifying);
  const passBySym = new Map(selection.stocks.map((s) => [s.symbol, s]));
  const trackedNow = current.stocks.length;
  if (trackedNow > 0 && passBySym.size < MIN_RESULT_RATIO * trackedNow) {
    throw new Keep(`only ${passBySym.size} stocks pass, last list had ${trackedNow}: treating this as a data problem, list unchanged`);
  }

  // ---- 8. hysteresis (pure function in lib/stocks.mjs, unit-tested) -----------------------------------------------------------
  const date = today();
  const st = state.stocks ?? {};
  const failNote = (s) => failReason(s, evalById, pools, live, feedInfo);
  const { nextStocks, events } = applyHysteresis(current.stocks, passBySym, st, date, failNote);

  // ---- report ----------------------------------------------------------------------------------------------------------------------
  const edges = [];
  for (const e of evals) {
    const near = (v, limit, tol) => v >= limit * (1 - tol) && v <= limit * (1 + tol);
    const complete = e.scanned && !e.early; // counts are exact only when the whole 14 days were read
    if (near(e.tvl, RULES.minTvlUsd, 0.25) || (e.tvl >= RULES.minTvlUsd && complete && (near(e.swaps, RULES.minSwaps, 0.25) || Math.abs(e.senders - RULES.minSenders) <= 2))) {
      const p = pools[e.id], a = tokenMeta(p.c0), b = tokenMeta(p.c1);
      edges.push(`${a.symbol}/${b.symbol} ${e.id.slice(0, 10)}: TVL $${Math.round(e.tvl).toLocaleString("en-US")}, swaps ${e.scanned ? (e.early ? ">=" : "") + e.swaps : "not counted"}, senders ${e.scanned ? (e.early ? ">=" : "") + e.senders : "not counted"}`);
    }
  }
  log("\n=== result ===");
  log(`stocks tracked now ${trackedNow}; passing this refresh ${passBySym.size}; list after ${nextStocks.length}`);
  for (const t of ["added", "pending", "flagged", "recovered", "removed"]) {
    const list = events.filter((e) => e.type === t);
    log(`${t.padEnd(9)}: ${list.length ? list.map((e) => `${e.symbol} (${e.note})`).join("; ") : "none"}`);
  }
  log(`pools at the edge of the limits (${edges.length}): ${edges.length ? "\n  " + edges.join("\n  ") : "none"}`);
  const stillFailing = nextStocks.filter((s) => s.status === "failing").map((s) => `${s.symbol} since ${s.failing_since}`);
  log(`currently failing (kept): ${stillFailing.join(", ") || "none"}`);

  // others with a feed that do not pass: why
  const trackedAfter = new Set(nextStocks.map((s) => s.symbol));
  const why = [];
  for (const a of stockFeeds) {
    if (trackedAfter.has(a.symbol) || passBySym.has(a.symbol)) continue;
    why.push(`${a.symbol}: ${failReason({ symbol: a.symbol, token: a.address }, evalById, pools, live, feedInfo)}`);
  }
  log(`stocks with a USD feed that are not tracked (${why.length}):\n  ${why.join("\n  ")}`);

  // ---- write -----------------------------------------------------------------------------------------------------------------------
  const elapsed = (Date.now() - t0) / 1000;
  log(`\nelapsed ${elapsed.toFixed(0)} s; RPC requests ${stats.requests} (${stats.subcalls} calls incl. batched); range splits ${stats.splits}`);
  if (DRY) { log("DRY RUN: nothing written"); return; }
  state.init_scanned_block = headNum;
  state.last_refresh_block = headNum;
  state.updated_at = iso(headTs);
  state.assets_count = assets.length;
  state.feeds_count = stockFeeds.length;
  state.feed_stocks = [...feedStockAddrs];
  state.stocks = st;
  const out = {
    ...current,
    generated_at: iso(headTs),
    last_refreshed: date,
    discovery: "weekly refresh (script/refresh-stocks.mjs): TVL, swaps and senders are as of the refresh; liquidity and prices are re-read live by gap-snapshot.mjs",
    counts: { stock_tokens: assets.length, with_feed: stockFeeds.length, resolved: nextStocks.length, pools_total: nextStocks.reduce((n, s) => n + 1 + s.other_pools.length, 0), unresolved: selection.unresolved.length },
    stocks: nextStocks,
    unresolved: selection.unresolved,
  };
  changes.last_refreshed = date;
  changes.events.push(...events);
  if (!events.length) changes.events.push({ date, type: "refresh", symbol: "-", note: "no changes" });
  writeFileSync(PATHS.state, JSON.stringify(state));
  writeFileSync(PATHS.stocks, JSON.stringify(out, null, 1));
  writeFileSync(PATHS.changes, JSON.stringify(changes, null, 1));
  log("wrote stocks.json, stocks-state.json, stocks-changes.json");
}

function findPool(current, id) {
  for (const s of current.stocks) for (const p of [s.main_pool, ...s.other_pools]) if (p.pool_id === id) return p;
  return undefined;
}

/** One line on why a stock is not passing (best pool by TVL among the evaluated ones). */
function failReason(stock, evalById, pools, live, feedInfo) {
  const sym = stock.symbol.toUpperCase();
  if (!usable(feedInfo, sym)) return "no usable Chainlink USD feed";
  const mine = Object.entries(pools).filter(([, p]) => low(p.c0) === low(stock.token) || low(p.c1) === low(stock.token));
  if (mine.length === 0) return "no pool against a priced token (USDG, ETH, or another stock with a feed) found";
  const withLiq = mine.filter(([id]) => (live.get(id)?.L ?? 0n) > 0n);
  if (withLiq.length === 0) return `${mine.length} pool(s), none with liquidity right now`;
  const evaluated = withLiq.map(([id]) => evalById.get(id)).filter(Boolean).sort((a, b) => b.tvl - a.tvl);
  if (evaluated.length === 0) return `${withLiq.length} pool(s) with liquidity but in-range depth under $${RULES.minDepthUsd}`;
  const e = evaluated[0];
  const fails = [];
  if (e.tvl < RULES.minTvlUsd) fails.push(`TVL $${Math.round(e.tvl).toLocaleString("en-US")} < $${RULES.minTvlUsd.toLocaleString("en-US")}` + (e.scanned ? ` (${e.swaps} swaps, ${e.senders} senders)` : ""));
  if (e.tvl >= RULES.minTvlUsd) {
    if (e.swaps < RULES.minSwaps) fails.push(`${e.swaps} swaps < ${RULES.minSwaps}`);
    if (e.senders < RULES.minSenders) fails.push(`${e.senders} senders < ${RULES.minSenders}`);
  }
  return `best pool ${e.id.slice(0, 10)}: ${fails.join(", ") || "passes by itself; its counterparty has no USD feed"}`;
}

main().catch((e) => {
  if (e instanceof Keep) {
    console.log(`refresh: KEEPING THE OLD LIST. Reason: ${e.message}`);
    process.exit(0);
  }
  console.log(`refresh: ERROR, old list kept. ${String(e?.message ?? e).slice(0, 300)}`);
  process.exit(0); // never fail the workflow, the snapshot job must not be affected
});
