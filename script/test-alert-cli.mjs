// End-to-end test of script/alert.mjs through its command line: dry run, live send (mocked), cooldown, stale snapshot, failures.
// Uses a FAKE token and a mocked fetch, so nothing leaves this machine.   node script/test-alert-cli.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "alert-cli-"));
const here = work;
const FAKE_TOKEN = "123456:FAKE-test-token-AAAA";
const FAKE_CHAT = "-1009999999";

// mocked fetch: behaviour is selected by env MOCK (ok | fail:<SYMBOL> | neterr)
writeFileSync(join(here, "mock.mjs"), `
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith("https://api.telegram.org/bot")) return real(url, init);
  const body = JSON.parse(init.body);
  globalThis.__sent = (globalThis.__sent ?? 0) + 1;
  const mode = process.env.MOCK || "ok";
  if (mode === "neterr") { const e = new TypeError("fetch failed for " + url); e.cause = { code: "ECONNRESET" }; throw e; }
  if (mode.startsWith("fail:") && body.text.startsWith(mode.slice(5) + ":")) {
    return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 });
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
};
`);

const baseSnap = JSON.parse(readFileSync(join(repo, "gap-snapshot.json"), "utf8"));
const NOW = "2026-10-14T10:00:00.000Z";
function snapshot(gaps, extra = {}) {
  // synthetic: real stock records with the gaps overridden
  const s = JSON.parse(JSON.stringify(baseSnap));
  s.snapshot_at = new Date(Date.parse(NOW) - 5 * 60000).toISOString();
  s.stocks = s.stocks.map((st) => {
    if (gaps[st.symbol] !== undefined) {
      st.gap_bps = gaps[st.symbol];
      st.pool_price_usd = st.chainlink_price_usd * (1 + gaps[st.symbol] / 1e4);
    }
    if (extra[st.symbol]) Object.assign(st, extra[st.symbol]);
    return st;
  });
  return s;
}
function run(label, snap, stateObj, { now = NOW, mock = "ok", env = {}, args = [] } = {}) {
  const sf = join(work, "snap.json"), st = join(work, "state.json");
  writeFileSync(sf, JSON.stringify(snap));
  if (stateObj !== undefined) writeFileSync(st, JSON.stringify(stateObj));
  const r = spawnSync(process.execPath, ["--import", "file:///" + join(here, "mock.mjs").replace(/\\/g, "/"), join(repo, "script", "alert.mjs"), `--snapshot=${sf}`, `--state=${st}`, `--now=${now}`, ...args],
    { encoding: "utf8", env: { ...process.env, MOCK: mock, ...env } });
  const out = (r.stdout + r.stderr).trim();
  console.log(`\n### ${label}\n${out}\n[exit ${r.status}]`);
  const state = existsSync(st) ? JSON.parse(readFileSync(st, "utf8")) : undefined;
  return { out, state, code: r.status };
}
const secrets = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: FAKE_CHAT };
const hours = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();
let failures = 0;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}: ${name}`); if (!cond) failures++; };

// 1. dry-run formatting with a stale feed (3 h) and a hooked pool
let r = run("1. dry run (no secrets): INTC, ORCL with a 3 h old feed, MU", snapshot({ INTC: -140, ORCL: -130, MU: 150 }, { ORCL: { feed_age_minutes: 180 } }), {});
check("dry run sends nothing and records nothing", /DRY RUN/.test(r.out) && JSON.stringify(r.state) === "{}");
check("feed-age note appears only when > 60 min", /ORCL: .*Chainlink feed last updated 3 h ago/.test(r.out) && !/INTC: .*feed last updated/.test(r.out));

// 2. live send (mock ok): max 5 per run, largest first, state recorded
const seven = { INTC: -300, ORCL: -250, MU: 200, SNDK: 190, AMD: -180, COIN: 150, PLTR: 120 };
r = run("2. live, 7 qualifying -> only 5, largest |gap| first", snapshot(seven), {}, { env: secrets });
const order = [...r.out.matchAll(/sent: (\w+)/g)].map((m) => m[1]);
check("5 sent, largest first", order.join(",") === "INTC,ORCL,MU,SNDK,AMD");
check("COIN and PLTR not recorded", r.state && !r.state.COIN && !r.state.PLTR && r.state.INTC && r.state.AMD);
check("no token or chat id in output or state", !r.out.includes(FAKE_TOKEN) && !r.out.includes(FAKE_CHAT) && !JSON.stringify(r.state).includes(FAKE_TOKEN));

// 3. cooldown, growth, flip, expiry (state from run 2 recorded at NOW)
const st0 = { INTC: { gap_bps: -300, alerted_at: hours(1) } };
r = run("3a. same gap 1 h later -> cooldown", snapshot({ INTC: -310 }), st0, { env: secrets });
check("cooldown suppresses", /0 to alert/.test(r.out));
r = run("3b. gap grew by 50+ bps", snapshot({ INTC: -355 }), st0, { env: secrets });
check("growth of 55 bps alerts again", /sent: INTC/.test(r.out));
r = run("3c. sign flipped", snapshot({ INTC: 120 }), st0, { env: secrets });
check("sign flip alerts again", /sent: INTC/.test(r.out));
r = run("3d. 7 h later, same gap", snapshot({ INTC: -300 }), { INTC: { gap_bps: -300, alerted_at: hours(7) } }, { env: secrets });
check("cooldown expired after 6 h", /sent: INTC/.test(r.out));
r = run("3e. gap shrank but still >= 100 within cooldown", snapshot({ INTC: -150 }), st0, { env: secrets });
check("shrinking gap is suppressed", /0 to alert/.test(r.out));
r = run("3f. below 100 bps", snapshot({ INTC: -99.9 }), {}, { env: secrets });
check("99.9 bps does not qualify", /0 stock\(s\) with/.test(r.out));

// 4. stale snapshot (> 2 h)
r = run("4. snapshot 3 h old", snapshot({ INTC: -300 }), {}, { env: secrets, now: new Date(Date.parse(NOW) + 3 * 3600000).toISOString() });
check("stale snapshot skips everything", /skipping everything/.test(r.out) && JSON.stringify(r.state) === "{}");

// 5. failures: one send fails -> not recorded; network error with the token inside the error text
r = run("5a. send fails for ORCL only", snapshot({ INTC: -300, ORCL: -250 }), {}, { env: secrets, mock: "fail:ORCL" });
check("failed send not recorded, the other one is", r.state.INTC && !r.state.ORCL && /FAILED ORCL/.test(r.out));
r = run("5b. network error (error text contains the URL with the token)", snapshot({ INTC: -300 }), {}, { env: secrets, mock: "neterr" });
check("network error: nothing recorded, token not leaked", JSON.stringify(r.state) === "{}" && !r.out.includes(FAKE_TOKEN) && /FAILED INTC/.test(r.out));
check("exit code 0 on send failure (data commit must go on)", r.code === 0);

// 6. --test and missing variables
r = run("6a. --test dry run (secrets missing)", snapshot({}), {}, { args: ["--test"] });
check("--test dry run prints the message", /would send: Vayle alerts are on/.test(r.out));
r = run("6b. --test live", snapshot({}), {}, { env: secrets, args: ["--test"] });
check("--test live sends", /test message sent/.test(r.out));
r = run("6c. only the token set -> dry run", snapshot({ INTC: -300 }), {}, { env: { TELEGRAM_BOT_TOKEN: FAKE_TOKEN } });
check("one variable missing -> dry run", /DRY RUN/.test(r.out) && !/^\s+sent:/m.test(r.out) && /would send: INTC/.test(r.out));

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures ? 1 : 0);
