// Telegram gap alerts for vayle-data. Plain Node (>= 18), no dependencies, read-only chain data.
//
//   node script/alert.mjs                 normal run: alert on gaps >= 100 bps (dry-run if the secrets are not set)
//   node script/alert.mjs --test          send one message, "Vayle alerts are on" (dry-run if the secrets are not set)
//   node script/alert.mjs --dry-run       never send, even if the secrets are set (nothing is recorded)
//   options (for testing): --snapshot=<file> --state=<file> --now=<ISO time>
//
// Secrets, read ONLY from environment variables and never printed, logged or written to a file:
//   TELEGRAM_BOT_TOKEN   TELEGRAM_CHAT_ID
// If either is missing the script runs in dry-run mode: it prints the messages it would send and sends nothing.
//
// Rules: skip everything if the snapshot is older than 2 hours; a stock qualifies when |gap| >= 100 bps AND |gap| is at least
// the pool's fee (in bps) + 20 (so a gap the fee already eats is not worth a message); pools with the dynamic-fee flag
// qualify at |gap| >= 100 and say "dynamic fee"; the same symbol is not alerted again within 6 hours unless the gap sign
// flipped or |gap| grew by 50+ bps since the last alert; at most 5 alerts per run, largest |gap| first; a message that fails
// to send is NOT recorded in alert-state.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export const GAP_THRESHOLD_BPS = 100;
export const MAX_SNAPSHOT_AGE_MS = 2 * 3600 * 1000;
export const COOLDOWN_MS = 6 * 3600 * 1000;
export const GROWTH_BPS = 50;
export const FEE_MARGIN_BPS = 20;   // the gap must clear the fee by at least this much
export const DYNAMIC_FEE_FLAG = 8388608; // 0x800000: the pool takes its fee from its hook
const LINK = "https://usevayle.com/#";
export const MAX_PER_RUN = 5;
export const CLOSED_BPS = 50;                 // an alerted gap counts as closed once |gap| is at or below this
export const CLOSE_WINDOW_MS = 24 * 3600 * 1000; // only follow up alerts sent in the last 24 h

// ---- formatting ------------------------------------------------------------------------------------------------------
const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n) => (n > 0 ? "+" : "") + Math.round(n);
const hhmm = (iso) => new Date(iso).toISOString().slice(11, 16);

/** Pool fee of a stock's main pool: { dynamic, bps } (bps = null when unknown). fee_setting is in pips: 10,000 = 1% = 100 bps. */
export function feeInfo(stock) {
  const n = Number(stock.main_pool?.fee_setting);
  if (!Number.isFinite(n)) return { dynamic: false, bps: null };
  if (n === DYNAMIC_FEE_FLAG) return { dynamic: true, bps: null };
  return { dynamic: false, bps: n / 100 };
}
const num = (x) => String(Math.round(x * 100) / 100);
function ageText(minutes) {
  const h = minutes / 60;
  return (h >= 10 ? String(Math.round(h)) : String(Math.round(h * 10) / 10)) + " h";
}

/** Plain-text message for one stock. No advice, no buy/sell language. */
export function buildMessage(stock, snapshotAt) {
  const gap = stock.gap_bps;
  const side = gap < 0 ? "pool below" : "pool above";
  const fee = feeInfo(stock);
  let text = `${stock.symbol}: pool ${usd(stock.pool_price_usd)} vs Chainlink ${usd(stock.chainlink_price_usd)}, gap ${signed(gap)} bps (${side}).`;
  if (fee.dynamic) {
    text += " Pool uses a dynamic fee (set by its hook), so the gap after fee is not fixed.";
  } else if (fee.bps === null) {
    text += " Pool fee unknown.";
  } else {
    const after = Math.max(0, Math.abs(gap) - fee.bps);
    text += ` Pool fee ${num(fee.bps / 100)}% (${num(fee.bps)} bps), gap after fee ${Math.round(after)} bps (before gas).`;
  }
  if (typeof stock.feed_age_minutes === "number" && stock.feed_age_minutes > 60) {
    text += ` Chainlink feed last updated ${ageText(stock.feed_age_minutes)} ago.`;
  }
  text += ` Snapshot ${hhmm(snapshotAt)} UTC. ${LINK}${encodeURIComponent(stock.symbol)}`;
  return text;
}

