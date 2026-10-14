// Tests for the list-change safety rules (script/lib/stocks.mjs applyHysteresis). No network.  node script/test-refresh-rules.mjs
import assert from "node:assert/strict";
import { applyHysteresis, REMOVE_AFTER_FAILS, ADD_AFTER_PASSES } from "./lib/stocks.mjs";

const entry = (symbol) => ({ symbol, token: "0x" + symbol, main_pool: { pool_id: "0x" + symbol }, other_pools: [] });
const pass = (...syms) => new Map(syms.map((s) => [s, entry(s)]));
const symbols = (r) => r.nextStocks.map((s) => s.symbol).sort().join(",");
const types = (r, t) => r.events.filter((e) => e.type === t).map((e) => e.symbol).join(",");
let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok  " + name); };

test("constants: removal after 3 fails, addition after 2 passes", () => {
  assert.equal(REMOVE_AFTER_FAILS, 3);
  assert.equal(ADD_AFTER_PASSES, 2);
});

test("a tracked stock that fails once is kept and marked failing since the date", () => {
  const st = {};
  const r = applyHysteresis([entry("AAA"), entry("BBB")], pass("BBB"), st, "2026-10-21");
  assert.equal(symbols(r), "AAA,BBB");
  assert.equal(r.nextStocks.find((s) => s.symbol === "AAA").status, "failing");
  assert.equal(r.nextStocks.find((s) => s.symbol === "AAA").failing_since, "2026-10-21");
  assert.equal(types(r, "flagged"), "AAA");
  assert.equal(types(r, "removed"), "");
});

test("removed only on the 3rd failed refresh in a row", () => {
  const st = {};
  let cur = [entry("AAA")];
  let r = applyHysteresis(cur, pass(), st, "2026-10-21"); cur = r.nextStocks;
  assert.equal(symbols(r), "AAA");
  r = applyHysteresis(cur, pass(), st, "2026-10-28"); cur = r.nextStocks;
  assert.equal(symbols(r), "AAA");
  assert.equal(types(r, "flagged"), ""); // flagged only once
  assert.equal(r.nextStocks[0].failing_since, "2026-10-21");
  r = applyHysteresis(cur, pass(), st, "2026-11-04");
  assert.equal(symbols(r), "");
  assert.equal(types(r, "removed"), "AAA");
  assert.match(r.events.find((e) => e.type === "removed").note, /since 2026-10-21/);
});

test("a failing stock that passes again recovers and the count restarts", () => {
  const st = {};
  let cur = [entry("AAA")];
  let r = applyHysteresis(cur, pass(), st, "d1"); cur = r.nextStocks;
  r = applyHysteresis(cur, pass(), st, "d2"); cur = r.nextStocks;
  r = applyHysteresis(cur, pass("AAA"), st, "d3"); cur = r.nextStocks;
  assert.equal(types(r, "recovered"), "AAA");
  assert.equal(cur[0].status, "tracked");
  r = applyHysteresis(cur, pass(), st, "d4"); // one new failure, not the third in total
  assert.equal(symbols(r), "AAA");
  assert.equal(st.AAA.fails, 1);
});

test("a new stock needs 2 passes in a row; one pass is only pending and not in the list", () => {
  const st = {};
  let r = applyHysteresis([], pass("NEW"), st, "d1");
  assert.equal(symbols(r), "");
  assert.equal(types(r, "pending"), "NEW");
  r = applyHysteresis([], pass("NEW"), st, "d2");
  assert.equal(symbols(r), "NEW");
  assert.equal(types(r, "added"), "NEW");
  assert.equal(r.nextStocks[0].tracked_since, "d2");
});

test("pass, fail, pass does not add (the streak must be unbroken)", () => {
  const st = {};
  applyHysteresis([], pass("NEW"), st, "d1");
  applyHysteresis([], pass(), st, "d2");
  const r = applyHysteresis([], pass("NEW"), st, "d3");
  assert.equal(symbols(r), "");
  assert.equal(types(r, "pending"), "NEW");
});

test("a removed stock must pass twice again to come back", () => {
  const st = { OLD: { status: "removed", passes: 0, fails: 3, removed_on: "d0" } };
  let r = applyHysteresis([], pass("OLD"), st, "d1");
  assert.equal(symbols(r), "");
  r = applyHysteresis([], pass("OLD"), st, "d2");
  assert.equal(symbols(r), "OLD");
});

test("nothing changes when everything passes", () => {
  const st = {};
  const r = applyHysteresis([entry("AAA"), entry("BBB")], pass("AAA", "BBB"), st, "d1");
  assert.equal(symbols(r), "AAA,BBB");
  assert.equal(r.events.length, 0);
});

console.log(`\n${n} tests passed`);
