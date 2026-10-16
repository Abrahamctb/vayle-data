// Unit tests for the alert rules and message (script/alert.mjs). No network, no secrets.  node script/test-alert.mjs
import assert from "node:assert/strict";
import { qualifies, selectAlerts, buildMessage, feeInfo, MAX_PER_RUN, COOLDOWN_MS, selectClosed, buildClosedMessage, CLOSE_WINDOW_MS } from "./alert.mjs";

// a stock record as it appears in gap-snapshot.json: fee_setting is the pool's fee in pips (10,000 = 1% = 100 bps)
const stock = (symbol, gap, feePips, extra = {}) => ({
  symbol, gap_bps: gap, chainlink_price_usd: 100, pool_price_usd: 100 * (1 + gap / 1e4), feed_age_minutes: 5,
  main_pool: { fee_setting: String(feePips) }, ...extra,
});
const NOW = Date.parse("2026-10-15T10:00:00Z");
const snap = (...stocks) => ({ snapshot_at: new Date(NOW - 5 * 60000).toISOString(), stocks });
const syms = (r) => r.map((s) => s.symbol).join(",");
let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok  " + name); };

// ---- the new size rule -------------------------------------------------------------------------------------------------
test("MU-like: gap 107.2 bps with a 1% (100 bps) fee does NOT alert (needs 120)", () => {
  assert.equal(qualifies(stock("MU", 107.2, 10000)), false);
  assert.equal(syms(selectAlerts(snap(stock("MU", 107.2, 10000)), {}, NOW)), "");
});
test("gap 130 with a 1% fee alerts, and says 30 bps are left after the fee", () => {
  const s = stock("AAA", 130, 10000);
  assert.equal(qualifies(s), true);
  const m = buildMessage(s, "2026-10-15T09:55:00Z");
  assert.match(m, /gap \+130 bps \(pool above\)/);
  assert.match(m, /Pool fee 1% \(100 bps\), gap after fee 30 bps \(before gas\)\./);
});
test("gap 130 with a 0.3% (30 bps) fee alerts, 100 bps after the fee", () => {
  const s = stock("BBB", -130, 3000);
  assert.equal(qualifies(s), true);
  const m = buildMessage(s, "2026-10-15T09:55:00Z");
  assert.match(m, /gap -130 bps \(pool below\)/);
  assert.match(m, /Pool fee 0\.3% \(30 bps\), gap after fee 100 bps \(before gas\)\./);
});
test("boundaries: exactly fee + 20 alerts, just under does not; 100 bps floor still applies to cheap pools", () => {
  assert.equal(qualifies(stock("X", 120, 10000)), true);
  assert.equal(qualifies(stock("X", 119.9, 10000)), false);
  assert.equal(qualifies(stock("X", 100, 500)), true);   // 5 bps fee: 100 >= 25 and >= 100
  assert.equal(qualifies(stock("X", 99.9, 500)), false); // under the 100 floor
  assert.equal(qualifies(stock("X", 100, 8000)), true);  // 80 bps fee: needs 100, has 100
  assert.equal(qualifies(stock("X", 100, 8100)), false); // 81 bps fee: needs 101, has 100
});
test("dynamic-fee pool (flag 8388608) alerts at 105 bps and says \"dynamic fee\"; at 99 it does not", () => {
  const s = stock("DYN", 105, 8388608);
  assert.equal(qualifies(s), true);
  const m = buildMessage(s, "2026-10-15T09:55:00Z");
  assert.match(m, /dynamic fee/);
  assert.doesNotMatch(m, /gap after fee \d/);
  assert.equal(qualifies(stock("DYN", 99, 8388608)), false);
});
test("unknown fee falls back to the plain 100 bps rule and says so", () => {
  const s = stock("UNK", 110, "n/a");
  assert.equal(qualifies(s), true);
  assert.match(buildMessage(s, "2026-10-15T09:55:00Z"), /Pool fee unknown/);
  assert.deepEqual(feeInfo(s), { dynamic: false, bps: null });
});

