// How far the fill chances (poller/fill.mjs) are: run by hand on a copy of the history branch.
//   node poller/fillreport.mjs <historyDir> <house>
import { readArchive } from "./archive.mjs";
import { fillChances, MIN_RULES, MIN_STARTS, WINDOWS } from "./fill.mjs";

const [dir, house] = process.argv.slice(2);
if (!dir || !house) throw new Error("usage: node poller/fillreport.mjs <historyDir> <house>");
const hours = await readArchive(dir, house);
const used = hours.filter((h) => h.rules >= MIN_RULES);
const fill = Object.entries(fillChances(hours));
const items = new Set(used.flatMap((h) => Object.keys(h.d))).size;
console.log(`house ${house}: ${hours.length} archived hours, ${used.length} under sales rules ${MIN_RULES}+` +
  (used.length ? ` (${new Date(used[0].t).toISOString().slice(0, 16)}Z to ${new Date(used.at(-1).t).toISOString().slice(0, 16)}Z)` : ""));
console.log(`fill chances for ${fill.length} of ${items} items (each needs ${MIN_STARTS} start hours with a full ${WINDOWS.at(-1)}h window` +
  (fill.length ? ")" : `: about ${Math.max(0, MIN_STARTS + WINDOWS.at(-1) - used.length)} more hours for the steadiest items)`));
const pct = (p) => `${Math.round(p * 100)}%`.padStart(4);
// About ten items across the range, surest first.
for (const [id, f] of fill.sort((a, b) => b[1].p[1] - a[1].p[1]).filter((_, i, all) => i % Math.max(1, Math.floor(all.length / 10)) === 0)) {
  console.log(`  item ${id.padEnd(6)} ${WINDOWS.map((w, k) => `${w}h ${pct(f.p[k])}`).join("  ")}  (${f.n} starts)`);
}
