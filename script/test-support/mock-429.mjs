// Test helper (preloaded with node --import): after MOCK_429_AFTER POSTs to the RPC, every further RPC request gets a 429
// with a Retry-After header. Requests before that go to the real RPC. Other hosts are untouched. Never sends a token anywhere.
const real = globalThis.fetch;
const rpcHost = new URL(process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com").host;
const after = Number(process.env.MOCK_429_AFTER ?? 0);
let seen = 0;
globalThis.fetch = async (url, init) => {
  if (new URL(String(url)).host === rpcHost && init?.method === "POST") {
    seen++;
    if (seen > after) return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } });
  }
  return real(url, init);
};