// ---- message contents -------------------------------------------------------------------------------------------------------
test("message has the link, the snapshot time, plain wording, and the feed-age note only over 60 minutes", () => {
  const m = buildMessage(stock("TSLA", 140, 10000), "2026-10-15T14:12:09Z");
  assert.match(m, /^TSLA: pool \$100\.00 vs Chainlink \$100\.00|^TSLA: pool \$101\.40 vs Chainlink \$100\.00/);
  assert.match(m, /Snapshot 14:12 UTC\./);
  assert.match(m, /https:\/\/usevayle\.com\/#TSLA$/);
  assert.doesNotMatch(m, /feed last updated/);
  assert.doesNotMatch(m, /\b(buy|sell|should|will|predict|advice)\b/i);
  const old = buildMessage(stock("TSLA", 140, 10000, { feed_age_minutes: 180 }), "2026-10-15T14:12:09Z");
  assert.match(old, /Chainlink feed last updated 3 h ago\./);
  assert.match(buildMessage(stock("BRK.B", 140, 10000), "2026-10-15T14:12:09Z"), /#BRK\.B$/);
});

// ---- unchanged behaviour: cooldown, cap, order ------------------------------------------------------------------------------------
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
test("cooldown: within 6 h the same gap is suppressed", () => {
  const st = { AAA: { gap_bps: 130, alerted_at: hoursAgo(1) } };
  assert.equal(syms(selectAlerts(snap(stock("AAA", 135, 10000)), st, NOW)), "");
});
test("cooldown: a gap that grew by 50+ bps alerts again", () => {
  const st = { AAA: { gap_bps: 130, alerted_at: hoursAgo(1) } };
  assert.equal(syms(selectAlerts(snap(stock("AAA", 185, 10000)), st, NOW)), "AAA");
});
test("cooldown: a sign flip alerts again", () => {
  const st = { AAA: { gap_bps: 130, alerted_at: hoursAgo(1) } };
  assert.equal(syms(selectAlerts(snap(stock("AAA", -140, 10000)), st, NOW)), "AAA");
});
test("cooldown: after 6 h the same gap alerts again", () => {
  const st = { AAA: { gap_bps: 130, alerted_at: hoursAgo(7) } };
  assert.equal(syms(selectAlerts(snap(stock("AAA", 130, 10000)), st, NOW)), "AAA");
  assert.equal(COOLDOWN_MS, 6 * 3600 * 1000);
});
test("a gap that grew but no longer clears fee + 20 does not alert (the size rule comes first)", () => {
  const st = { MU: { gap_bps: 60, alerted_at: hoursAgo(1) } };
  assert.equal(syms(selectAlerts(snap(stock("MU", 110, 10000)), st, NOW)), "");
});
test("max 5 per run, largest |gap| first; the rest wait for the next run", () => {
  const stocks = [150, 400, 250, 180, 300, 220, 500].map((g, i) => stock("S" + i, i % 2 ? -g : g, 10000));
  const r = selectAlerts(snap(...stocks), {}, NOW);
  assert.equal(r.length, MAX_PER_RUN);
  assert.deepEqual(r.map((s) => Math.abs(s.gap_bps)), [500, 400, 300, 250, 220]);
});

// ---- gap closed follow-up ----------------------------------------------------------------------------------------------
const alerted = (gap, minsAgo, extra = {}) => ({ gap_bps: gap, alerted_at: new Date(NOW - minsAgo * 60000).toISOString(), ...extra });
test("an alerted gap that is now within 50 bps is reported closed, once", () => {
  const st = { AAA: alerted(130, 180) };
  assert.equal(syms(selectClosed(snap(stock("AAA", 12, 3000)), st, NOW).map((c) => c.stock)), "AAA");
  assert.equal(selectClosed(snap(stock("AAA", 12, 3000)), { AAA: alerted(130, 180, { closed_at: "2026-10-15T09:00:00Z" }) }, NOW).length, 0);
});
test("not closed while |gap| is above 50 bps, at the boundary, or when the sign flips but stays large", () => {
  const st = { AAA: alerted(130, 180), BBB: alerted(130, 180), CCC: alerted(130, 180) };
  assert.equal(selectClosed(snap(stock("AAA", 80, 3000), stock("CCC", -70, 3000)), st, NOW).length, 0);
  assert.equal(syms(selectClosed(snap(stock("BBB", -50, 3000)), st, NOW).map((c) => c.stock)), "BBB");
});
test("old alerts (over 24 h) and stocks never alerted are not followed up", () => {
  const st = { AAA: alerted(130, 24 * 60 + 5) };
  assert.equal(selectClosed(snap(stock("AAA", 5, 3000), stock("ZZZ", 5, 3000)), st, NOW).length, 0);
});
test("closed message: says gap closed, shows before and after, no advice words", () => {
  const m = buildClosedMessage(stock("AAA", 12, 3000), alerted(130, 180), "2026-10-15T09:55:00Z");
  assert.match(m, /^AAA: gap closed\. Now \+12 bps \(was \+130 bps when alerted at 07:00 UTC\)/);
  assert.doesNotMatch(m, /buy|sell|profit|opportunity|arbitrage/i);
});
test("a new alert for the same stock replaces the state entry, so the closed flag is cleared", () => {
  const st = { AAA: alerted(130, 400, { closed_at: "2026-10-15T05:00:00Z" }) };
  const picked = selectAlerts(snap(stock("AAA", 135, 3000)), st, NOW);
  assert.equal(syms(picked), "AAA"); // cooldown over -> alerts again; main() writes a fresh entry without closed_at
});

console.log(`\n${n} tests passed`);
