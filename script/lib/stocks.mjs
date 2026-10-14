// Shared discovery logic for script/build-stocks.mjs (one-off, from the local keeper cache) and script/refresh-stocks.mjs
// (weekly, from the chain). Plain Node, read-only. Nothing here sends a transaction or needs a secret.
import { batch, ethCall, words, toSigned, USDG, WETH, ZERO, FEEDS_URL, LATEST_ROUND_DATA, DECIMALS } from "./chain.mjs";

export const ASSETS_URL = "https://api.robinhood.com/rhj/assets"; // Robinhood's official Stock Token list
export const RULES = { minTvlUsd: 20_000, minSwaps: 100, minSenders: 10, days: 14, minDepthUsd: 1_000 };
export const low = (a) => a.toLowerCase();

// ---- data sources ----------------------------------------------------------------------------------------------------
/** Official Stock Token list, deployments on chain 4663: [{address, symbol, name, decimals}]. Throws on any problem. */
export async function fetchAssets(chainId = 4663) {
  const res = await fetch(ASSETS_URL);
  if (!res.ok) throw new Error(`assets API HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.assets)) throw new Error("assets API: unexpected shape");
  const out = [];
  for (const a of body.assets) {
    const d = (a.deployments ?? []).find((x) => x.chainId === chainId);
    if (d) out.push({ address: d.contractAddress, symbol: a.tokenSymbol, name: a.tokenName, decimals: Number(a.tokenDecimals ?? 18) });
  }
  return out;
}

/** Chainlink's feed directory -> Map(SYMBOL -> {proxy, name}) for "<SYM> / USD" feeds. */
export async function fetchFeedDirectory() {
  const res = await fetch(FEEDS_URL);
  if (!res.ok) throw new Error(`feed directory HTTP ${res.status}`);
  const dir = await res.json();
  if (!Array.isArray(dir)) throw new Error("feed directory: unexpected shape");
  const bySym = new Map();
  for (const f of dir) {
    const m = String(f.name).match(/^(?:Robinhood )?([A-Za-z0-9.]+)\s*[/-]\s*USD$/);
    if (m) bySym.set(m[1].toUpperCase(), { proxy: f.proxyAddress, name: f.name });
  }
  return { total: dir.length, bySym };
}

/** Reads decimals + latestRoundData of each feed at `block`: Map(SYMBOL -> {proxy,name,decimals,answer,updatedAt,error?}). */
export async function validateFeeds(symbols, bySym, block) {
  const list = [...symbols].filter((s) => bySym.has(s)).map((s) => ({ sym: s, ...bySym.get(s) }));
  const res = await batch(list.flatMap((f) => [ethCall(f.proxy, DECIMALS, block), ethCall(f.proxy, LATEST_ROUND_DATA, block)]));
  const info = new Map();
  list.forEach((f, i) => {
    const d = res[2 * i], r = res[2 * i + 1];
    if (d.error || r.error) return info.set(f.sym, { ...f, error: d.error || r.error });
    const dec = Number(words(d.result)[0]);
    const w = words(r.result);
    const answer = toSigned(w[1]);
    info.set(f.sym, { ...f, decimals: dec, answer: Number(answer) / 10 ** dec, updatedAt: Number(w[3]), error: answer > 0n ? undefined : "non-positive answer" });
  });
  return info;
}

// ---- tokens ---------------------------------------------------------------------------------------------------------
/** ctx: { stockByAddr: Map(lower addr -> asset), otherTokens: {lowerAddr: {address,symbol,decimals}} } */
export function describeToken(addr, ctx) {
  const k = low(addr);
  if (k === ZERO) return { address: ZERO, symbol: "ETH", decimals: 18, kind: "native-eth", feedSym: "ETH" };
  if (k === low(USDG)) return { address: USDG, symbol: "USDG", decimals: 6, kind: "usdg", feedSym: "USDG" };
  if (k === low(WETH)) return { address: WETH, symbol: "WETH", decimals: 18, kind: "weth", feedSym: "ETH" };
  const s = ctx.stockByAddr.get(k);
  if (s) return { address: s.address, symbol: s.symbol, decimals: s.decimals, kind: "stock", feedSym: s.symbol.toUpperCase() };
  const t = ctx.otherTokens?.[k];
  return t ? { address: t.address, symbol: t.symbol, decimals: t.decimals, kind: "other", feedSym: undefined } : undefined;
}

export function usable(feedInfo, sym) {
  const f = sym && feedInfo.get(sym);
  return f && !f.error ? f : undefined;
}

// ---- position / TVL maths (floating point is plenty for USD valuation; same formulas as keeper/src/discover.ts) -------
const sqrtAtTick = (tick) => Math.pow(1.0001, tick / 2);
export function positionAmounts(L, tickLower, tickUpper, sqrtP) {
  const sa = sqrtAtTick(tickLower), sb = sqrtAtTick(tickUpper);
  if (sqrtP <= sa) return { a0: L * (1 / sa - 1 / sb), a1: 0 };
  if (sqrtP >= sb) return { a0: 0, a1: L * (sb - sa) };
  return { a0: L * (1 / sqrtP - 1 / sb), a1: L * (sqrtP - sa) };
}

// ---- stock -> main pool selection (the rule used since 2026-10-08) -----------------------------------------------------
const RANK = { usdg: 0, weth: 1, "native-eth": 1, stock: 2 };

/**
 * qualifying: pools that PASS the rules, each { id, c0, c1, fee, tickSpacing, hooks, t0, t1, tvl, swaps, senders, pair, feeSetting, hookName }.
 * Returns { stocks, unresolved }: a stock with a usable feed and at least one qualifying pool whose other token has a usable USD
 * feed gets main_pool = the best pool (USDG quote first, then ETH/WETH, then another stock; highest TVL within a kind).
 */
export function selectStocks(assets, feedInfo, feedBySym, qualifying, thresholds = RULES) {
  const perStock = new Map();
  for (const q of qualifying) {
    for (const [self, other] of [[q.t0, q.t1], [q.t1, q.t0]]) {
      if (self.kind !== "stock") continue;
      if (!usable(feedInfo, other.feedSym)) continue;
      const key = low(self.address);
      if (!perStock.has(key)) perStock.set(key, []);
      perStock.get(key).push({ q, self, other });
    }
  }
  const stocks = [], unresolved = [];
  for (const t of assets) {
    const sym = t.symbol.toUpperCase();
    const feed = usable(feedInfo, sym);
    const cand = perStock.get(low(t.address)) ?? [];
    if (!feedBySym.has(sym)) { unresolved.push({ symbol: t.symbol, token: t.address, reason: "no Chainlink USD feed for this symbol in the feed directory" }); continue; }
    if (!feed) { unresolved.push({ symbol: t.symbol, token: t.address, feed: feedBySym.get(sym).proxy, reason: `feed unusable on-chain: ${feedInfo.get(sym)?.error ?? "unknown"}` }); continue; }
    if (cand.length === 0) { unresolved.push({ symbol: t.symbol, token: t.address, feed: feed.proxy, reason: `no pool with TVL >= $${thresholds.minTvlUsd}, >= ${thresholds.minSwaps} real swaps and >= ${thresholds.minSenders} senders against a token with a Chainlink USD feed` }); continue; }
    cand.sort((a, b) => RANK[a.other.kind] - RANK[b.other.kind] || b.q.tvl - a.q.tvl);
    const toPool = (c, main) => {
      const stockIsC0 = low(c.q.c0) === low(c.self.address);
      const qf = usable(feedInfo, c.other.feedSym);
      return {
        main,
        pool_id: c.q.id,
        pool_key: { currency0: c.q.c0, currency1: c.q.c1, fee: c.q.fee, tickSpacing: c.q.tickSpacing, hooks: c.q.hooks },
        stock_is_currency0: stockIsC0,
        quote: { symbol: c.other.symbol, token: c.other.address, decimals: c.other.decimals, kind: c.other.kind, feed: qf.proxy, feed_decimals: qf.decimals },
        pair: c.q.pair,
        fee_setting: c.q.feeSetting,
        hook_name: c.q.hookName,
        tvl_usd_at_discovery: c.q.tvl,
        real_swaps_14d_at_discovery: c.q.swaps,
        swap_senders_14d_at_discovery: c.q.senders,
      };
    };
    const [first, ...rest] = cand;
    stocks.push({
      symbol: t.symbol,
      name: t.name,
      token: t.address,
      decimals: t.decimals,
      feed: feed.proxy,
      feed_name: feed.name,
      feed_decimals: feed.decimals,
      main_pool: toPool(first, true),
      other_pools: rest.map((c) => toPool(c, false)),
    });
  }
  return { stocks, unresolved };
}

// ---- list changes: the safety rules ---------------------------------------------------------------------------------------
export const REMOVE_AFTER_FAILS = 3;
export const ADD_AFTER_PASSES = 2;

/**
 * Pure function. current: the tracked stocks (stocks.json "stocks"); passBySym: Map(symbol -> fresh entry) for stocks that pass
 * this refresh; st: per-stock counters (mutated); returns { nextStocks, events }.
 *  - tracked + fails: kept, marked "failing since <date>", removed only after REMOVE_AFTER_FAILS fails in a row;
 *  - not tracked + passes: added only after ADD_AFTER_PASSES passes in a row.
 */
export function applyHysteresis(current, passBySym, st, date, failNote = () => "") {
  const events = [], nextStocks = [];
  const trackedSyms = new Set(current.map((s) => s.symbol));
  for (const s of current) {
    const c = (st[s.symbol] ??= { status: "tracked", passes: ADD_AFTER_PASSES, fails: 0, tracked_since: date });
    const hit = passBySym.get(s.symbol);
    if (hit) {
      if (c.fails > 0) events.push({ date, type: "recovered", symbol: s.symbol, note: `passes again after ${c.fails} failed refresh(es)` });
      Object.assign(c, { status: "tracked", fails: 0, failing_since: null, last_pass: date, passes: ADD_AFTER_PASSES });
      nextStocks.push({ ...hit, status: "tracked", tracked_since: c.tracked_since });
    } else {
      c.fails = (c.fails ?? 0) + 1;
      c.passes = 0;
      if (c.fails === 1) {
        c.failing_since = date;
        events.push({ date, type: "flagged", symbol: s.symbol, note: `failing since ${date}${failNote(s) ? " (" + failNote(s) + ")" : ""}` });
      }
      if (c.fails >= REMOVE_AFTER_FAILS) {
        c.status = "removed";
        c.removed_on = date;
        events.push({ date, type: "removed", symbol: s.symbol, note: `failed ${c.fails} refreshes in a row since ${c.failing_since}` });
      } else {
        c.status = "failing";
        nextStocks.push({ ...s, status: "failing", failing_since: c.failing_since, tracked_since: c.tracked_since });
      }
    }
  }
  for (const [sym, hit] of passBySym) {
    if (trackedSyms.has(sym)) continue;
    const c = (st[sym] ??= { status: "candidate", passes: 0, fails: 0 });
    c.passes = (c.status === "removed" ? 0 : c.passes ?? 0) + 1;
    c.fails = 0;
    c.last_pass = date;
    if (c.passes >= ADD_AFTER_PASSES) {
      Object.assign(c, { status: "tracked", tracked_since: date, failing_since: null });
      events.push({ date, type: "added", symbol: sym, note: `passed ${c.passes} refreshes in a row` });
      nextStocks.push({ ...hit, status: "tracked", tracked_since: date });
    } else {
      c.status = "pending";
      events.push({ date, type: "pending", symbol: sym, note: `passed once (needs ${ADD_AFTER_PASSES} in a row)` });
    }
  }
  // a candidate that did not pass this time starts over
  for (const [sym, c] of Object.entries(st)) {
    if (!passBySym.has(sym) && !trackedSyms.has(sym) && c.status === "pending") { c.passes = 0; c.status = "candidate"; }
  }
  return { nextStocks, events };
}