/** Plain-text "gap closed" follow-up for a stock that was alerted earlier. No advice, no claim about what anyone could have done. */
export function buildClosedMessage(stock, last, snapshotAt) {
  const now = signed(stock.gap_bps);
  return `${stock.symbol}: gap closed. Now ${now} bps (was ${signed(last.gap_bps)} bps when alerted at ${hhmm(last.alerted_at)} UTC). ` +
    `Pool ${usd(stock.pool_price_usd)} vs Chainlink ${usd(stock.chainlink_price_usd)}. Snapshot ${hhmm(snapshotAt)} UTC. ${LINK}${encodeURIComponent(stock.symbol)}`;
}

/** The size rule: |gap| >= 100 bps, and (unless the fee is dynamic or unknown) |gap| >= fee in bps + 20. */
export function qualifies(stock) {
  if (typeof stock.gap_bps !== "number" || !Number.isFinite(stock.gap_bps)) return false;
  if (typeof stock.pool_price_usd !== "number" || typeof stock.chainlink_price_usd !== "number") return false;
  const g = Math.abs(stock.gap_bps);
  if (g < GAP_THRESHOLD_BPS) return false;
  const fee = feeInfo(stock);
  if (fee.dynamic || fee.bps === null) return true;
  return g >= fee.bps + FEE_MARGIN_BPS;
}

// ---- selection -------------------------------------------------------------------------------------------------------
/** Decides which stocks to alert on. Pure function: (snapshot, state, now) -> sorted list, already capped at MAX_PER_RUN. */
export function selectAlerts(snap, state, nowMs) {
  const out = [];
  for (const s of snap.stocks ?? []) {
    if (!qualifies(s)) continue;
    const last = state[s.symbol];
    if (last && typeof last.gap_bps === "number" && last.alerted_at) {
      const since = nowMs - Date.parse(last.alerted_at);
      const flipped = Math.sign(s.gap_bps) !== Math.sign(last.gap_bps);
      const grew = Math.abs(s.gap_bps) - Math.abs(last.gap_bps) >= GROWTH_BPS;
      if (since < COOLDOWN_MS && !flipped && !grew) continue;
    }
    out.push(s);
  }
  out.sort((a, b) => Math.abs(b.gap_bps) - Math.abs(a.gap_bps));
  return out.slice(0, MAX_PER_RUN);
}

/** Which earlier alerts have closed. Pure function: (snapshot, state, now) -> [{ stock, last }], capped at MAX_PER_RUN.
 *  An alert closes when |gap| <= CLOSED_BPS, it was sent within CLOSE_WINDOW_MS, and it has not been closed already. */
export function selectClosed(snap, state, nowMs) {
  const out = [];
  for (const s of snap.stocks ?? []) {
    const last = state[s.symbol];
    if (!last || !last.alerted_at || last.closed_at) continue;
    if (typeof s.gap_bps !== "number" || !Number.isFinite(s.gap_bps)) continue;
    if (typeof s.pool_price_usd !== "number" || typeof s.chainlink_price_usd !== "number") continue;
    if (nowMs - Date.parse(last.alerted_at) > CLOSE_WINDOW_MS) continue;
    if (Math.abs(s.gap_bps) > CLOSED_BPS) continue;
    out.push({ stock: s, last });
  }
  out.sort((a, b) => Date.parse(a.last.alerted_at) - Date.parse(b.last.alerted_at));
  return out.slice(0, MAX_PER_RUN);
}

// ---- Telegram --------------------------------------------------------------------------------------------------------
const redact = (str, token) => (token ? String(str).split(token).join("***") : String(str));

