// Fill chances measured from the hourly archive (poller/archive.mjs): how often a
// single unit posted 1 copper under the lowest price would have sold within 24
// hours (one auction). The addon's own guess (normal sales per hour against the queue)
// ignores being undercut; this replays what the house actually did instead.
//
// The replay, for one item and one start hour (an hour the item was listed):
//   - our unit is listed at min - 1, at the front of the queue: nothing is cheaper
//   - every later snapshot, the units listed below our price are "ahead" of us:
//     none if that hour's min is at or above our price (equal price: ours is older,
//     so it goes first), otherwise q5, q10 or q25: the smallest band above that
//     hour's min that reaches our price. More than 25% above the min (a stray cheap
//     listing): nobody reaches us that hour, and the next hour starts with q25 ahead.
//   - buyers take the cheapest units first. That holds for commodities (stackable
//     goods) only, so the feed ships numbers for commodities only.
//   - our unit sells in an hour when more units were bought than were ahead of us
//     at the start of the hour plus those still ahead at its end: undercutters
//     still there are taken to have arrived before the buyers.
//   - an hour without a sales comparison, or without the item, counts as nothing bought.
// The error runs both ways. Too high: undercutters don't react to our listing (a
// real 1c undercut of the lowest price would land on our price and count as behind
// us), and an undercut that is bought out within the hour is never seen. Too low:
// a band also holds units at or above our price, "sold" undercounts, and a real
// seller reposts when undercut.
//
// Only hours counted under sales rules 2+ are used (rules 1 overcounted cancelled
// auctions as bought). Start hours are those whose full 24 hours the archive covers.
// Snapshot times wander a few minutes around the hour, so a fill up to half an hour
// after the 24 hours still counts.
// An item gets numbers only with MIN_STARTS start hours; otherwise the addon keeps
// its formula.

const HOUR = 3600e3;
const WINDOW = 24, SLACK = 0.5; // hours
const MIN_RULES = 2;
// A week of start hours: starts an hour apart share most of their window, so
// they are far from independent; a week at least sees every day of the week once.
export const MIN_STARTS = 168;
const BANDS = [[1.05, "q5"], [1.1, "q10"], [1.25, "q25"]];

// Units listed below `price` at one archived hour (row: { min, q5, q10, q25, ... } or undefined).
function unitsBelow(row, price) {
  if (!row || row.min >= price) return 0;
  const band = BANDS.find(([f]) => price <= row.min * f);
  return band ? row[band[1]] ?? Infinity : Infinity;
}

// Hours from start hour i until our unit sells, or Infinity if not within the window.
// times: snapshot times; rows: the item's archived row per hour (undefined if absent).
export function fillTime(times, rows, i) {
  const price = rows[i].min - 1;
  let ahead = 0; // units below our price at the previous snapshot
  for (let j = i + 1; j < times.length && times[j] - times[i] <= (WINDOW + SLACK) * HOUR; j++) {
    const now = unitsBelow(rows[j], price);
    if ((rows[j]?.sold ?? 0) > ahead + now) return (times[j] - times[i]) / HOUR;
    ahead = Math.min(now, rows[j]?.q25 ?? Infinity); // a stray cheap listing costs one hour, not two
  }
  return Infinity;
}

// hours: readArchive() output. Returns { [itemId]: { p (0..1, sold within 24h), n: start hours } }
// for the items with enough start hours.
export function fillChances(hours) {
  hours = hours.filter((h) => h.rules >= MIN_RULES);
  const times = hours.map((h) => h.t);
  const last = times.at(-1);
  const ids = new Set();
  for (const h of hours) for (const id in h.d) ids.add(id);
  const out = {};
  for (const id of ids) {
    const rows = hours.map((h) => h.d[id]);
    let filled = 0, n = 0;
    for (let i = 0; i < rows.length && last - times[i] >= WINDOW * HOUR; i++) {
      if (!(rows[i]?.min > 0)) continue;
      n++;
      if (fillTime(times, rows, i) < Infinity) filled++;
    }
    if (n >= MIN_STARTS) out[id] = { p: filled / n, n };
  }
  return out;
}
