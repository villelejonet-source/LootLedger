// Hourly price archive: every hour's prices for the actively traded items of a
// few auction houses, kept ARCHIVE_DAYS days, so advice can be replayed and
// measured hour by hour later (a backtest). The rest of the history keeps only
// daily averages and the last 30 hours.
//
// One file per house per UTC day, in the history folder:
//   <house>.hours.<YYYY-MM-DD>.json.gz = { v: 1, fields: [...], hours: [{ t, r, d: { [itemId]: [...] } }] }
// (r = poller/sales.mjs SALES_RULES that counted "sold" that hour; hours without r used rules 1)
// with, per item and hour (copper per unit, units):
//   min, market, qty (units listed), n (listings), q5, q10, q25 (units listed at
//   most 5% / 10% / 25% above min: the queue a new listing joins), sold (units
//   bought since the last snapshot), gold (copper they were bought for), span
//   (hours since the last snapshot, 0 = no comparison this hour).

import { readdir, unlink, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { dayKey } from "./analysis.mjs";
import { readGzJson } from "./feed.mjs";
import { SALES_RULES } from "./sales.mjs";

export const ARCHIVE_DAYS = 35;
export const FIELDS = ["min", "market", "qty", "n", "q5", "q10", "q25", "sold", "gold", "span"];
// Which items: those that actually trade, 3+ units bought a day on average over
// the last 7 days (about 4,800 items on a big house, ~60 KB an hour gzipped,
// ~50 MB for 35 days). Most items have 10+ listed, so listings alone don't narrow it.
const MIN_SOLD_PER_DAY = 3;
const RECENT_SALE_DAYS = 7;

const fileName = (house, day) => `${house}.hours.${day}.json.gz`;

// Units listed at most 5/10/25% above the lowest price, from listing rows [[unitPrice, qty], ...].
export function depth(rows) {
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  const min = sorted[0]?.[0];
  const out = [0, 0, 0];
  if (min == null) return out;
  const caps = [min * 1.05, min * 1.1, min * 1.25];
  for (const [price, q] of sorted) {
    if (price > caps[2]) break;
    caps.forEach((cap, i) => { if (price <= cap) out[i] += q; });
  }
  return out;
}

// Items worth keeping this hour: bought 3+ a day on average over the last 7 days
// (days with sales data only). Before any sales data exists, everything bought this hour.
function wanted(items, sold, history, t) {
  const units = {};
  const oldest = dayKey(t - RECENT_SALE_DAYS * 86400e3);
  let days = 0;
  for (const [day, ids] of Object.entries(history?.sales ?? {})) {
    if (day < oldest) continue;
    days += Math.min(1, (history.salesHours?.[day] ?? 24) / 24);
    for (const [id, e] of Object.entries(ids)) units[id] = (units[id] ?? 0) + e[0];
  }
  const active = new Set();
  for (const [id, n] of Object.entries(units)) if (days > 0 && n / Math.max(1, days) >= MIN_SOLD_PER_DAY) active.add(id);
  if (sold) for (const [id, e] of sold) if (e.units > 0 && !days) active.add(String(id));
  return (id) => active.has(String(id));
}

// Add one hour to the house's archive file for that day (in `dir`, the history
// folder being written). items: { id: { min, market, qty, n, depth } },
// sold: Map(id -> { units, gold }) or null, span: hours since the last snapshot.
export async function archiveHour(dir, house, t, items, sold, span, history) {
  const file = join(dir, fileName(house, dayKey(t)));
  const day = (await readGzJson(file)) ?? { v: 1, fields: FIELDS, hours: [] };
  if (day.hours.some((h) => h.t === t)) return { added: 0, file };
  const keep = wanted(items, sold, history, t);
  const d = {};
  for (const [id, s] of Object.entries(items)) {
    if (!keep(id)) continue;
    const b = sold?.get(Number(id)) ?? sold?.get(id);
    const [q5, q10, q25] = s.depth ?? [null, null, null];
    d[id] = [s.min, s.market, s.qty, s.n ?? null, q5, q10, q25, b ? b.units : 0, b ? Math.round(b.gold) : 0, sold ? Math.round(span * 100) / 100 : 0];
  }
  day.hours.push({ t, d, r: SALES_RULES }); // r: the sales rules (poller/sales.mjs) that counted "sold"
  day.hours.sort((a, b) => a.t - b.t);
  await writeFile(file, gzipSync(JSON.stringify(day)));
  return { added: Object.keys(d).length, file };
}

// Delete the house's archive files older than ARCHIVE_DAYS.
export async function pruneArchive(dir, house, now, days = ARCHIVE_DAYS) {
  const oldest = dayKey(now - (days - 1) * 86400e3);
  const prefix = `${house}.hours.`;
  let removed = 0;
  for (const f of await readdir(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith(".json.gz")) continue;
    const day = f.slice(prefix.length, prefix.length + 10);
    if (day < oldest) { await unlink(join(dir, f)); removed++; }
  }
  return removed;
}

// Read back a house's archive (oldest first): [{ t, d: { id: { min, market, ... } } }]
export async function readArchive(dir, house) {
  const files = (await readdir(dir)).filter((f) => f.startsWith(`${house}.hours.`)).sort();
  const out = [];
  for (const f of files) {
    const day = await readGzJson(join(dir, f));
    for (const h of day.hours) {
      const d = {};
      for (const [id, row] of Object.entries(h.d)) d[id] = Object.fromEntries(day.fields.map((k, i) => [k, row[i]]));
      out.push({ t: h.t, rules: h.r ?? 1, d });
    }
  }
  return out;
}
