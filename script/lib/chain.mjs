// Tiny read-only helpers shared by script/build-stocks.mjs and script/gap-snapshot.mjs. Plain Node (>= 18), no dependencies.
// Nothing here can send a transaction: the only RPC methods used are eth_call, eth_blockNumber and eth_getBlockByNumber.

export const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;
export const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
export const FEEDS_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const ZERO = "0x0000000000000000000000000000000000000000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ_ONLY = new Set(["eth_call", "eth_blockNumber", "eth_getBlockByNumber", "eth_chainId", "eth_getLogs"]);

/** How much RPC work a script did (for reporting). */
export const stats = { requests: 0, subcalls: 0, splits: 0 };

async function post(body) {
  let lastErr;
  stats.requests++;
  stats.subcalls += Array.isArray(body) ? body.length : 1;
  for (let i = 0; i < 7; i++) {
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status === 429 || res.status === 403 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1) ** 2);
    }
  }
  throw lastErr;
}

/** One JSON-RPC call. Throws on an RPC error. */
export async function rpc(method, params = []) {
  if (!READ_ONLY.has(method)) throw new Error(`refusing non-read-only method ${method}`);
  const j = await post({ jsonrpc: "2.0", id: 1, method, params });
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** Many calls in JSON-RPC batches. Returns [{ result } | { error }] in the same order. */
export async function batch(calls, size = 40, pauseMs = 150) {
  const out = new Array(calls.length);
  for (let i = 0; i < calls.length; i += size) {
    const chunk = calls.slice(i, i + size);
    for (const c of chunk) if (!READ_ONLY.has(c.method)) throw new Error(`refusing non-read-only method ${c.method}`);
    const body = chunk.map((c, k) => ({ jsonrpc: "2.0", id: k, method: c.method, params: c.params }));
    const res = await post(body);
    const arr = Array.isArray(res) ? res : [res];
    for (const r of arr) out[i + r.id] = r.error ? { error: r.error.message } : { result: r.result };
    await sleep(pauseMs);
  }
  return out;
}

export const ethCall = (to, data, block) => ({ method: "eth_call", params: [{ to, data }, block] });

// ---- ABI helpers (static types only, plus one string) ---------------------------------------------------------------
export const words = (hex) => {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt("0x" + h.slice(i, i + 64)));
  return out;
};
export const toSigned = (x, bits = 256n) => (x >= 1n << (bits - 1n) ? x - (1n << bits) : x);
export const pad32 = (hexNo0x) => hexNo0x.padStart(64, "0");

// ---- keccak256 (Ethereum's original padding, not NIST SHA-3), BigInt lanes. Self-tested in selfTestKeccak(). -----------
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;
const RC = [];
const ROT = Array.from({ length: 5 }, () => new Array(5).fill(0));
(() => {
  const rcBit = (t) => {
    if (t % 255 === 0) return 1;
    let R = 1;
    for (let i = 1; i <= t % 255; i++) {
      R <<= 1;
      if (R & 0x100) R ^= 0x171;
    }
    return R & 1;
  };
  for (let ir = 0; ir < 24; ir++) {
    let c = 0n;
    for (let j = 0; j <= 6; j++) if (rcBit(j + 7 * ir)) c |= 1n << BigInt((1 << j) - 1);
    RC.push(c);
  }
  let x = 1, y = 0;
  for (let t = 0; t < 24; t++) {
    ROT[x][y] = (((t + 1) * (t + 2)) / 2) % 64;
    [x, y] = [y, (2 * x + 3 * y) % 5];
  }
})();

function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const C = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) C[x] = s[x][0] ^ s[x][1] ^ s[x][2] ^ s[x][3] ^ s[x][4];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) s[x][y] ^= D;
    }
    const B = Array.from({ length: 5 }, () => new Array(5).fill(0n));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rotl(s[x][y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x][y] = B[x][y] ^ (~B[(x + 1) % 5][y] & MASK & B[(x + 2) % 5][y]);
    s[0][0] ^= RC[r];
  }
}

