// What was bought on an auction house between two hourly snapshots.
//
// A snapshot is { t (Blizzard's Last-Modified, ms), l: [[auctionId, itemId, qty, unitPrice, timeLeft, commodity], ...] }
// with timeLeft 0 = SHORT, 1 = MEDIUM, 2 = LONG, 3 = VERY_LONG, and commodity 1 for stackable goods.
//
// Rules, per item. When unsure, we count it as *not* bought: trending looks at
// changes against normal, so a cautious count is fine; an inflated one isn't.
//   - a stack that got smaller            -> the difference was bought
//   - a listing that's gone               -> bought, unless...
//       ...it had under 2 hours left (SHORT or MEDIUM)                         -> expired
//       ...it had 2-12 hours left (LONG) and the snapshots are over 2 hours apart -> expired
//       ...a stack of the same size was newly listed for the same item          -> cancelled and relisted
//       ...it's a commodity and a cheaper listing of it is still there (even partly bought),
//          or an older one at the same price, or (all old ones gone) a cheaper new one -> cancelled
//          (commodity buyers always get the cheapest units first, oldest first at one
//           price, so nobody skipped a cheaper or older stack to buy this one)
//   - more than 12 hours between snapshots -> too much changed to tell; nothing is counted

export const TIME_LEFT = { SHORT: 0, MEDIUM: 1, LONG: 2, VERY_LONG: 3 };

// Bumped when the rules above change how much counts as bought. Sales counted
// under older rules are dropped (resetSales), so the trending baselines and
// "normal per day" are never a mix of old and new counts.
export const SALES_RULES = 2;

// Drop sales counted under older rules; they rebuild from the next hours.
export function resetSales(history) {
  if ((history.salesRules ?? 1) >= SALES_RULES) return false;
  history.sales = {};
  history.salesHours = {};
  for (const h of history.hours ?? []) { h.s = {}; h.diff = false; delete h.h; }
  history.salesRules = SALES_RULES;
  return true;
}
const HOUR = 3600e3;

export function toSnapshot(t, listings) {
  return { t, l: listings };
}

