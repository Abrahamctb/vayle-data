// Fault test: a 429 in the middle of a real refresh (dry-run data, temp copy of the list files).
// Expects: exit 0, stocks.json and stocks-changes.json byte-identical, per-stock counters (e.g. the pending passes) intact,
// progress saved to stocks-state.json, and a request/throttle report in the output.
//   node script/test-refresh-fault.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "refresh-fault-"));
for (const f of ["stocks.json", "stocks-state.json", "stocks-changes.json"]) copyFileSync(join(root, f), join(dir, f));
const before = Object.fromEntries(["stocks.json", "stocks-state.json", "stocks-changes.json"].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const stateBefore = JSON.parse(before["stocks-state.json"]);

// 429 after N RPC requests (past the asset/feed stage, inside the pool-state or position stage)
const after = process.env.MOCK_429_AFTER ?? "30";
const r = spawnSync(process.execPath, ["--import", pathToFileURL(join(root, "script", "test-support", "mock-429.mjs")).href, join(root, "script", "refresh-stocks.mjs"), "--dir", dir],
  { encoding: "utf8", env: { ...process.env, MOCK_429_AFTER: after, RH_BACKOFF_SCALE: "0.002" } });
const out = (r.stdout + r.stderr).trim();
console.log(out.split("\n").slice(-8).join("\n"));

assert.equal(r.status, 0, "exit code 0 (never fails the workflow)");
assert.match(out, /KEEPING THE OLD LIST|old list kept/, "says the old list was kept");
assert.match(out, /429/, "mentions the 429");
assert.match(out, /requests \(\d+ calls\), [1-9]\d* throttled/, "reports request counts and throttles");
assert.equal(readFileSync(join(dir, "stocks.json"), "utf8"), before["stocks.json"], "stocks.json untouched");
assert.equal(readFileSync(join(dir, "stocks-changes.json"), "utf8"), before["stocks-changes.json"], "change log untouched");
const stateAfter = JSON.parse(readFileSync(join(dir, "stocks-state.json"), "utf8"));
assert.deepEqual(stateAfter.stocks, stateBefore.stocks, "per-stock counters (pending passes) intact");
for (const s of ["CRWV", "NBIS", "GME"]) if (stateBefore.stocks[s]) assert.equal(stateAfter.stocks[s].passes, stateBefore.stocks[s].passes, s + " passes kept");
assert.match(out, /progress saved/, "says progress was saved");
assert.ok(stateAfter.init_scanned_block >= stateBefore.init_scanned_block, "pool-index progress kept");
assert.ok(Object.keys(stateAfter.pools).length >= Object.keys(stateBefore.pools).length, "no pool lost");
console.log("\nfault test passed: 429 mid-run kept the list, kept the counters, saved progress, exit 0");
