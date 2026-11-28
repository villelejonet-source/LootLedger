// File handling for the price feed (poller/ah.mjs), kept apart so it can be tested
// without credentials or network.

import { copyFile, readdir, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

// Copy every history file of the previous run into this run's output, so a house
// that is skipped this hour (fetch error, empty) keeps its history: the workflow
// replaces the whole history branch with the output folder.
// Returns the number of files copied. A missing source folder means no history yet.
export async function carryOverHistory(from, to) {
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  let n = 0;
  for (const e of entries) {
    if (!e.isFile()) continue; // e.g. the .git folder of the cloned branch
    await copyFile(join(from, e.name), join(to, e.name));
    n++;
  }
  return n;
}

// A gzipped JSON file, or null if it doesn't exist. Any other error (unreadable,
// corrupt) is thrown: treating it as "no history" would overwrite real history.
export async function readGzJson(file) {
  let buf;
  try {
    buf = await readFile(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  return JSON.parse(gunzipSync(buf).toString());
}

// fetch with a timeout on every attempt, retrying network errors, timeouts and bad
// statuses (except 404) with a growing pause. `read(res)` turns the response into
// the result inside the same attempt, so a body that fails to arrive is retried too.
export async function fetchRetry(url, init = {}, { read = (res) => res, tries = 3, timeoutMs = 60_000, delayMs = 2000, what = String(url) } = {}) {
  for (let attempt = 1; ; attempt++) {
    let error;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await read(res);
      error = new Error(`${res.status} from ${what}`);
      if (res.status === 404) throw error;
    } catch (e) {
      if (e === error) throw e; // 404
      error = e;
    }
    if (attempt >= tries) throw error;
    await new Promise((r) => setTimeout(r, delayMs * attempt));
  }
}

// Diff two snapshots only if the new one isn't missing most listings: a listing
// count that fell by more than half points at a partial or broken response, and
// diffing it would count every missing listing as bought.
export function diffPlausible(prev, cur) {
  return !prev || cur.l.length * 2 >= prev.l.length;
}

// Snapshot time: the newer of the two Last-Modified headers (auctions, commodities).
export function snapshotTime(...lastModified) {
  const ts = lastModified.map((s) => Date.parse(s ?? "")).filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : Date.now();
}

// Text inside a double-quoted Lua string.
export function luaEscape(s) {
  return String(s).replace(/[\\"]/g, (c) => "\\" + c).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

// Prices.lua is run as code in every player's game, so anything from an API that
// goes into it must be what we expect. An item or house ID: a positive whole
// number (or a string of digits); anything else is null and gets dropped.
export function toId(x) {
  const n = typeof x === "string" && /^\d+$/.test(x) ? Number(x) : x;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// A finite number above 0, or null.
export function toPositive(x) {
  const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

// Is `text` one house block of Prices.lua (`[house] = { ... },`) holding nothing
// but data? A block saved by an earlier run (history/<house>.block.lua) is put back
// into Prices.lua as it is, and the history branch it comes from could have been
// changed, so it must not be able to run anything in the game. Allowed: tables,
// keys (`name =`, `[123] =`), numbers, true/false and strings as luaEscape writes
// them. No calls, names as values, operators or comments get through.
const LUA_KEYWORDS = new Set(["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"]);
export function isHouseBlock(text, house) {
  const tokens = [];
  const re = /\s*(?:([{},=])|\[(\d+)\]|("(?:[^"\\\r\n]|\\["\\nr])*")|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([A-Za-z_]\w*))/y;
  const src = String(text).trimEnd();
  while (re.lastIndex < src.length) {
    const m = re.exec(src);
    if (!m) return false;
    tokens.push(m[1] ? { k: m[1] } : m[2] ? { k: "[]", v: m[2] } : m[3] ? { k: "str" } : m[4] ? { k: "num" } : { k: "name", v: m[5] });
  }
  let i = 0;
  const value = (depth) => {
    const t = tokens[i++];
    if (t?.k === "{") return depth < 8 && table(depth + 1);
    return t?.k === "str" || t?.k === "num" || (t?.k === "name" && (t.v === "true" || t.v === "false"));
  };
  const table = (depth) => { // just after "{"
    for (;;) {
      if (tokens[i]?.k === "}") { i++; return true; }
      const t = tokens[i];
      if ((t?.k === "[]" || (t?.k === "name" && !LUA_KEYWORDS.has(t.v))) && tokens[i + 1]?.k === "=") i += 2;
      if (!value(depth)) return false;
      const sep = tokens[i++]?.k;
      if (sep === "}") return true;
      if (sep !== ",") return false;
    }
  };
  if (!(tokens[0]?.k === "[]" && tokens[0].v === String(house) && tokens[1]?.k === "=" && tokens[2]?.k === "{")) return false;
  i = 3;
  return table(1) && tokens[i]?.k === "," && i + 1 === tokens.length;
}