// Returns Map<itemId, { units, auctions, gold, expired, relisted, posted }>
export function diffSnapshots(prev, cur) {
  const out = new Map();
  if (!prev || !cur || !(cur.t > prev.t)) return out;
  const gap = cur.t - prev.t;
  if (gap > 12 * HOUR) return out;

  const entry = (item) => {
    let e = out.get(item);
    if (!e) out.set(item, (e = { units: 0, auctions: 0, gold: 0, expired: 0, relisted: 0, cancelled: 0, posted: 0 }));
    return e;
  };
  const curById = new Map();
  const commodities = new Set();
  for (const a of cur.l) { curById.set(a[0], a); if (a[5]) commodities.add(a[1]); }
  for (const a of prev.l) if (a[5]) commodities.add(a[1]);
  const prevIds = new Set();

  // Cheapest listing per item that's still there, whole or partly bought. Commodity
  // buyers always get the cheapest units first, so while units at this price were
  // left, nobody bought anything pricier: a pricier listing that's gone was cancelled.
  // (Using only untouched listings put the line far too high on busy houses, where
  // nearly every cheap listing gets partly bought within the hour.)
  // Also the oldest listing (lowest auction ID) still there at that cheapest price:
  // at one price, the oldest units go first, so a gone listing newer than one that's
  // still there at the same price was cancelled, not bought.
  const cheapestLeft = new Map(), oldestLeftAtCheapest = new Map();
  for (const [id, item, , price] of prev.l) {
    const now = curById.get(id);
    if (!(now && now[2] > 0)) continue;
    const c = cheapestLeft.get(item) ?? Infinity;
    if (price < c) { cheapestLeft.set(item, price); oldestLeftAtCheapest.set(item, id); }
    else if (price === c && id < oldestLeftAtCheapest.get(item)) oldestLeftAtCheapest.set(item, id);
  }
  // Nothing old left at all (a whole item cleared in one hour): the cheapest new
  // listing caps it instead. Buyers would have taken those units before pricier ones.
  const allPrevIds = new Set(prev.l.map((a) => a[0]));
  const cheapestNew = new Map();
  for (const [id, item, , price] of cur.l) {
    if (allPrevIds.has(id) || !commodities.has(item) || cheapestLeft.has(item)) continue;
    if (price < (cheapestNew.get(item) ?? Infinity)) cheapestNew.set(item, price);
  }
  // Was this gone commodity listing cancelled rather than bought?
  const cancelledCommodity = (id, item, price) => {
    const left = cheapestLeft.get(item);
    if (left == null) return price > (cheapestNew.get(item) ?? Infinity) * 1.005;
    if (price > left * 1.005) return true;
    return price >= left && id > oldestLeftAtCheapest.get(item);
  };

  const gone = new Map(); // item -> [{ qty, price }]
  for (const [id, item, qty, price, tl] of prev.l) {
    prevIds.add(id);
    const now = curById.get(id);
    if (now) {
      if (now[2] < qty) {
        const e = entry(item);
        e.units += qty - now[2];
        e.auctions += 1;
        e.gold += (qty - now[2]) * price;
      }
      continue;
    }
    const mayHaveExpired = tl === TIME_LEFT.SHORT || tl === TIME_LEFT.MEDIUM || (tl === TIME_LEFT.LONG && gap > 2 * HOUR);
    if (mayHaveExpired) { entry(item).expired += qty; continue; }
    // Single listings: buyers pick from the list too, cheapest first, but copies of an
    // item ID can differ (random stats), so allow 10% before calling it a cancel.
    const pricier = !commodities.has(item) && price > (cheapestLeft.get(item) ?? Infinity) * 1.10;
    if (pricier || (commodities.has(item) && cancelledCommodity(id, item, price))) {
      entry(item).cancelled += qty;
      continue;
    }
    let g = gone.get(item);
    if (!g) gone.set(item, (g = []));
    g.push({ qty, price });
  }

  // New listings by item and stack size, to spot cancel + relist.
  const fresh = new Map(); // item -> Map<qty, count>
  for (const [id, item, qty] of cur.l) {
    if (prevIds.has(id)) continue;
    entry(item).posted += qty;
    let m = fresh.get(item);
    if (!m) fresh.set(item, (m = new Map()));
    m.set(qty, (m.get(qty) ?? 0) + 1);
  }

  for (const [item, list] of gone) {
    const e = entry(item);
    const sizes = fresh.get(item);
    for (const { qty, price } of list) {
      const n = sizes?.get(qty) ?? 0;
      if (n > 0) { sizes.set(qty, n - 1); e.relisted += qty; continue; }
      e.units += qty;
      e.auctions += 1;
      e.gold += qty * price;
    }
  }
  // Only keep items where something happened that matters for trending.
  for (const [item, e] of out) if (!e.units && !e.expired && !e.relisted && !e.cancelled) out.delete(item);
  return out;
}

// Record one hour into the history:
//   history.hours = [{ t, s: { id: [units, auctions, gold] }, q: { id: [qtyListed, market] }, diff, h }, ...]  (last 30)
//   history.sales = { "YYYY-MM-DD": { id: [units, auctions, gold] } }                                  (120 days)
//   history.salesHours = { "YYYY-MM-DD": hours covered by sales diffs }  (to know if a day is complete)
// span: hours between the two snapshots of the diff (stored as h). Records written
// before spans were kept have no h: read them as 1 hour.
export function recordHour(history, t, sold, items, { span = 1, keepHours = 30, keepDays = 120 } = {}) {
  history.hours ??= [];
  history.sales ??= {};
  history.salesHours ??= {};
  const s = {}, q = {};
  if (sold) for (const [id, e] of sold) if (e.units > 0) s[id] = [e.units, e.auctions, Math.round(e.gold)];
  for (const [id, it] of Object.entries(items)) q[id] = [it.qty, it.market];
  const h = Math.round(span * 100) / 100;
  history.hours.push(sold ? { t, s, q, diff: true, h } : { t, s, q, diff: false });
  history.hours = history.hours.slice(-keepHours);

  if (sold) {
    const day = new Date(t).toISOString().slice(0, 10);
    const d = (history.sales[day] ??= {});
    for (const [id, v] of Object.entries(s)) {
      const e = (d[id] ??= [0, 0, 0]);
      e[0] += v[0]; e[1] += v[1]; e[2] += v[2];
    }
    history.salesHours[day] = Math.round(((history.salesHours[day] ?? 0) + h) * 100) / 100;
  }
  const oldest = new Date(t - keepDays * 86400e3).toISOString().slice(0, 10);
  for (const k of Object.keys(history.sales)) if (k < oldest) { delete history.sales[k]; delete history.salesHours[k]; }
}
