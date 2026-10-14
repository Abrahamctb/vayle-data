// Tests for the RPC helpers: Retry-After, exponential back-off, slower pacing after a 429, bulk extsload. No network.
//   node script/test-chain.mjs
process.env.RH_BACKOFF_SCALE = "0.01"; // waits are 1% of real so the test is quick; the logic is what is tested
import assert from "node:assert/strict";
const chain = await import("./lib/chain.mjs");
const { rpc, extsloadMany, stats, selector } = chain;
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("ok  " + name); };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

await test("honours Retry-After, counts throttles, slows the pace, then succeeds", async () => {
  const calls = [];
  globalThis.fetch = async () => {
    calls.push(Date.now());
    return calls.length <= 2 ? new Response("slow down", { status: 429, headers: { "retry-after": "5" } }) : json({ jsonrpc: "2.0", id: 1, result: "0x10" });
  };
  const before = { ...stats };
  const r = await rpc("eth_blockNumber");
  assert.equal(r, "0x10");
  assert.equal(calls.length, 3);
  assert.equal(stats.throttled - before.throttled, 2);
  assert.ok(stats.waitedMs - before.waitedMs >= 2 * 5000 * 0.01 * 0.99, "waited about Retry-After (scaled) twice");
  assert.ok(stats.paceMs > 100, "pace slowed after the 429s");
});

await test("without Retry-After the wait grows exponentially, and it gives up after 8 attempts", async () => {
  let k = 0;
  globalThis.fetch = async () => { k++; return new Response("no", { status: 429 }); };
  const before = stats.waitedMs;
  await assert.rejects(() => rpc("eth_blockNumber"), /HTTP 429/);
  assert.equal(k, 8);
  const waited = stats.waitedMs - before;
  // 2+4+8+16+32+64+128+180 s (capped at 3 minutes) = 434 s, scaled by 0.01
  assert.ok(waited >= 400 * 0.01 * 1000 && waited <= 460 * 0.01 * 1000 + 100, `waited ${waited} ms`);
});

await test("a 403 (bot challenge) is treated like a throttle, never retried by rotating anything", async () => {
  let k = 0;
  globalThis.fetch = async () => { k++; return k < 3 ? new Response("blocked", { status: 403 }) : json({ jsonrpc: "2.0", id: 1, result: "0x1" }); };
  assert.equal(await rpc("eth_chainId"), "0x1");
  assert.equal(k, 3);
});

await test("refuses any method that is not read-only", async () => {
  globalThis.fetch = async () => { throw new Error("must not be called"); };
  await assert.rejects(() => rpc("eth_sendRawTransaction", ["0x00"]), /refusing non-read-only/);
});

await test("extsloadMany sends extsload(bytes32[]) in chunks and decodes the words", async () => {
  const slots = Array.from({ length: 5 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    const data = req.params[0].data;
    sent.push(data);
    const len = parseInt(data.slice(10 + 64, 10 + 128), 16);
    const items = [];
    for (let i = 0; i < len; i++) items.push(data.slice(10 + 128 + 64 * i, 10 + 128 + 64 * (i + 1)));
    // echo each slot back, plus one: the response is offset, length, items
    const out = "0x" + "20".padStart(64, "0") + len.toString(16).padStart(64, "0") + items.map((w) => (BigInt("0x" + w) + 1n).toString(16).padStart(64, "0")).join("");
    return json({ jsonrpc: "2.0", id: req.id, result: out });
  };
  const got = await extsloadMany(slots, "0x1", 2, 0); // 2 slots per call -> 3 calls
  assert.equal(sent.length, 3);
  assert.ok(sent.every((d) => d.startsWith(selector("extsload(bytes32[])"))));
  assert.deepEqual(got.map((w) => BigInt(w)), [2n, 3n, 4n, 5n, 6n]);
});

console.log(`\n${n} tests passed`);
process.exit(0);