export function keccak256(bytes) {
  const rate = 136;
  const msg = Array.from(bytes);
  msg.push(0x01);
  while (msg.length % rate !== 0) msg.push(0);
  msg[msg.length - 1] |= 0x80;
  const s = Array.from({ length: 5 }, () => new Array(5).fill(0n));
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + b]);
      s[i % 5][Math.floor(i / 5)] ^= lane;
    }
    keccakF(s);
  }
  let out = "";
  for (let i = 0; i < 4; i++) {
    const lane = s[i % 5][Math.floor(i / 5)];
    for (let b = 0; b < 8; b++) out += Number((lane >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  }
  return "0x" + out;
}
export const keccakUtf8 = (str) => keccak256(new TextEncoder().encode(str));
export const keccakHex = (hex) => keccak256(Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex")));
export const selector = (sig) => keccakUtf8(sig).slice(0, 10);

export function selfTestKeccak() {
  const empty = keccak256(new Uint8Array());
  if (empty !== "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") throw new Error("keccak self-test failed (empty input)");
  if (selector("latestRoundData()") !== "0xfeaf968c") throw new Error("keccak self-test failed (latestRoundData selector)");
  // the Vayle pool's slot0 location in the PoolManager, computed independently with `cast keccak`
  const slot = poolSlot("0xa270cba3eca539c6e28e787688312e7d6c3a58fe7ba48a6c9ce84ee59758a18e");
  if (slot !== "0xe23a2d7543a25c2119bc681a8896ef7227cd378fcbe39db28b448891c9919568") throw new Error("keccak self-test failed (pool slot)");
}

/** PoolManager storage slot of `pools[poolId]` (Pool.State starts there; slot0 = +0, liquidity = +3). */
export const poolSlot = (poolId) => keccakHex(poolId.replace(/^0x/, "") + pad32("6"));
export const slotPlus = (slotHex, n) => "0x" + pad32((BigInt(slotHex) + BigInt(n)).toString(16));

export const EXTSLOAD = "0x1e2eaeaf"; // extsload(bytes32)
export const LATEST_ROUND_DATA = "0xfeaf968c";
export const DECIMALS = "0x313ce567";

// ---- logs ------------------------------------------------------------------------------------------------------------
export const TOPIC = {
  Initialize: keccakUtf8("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"),
  ModifyLiquidity: keccakUtf8("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
  Swap: keccakUtf8("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
};
export const addrTopic = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
export const topicAddr = (t) => "0x" + t.slice(26);
const hexn = (n) => "0x" + BigInt(n).toString(16);

/**
 * eth_getLogs over [from, to] in chunks of at most `span` blocks. If the RPC refuses a range (block-range or result-size
 * limit) the chunk is halved and retried, down to 2,000 blocks, then the error is surfaced. Only shrinks requests; it
 * never rotates endpoints or evades rate limits. `address` and `topics` are as in eth_getLogs.
 */
export async function getLogsChunked({ address, topics }, from, to, span = 5_000_000, pauseMs = 120) {
  const out = [];
  for (let a = BigInt(from); a <= BigInt(to); a += BigInt(span)) {
    const b = a + BigInt(span) - 1n < BigInt(to) ? a + BigInt(span) - 1n : BigInt(to);
    try {
      const logs = await rpc("eth_getLogs", [{ address, topics, fromBlock: hexn(a), toBlock: hexn(b) }]);
      for (const l of logs) out.push(l);
    } catch (e) {
      if (span <= 2000) throw new Error(`RPC refuses even a ${span}-block range: ${String(e.message).slice(0, 120)}`);
      stats.splits++;
      for (const l of await getLogsChunked({ address, topics }, a, b, Math.floor(span / 2), pauseMs)) out.push(l);
    }
    await sleep(pauseMs);
  }
  return out;
}

const s256 = (x) => (x >= 1n << 255n ? x - (1n << 256n) : x);
const s24 = (x) => { const v = Number(x & 0xffffffn); return v >= 1 << 23 ? v - (1 << 24) : v; };
export function decodeInitialize(l) {
  const w = words(l.data);
  return { id: l.topics[1], c0: topicAddr(l.topics[2]), c1: topicAddr(l.topics[3]), fee: Number(w[0]), tickSpacing: s24(w[1]), hooks: "0x" + w[2].toString(16).padStart(40, "0"), block: parseInt(l.blockNumber, 16) };
}
export function decodeModify(l) {
  const w = words(l.data);
  return { id: l.topics[1], sender: topicAddr(l.topics[2]), lo: s24(w[0]), hi: s24(w[1]), delta: s256(w[2]), salt: "0x" + w[3].toString(16).padStart(64, "0"), block: parseInt(l.blockNumber, 16) };
}
export function decodeSwap(l) {
  const w = words(l.data);
  return { id: l.topics[1], sender: topicAddr(l.topics[2]), a0: s256(w[0]), a1: s256(w[1]), block: parseInt(l.blockNumber, 16) };
}
