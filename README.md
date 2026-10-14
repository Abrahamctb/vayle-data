# vayle-data

An hourly, read-only snapshot of how far Uniswap v4 stock-token pool prices on **Robinhood Chain (chain 4663)** are from
the **Chainlink** price of the same stock.

- `gap-snapshot.json`: the latest snapshot (refreshed hourly by GitHub Actions)
- `script/alert.mjs`, `alert-state.json`: Telegram gap alerts (see below)
- `history.json`: one compact row per snapshot, last 30 days (see below)
- `stocks.json`: which stocks, their Chainlink feed, and the pool(s) the snapshot reads
- `script/gap-snapshot.mjs`, `script/lib/chain.mjs`: the plain Node script (no dependencies, Node 18+)

Raw file: <https://raw.githubusercontent.com/Abrahamctb/vayle-data/main/gap-snapshot.json>

## What is in a snapshot

For each stock: Chainlink price, when the feed last updated and its age in minutes, the pool price, the gap in basis points,
and the pool's in-range liquidity, all read at a single block, plus `snapshot_at` (that block's time). Main pool per stock
first; other qualifying pools are listed under `other_pools`.

## History

`history.json` is a JSON array, oldest first, one row per snapshot:

```
{"t": <snapshot_at, unix seconds>, "b": <block>, "s": {"TSLA": [gap_bps, chainlink_usd, pool_usd, feed_age_minutes], ...}}
```

Rows older than 30 days are dropped and the file is kept under about 2 MB. A snapshot with fewer than 15 stocks, or one
with the same block or time as the last row, is not appended. Raw file:
<https://raw.githubusercontent.com/Abrahamctb/vayle-data/main/history.json>

## Telegram alerts

`script/alert.mjs` runs after each snapshot in the GitHub workflow and posts a plain-text message to a Telegram chat for
every stock whose pool price is **100 bps or more** away from Chainlink. It is data, not advice: no buy or sell language and
no predictions. Example:

```
INTC: pool $100.73 vs Chainlink $101.70, gap -96 bps (pool below). Pool fee 1%. Snapshot 14:12 UTC. usevayle.com
```

When the Chainlink feed is more than 60 minutes old the message says so ("Chainlink feed last updated 3 h ago"), because a stale
feed explains many gaps.

Rules: nothing is sent if the snapshot is older than 2 hours; the same symbol is not alerted again within 6 hours unless the
gap changed sign or its size grew by 50+ bps since the last alert; at most 5 alerts per run, largest gap first; a message that
fails to send is not recorded and is retried on the next run. State is kept in `alert-state.json` (last alerted gap and time
per symbol).

**Secrets** (repository settings, Secrets and variables, Actions): `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. The script reads
them only from environment variables and never prints or writes them. If either is missing it runs in **dry-run** mode: it
prints the messages it would send and sends nothing.

```
node script/alert.mjs            # dry run locally (no variables set)
node script/alert.mjs --test     # sends "Vayle alerts are on" when the variables are set, otherwise prints it
node script/alert.mjs --dry-run  # never sends, even when the variables are set
```

The local Task Scheduler fallback does not send alerts (it has no secrets); only the GitHub workflow does.

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
