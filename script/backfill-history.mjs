// One-off: rebuilds history.json rows from the git history of gap-snapshot.json (every committed version).
//   node script/backfill-history.mjs            (run inside a clone of the repo; merges into history.json)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rowFromSnapshot, loadHistory, mergeRows, serialize } from "./append-history.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const commits = git("log", "--reverse", "--format=%H", "--", "gap-snapshot.json").trim().split(/\r?\n/).filter(Boolean);
const rows = [];
let skipped = 0;
for (const sha of commits) {
  try {
    const row = rowFromSnapshot(JSON.parse(git("show", `${sha}:gap-snapshot.json`)));
    if (row) rows.push(row); else skipped++;
  } catch {
    skipped++;
  }
}
const file = join(root, "history.json");
const merged = mergeRows(loadHistory(file), rows);
writeFileSync(file, serialize(merged));
console.log(`backfill: ${commits.length} commits touched gap-snapshot.json, ${rows.length} usable rows, ${skipped} skipped; history.json now has ${merged.length} rows`);
