// Appends one compact row per snapshot to history.json (a JSON array, one row per line). Plain Node, read-only data.
//
//   node script/append-history.mjs [gap-snapshot.json] [history.json]      (defaults: repo root)
//
// Row:  { t: snapshot_at in unix seconds, b: block, s: { SYMBOL: [gap_bps (1 dp), chainlink_usd, pool_usd, feed_age_minutes] } }
// Rules: fewer than 15 stocks -> nothing appended; same block or same snapshot_at as the last row (or older than it) ->
//        skipped; rows older than 30 days are dropped; the file never exceeds about 2 MB (oldest rows go first).
// The same file is used by the GitHub workflow and by the local Task Scheduler job.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export const MIN_STOCKS = 15;
export const MAX_AGE_SECONDS = 30 * 24 * 3600;
export const MAX_BYTES = 2_000_000;

const round = (x, d) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(d)) : null);

/** Compact row from a gap-snapshot.json object, or null if it has fewer than MIN_STOCKS stocks with a gap. */
export function rowFromSnapshot(snap) {
  const t = Math.floor(Date.parse(snap.snapshot_at) / 1000);
  if (!Number.isFinite(t) || !Number.isInteger(snap.block)) return null;
  const s = {};
  for (const st of snap.stocks ?? []) {
    if (typeof st.gap_bps !== "number" || !Number.isFinite(st.gap_bps)) continue;
    s[st.symbol] = [round(st.gap_bps, 1), round(st.chainlink_price_usd, 4), round(st.pool_price_usd, 4), round(st.feed_age_minutes, 1)];
  }
  if (Object.keys(s).length < MIN_STOCKS) return null;
  return { t, b: snap.block, s };
}

export function serialize(rows) {
  return "[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n";
}

/** Drops rows older than 30 days (relative to the newest row) and, if still too big, the oldest rows. */
export function prune(rows) {
  if (rows.length === 0) return rows;
  const newest = rows[rows.length - 1].t;
  let out = rows.filter((r) => r.t >= newest - MAX_AGE_SECONDS);
  let bytes = Buffer.byteLength(serialize(out));
  while (bytes > MAX_BYTES && out.length > 1) {
    bytes -= Buffer.byteLength(JSON.stringify(out[0])) + 2;
    out = out.slice(1);
  }
  return out;
}

export function loadHistory(file) {
  if (!existsSync(file)) return [];
  const rows = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${file} is not a JSON array; refusing to overwrite it`);
  return rows;
}

/** Merge rows (any order) into history: unique by t and by b, sorted by t, then pruned. */
export function mergeRows(existing, incoming) {
  const seenT = new Set(), seenB = new Set(), out = [];
  for (const r of [...existing, ...incoming].sort((a, b) => a.t - b.t)) {
    if (seenT.has(r.t) || seenB.has(r.b)) continue;
    seenT.add(r.t); seenB.add(r.b); out.push(r);
  }
  return prune(out);
}

export function appendSnapshot(snapFile, histFile) {
  const snap = JSON.parse(readFileSync(snapFile, "utf8"));
  const row = rowFromSnapshot(snap);
  if (!row) return { appended: false, reason: `fewer than ${MIN_STOCKS} stocks with a gap (or no valid snapshot_at/block)` };
  const rows = loadHistory(histFile);
  const last = rows[rows.length - 1];
  if (last && (last.b === row.b || last.t === row.t)) return { appended: false, reason: `duplicate of the last row (t=${last.t}, b=${last.b})`, rows: rows.length };
  if (last && row.t < last.t) return { appended: false, reason: `older than the last row (${row.t} < ${last.t})`, rows: rows.length };
  rows.push(row);
  const kept = prune(rows);
  const text = serialize(kept);
  writeFileSync(histFile, text);
  return { appended: true, row, rows: kept.length, dropped: rows.length - kept.length, bytes: Buffer.byteLength(text) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const snapFile = process.argv[2] ?? join(root, "gap-snapshot.json");
  const histFile = process.argv[3] ?? join(root, "history.json");
  try {
    const r = appendSnapshot(snapFile, histFile);
    if (r.appended) console.log(`history: appended t=${r.row.t} b=${r.row.b} (${Object.keys(r.row.s).length} stocks); ${r.rows} rows, ${r.bytes} bytes, ${r.dropped} dropped`);
    else console.log(`history: skipped, ${r.reason}`);
  } catch (e) {
    console.error("history: ERROR " + e.message);
    process.exit(1);
  }
}
