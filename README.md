# vayle-data

An hourly, read-only snapshot of how far Uniswap v4 stock-token pool prices on **Robinhood Chain (chain 4663)** are from
the **Chainlink** price of the same stock.

- `gap-snapshot.json`: the latest snapshot (refreshed hourly by GitHub Actions)
- `stocks.json`: which stocks, their Chainlink feed, and the pool(s) the snapshot reads
- `script/gap-snapshot.mjs`, `script/lib/chain.mjs`: the plain Node script (no dependencies, Node 18+)

Raw file: <https://raw.githubusercontent.com/Abrahamctb/vayle-data/main/gap-snapshot.json>

## What is in a snapshot

For each stock: Chainlink price, when the feed last updated and its age in minutes, the pool price, the gap in basis points,
and the pool's in-range liquidity, all read at a single block, plus `snapshot_at` (that block's time). Main pool per stock
first; other qualifying pools are listed under `other_pools`.

## How the gap is calculated

```
pool ratio   = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)     token0 priced in token1
stock price  = ratio, or 1/ratio if the stock is currency1             in the quote token
pool USD     = stock price * quote token's Chainlink USD price          (USDG, ETH, or another stock)
gap (bps)    = (pool USD - Chainlink USD) / Chainlink USD * 10,000      positive = pool above Chainlink
```

The pool price comes from the Uniswap v4 PoolManager's `slot0`; the Chainlink price from the feed's `latestRoundData()`.
Stock tokens have a `uiMultiplier`; it is read and reported but not applied, because the Chainlink feed and the pool both
price one token.

## Read-only

The script only makes `eth_call`, `eth_blockNumber` and `eth_getBlockByNumber` requests to the public RPC
`https://rpc.mainnet.chain.robinhood.com`. It cannot send a transaction, holds no key and uses no secrets. The workflow
runs with the repository's built-in token and only commits `gap-snapshot.json`.

## Limits

- Pool list, TVL and swap counts in `stocks.json` come from a one-off discovery on 2026-10-08; new pools are not picked up
  automatically.
- A large gap can be a stale or slow feed (Chainlink updates on a price-deviation threshold or a heartbeat, so a feed can be
  hours old), a thin pool, or a real mispricing. The snapshot does not say which.
- Public RPC rate limits can make a run fail; the workflow then commits nothing.

**This is chain data, not financial advice.** No warranty; do not trade on it without your own checks.