/** Sends one message. Returns { ok, error }. The token never appears in the returned error text. */
async function sendTelegram(token, chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.ok && body?.ok) return { ok: true };
    return { ok: false, error: redact(`HTTP ${res.status}${body?.description ? ": " + body.description : ""}`, token) };
  } catch (e) {
    // fetch errors can carry the request URL; show only the error class and a redacted message
    return { ok: false, error: redact(`${e?.name ?? "Error"}: ${e?.cause?.code ?? e?.message ?? "request failed"}`, token) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- main ------------------------------------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const opt = (n) => args.find((a) => a.startsWith(n + "="))?.slice(n.length + 1);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const snapFile = opt("--snapshot") ?? join(root, "gap-snapshot.json");
  const stateFile = opt("--state") ?? join(root, "alert-state.json");
  const nowMs = opt("--now") ? Date.parse(opt("--now")) : Date.now();

  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  const dryRun = flag("--dry-run") || !token || !chatId;
  const mode = dryRun ? "DRY RUN (nothing is sent" + (!token || !chatId ? ": TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)" : ": --dry-run)") : "LIVE";
  console.log(`alerts: ${mode}`);

  // state file: create it if missing (so the workflow can always commit it)
  if (!existsSync(stateFile)) writeFileSync(stateFile, "{}\n");

  if (flag("--test")) {
    const text = "Vayle alerts are on";
    if (dryRun) { console.log(`alerts: would send: ${text}`); return; }
    const r = await sendTelegram(token, chatId, text);
    if (r.ok) console.log("alerts: test message sent");
    else { console.error(`alerts: test message FAILED: ${r.error}`); process.exit(1); }
    return;
  }

  const snap = JSON.parse(readFileSync(snapFile, "utf8"));
  const ageMs = nowMs - Date.parse(snap.snapshot_at);
  if (!Number.isFinite(ageMs) || ageMs > MAX_SNAPSHOT_AGE_MS) {
    console.log(`alerts: snapshot_at ${snap.snapshot_at} is ${Math.round(ageMs / 60000)} min old (limit ${MAX_SNAPSHOT_AGE_MS / 60000}); skipping everything`);
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("not an object");
  } catch (e) {
    console.error(`alerts: ${stateFile} is not valid (${e.message}); refusing to overwrite it`);
    process.exit(1);
  }

  const qualifying = (snap.stocks ?? []).filter(qualifies).length;
  const picked = selectAlerts(snap, state, nowMs);
  console.log(`alerts: snapshot ${snap.snapshot_at}; ${qualifying} stock(s) with |gap| >= ${GAP_THRESHOLD_BPS} bps and above fee + ${FEE_MARGIN_BPS} bps; ${picked.length} to alert (cooldown ${COOLDOWN_MS / 3600000} h, max ${MAX_PER_RUN} per run)`);

  let sent = 0, failed = 0;
  for (const s of picked) {
    const text = buildMessage(s, snap.snapshot_at);
    if (dryRun) { console.log(`  would send: ${text}`); continue; }
    const r = await sendTelegram(token, chatId, text);
    if (r.ok) {
      sent++;
      state[s.symbol] = { gap_bps: Math.round(s.gap_bps * 10) / 10, alerted_at: new Date(nowMs).toISOString(), snapshot_at: snap.snapshot_at };
      console.log(`  sent: ${s.symbol} (${signed(s.gap_bps)} bps)`);
    } else {
      failed++;
      console.error(`  FAILED ${s.symbol}: ${r.error} (not recorded, will be retried next run)`);
    }
    await sleep(1100); // Telegram allows about one message per second per chat
  }
  // follow-ups: earlier alerts whose gap has closed (a failed send is not recorded and is retried next run)
  const closed = selectClosed(snap, state, nowMs);
  console.log(`alerts: ${closed.length} earlier alert(s) closed (|gap| <= ${CLOSED_BPS} bps, alerted within ${CLOSE_WINDOW_MS / 3600000} h)`);
  let closedSent = 0;
  for (const { stock: s, last } of closed) {
    const text = buildClosedMessage(s, last, snap.snapshot_at);
    if (dryRun) { console.log(`  would send: ${text}`); continue; }
    const r = await sendTelegram(token, chatId, text);
    if (r.ok) {
      closedSent++;
      state[s.symbol] = { ...last, closed_at: new Date(nowMs).toISOString(), closed_gap_bps: Math.round(s.gap_bps * 10) / 10 };
      console.log(`  sent closed: ${s.symbol} (${signed(s.gap_bps)} bps)`);
    } else {
      failed++;
      console.error(`  FAILED closed ${s.symbol}: ${r.error} (not recorded, will be retried next run)`);
    }
    await sleep(1100);
  }
  if (!dryRun) {
    if (sent + closedSent > 0) writeFileSync(stateFile, JSON.stringify(state, null, 1) + "\n");
    console.log(`alerts: ${sent} sent, ${closedSent} closed, ${failed} failed${sent + closedSent > 0 ? "; alert-state.json updated" : ""}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("alerts: ERROR " + redact(e?.message ?? e, process.env.TELEGRAM_BOT_TOKEN));
    process.exit(1);
  });
}
