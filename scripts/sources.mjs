/**
 * Draw-result sources.
 *
 * Each adapter is independent and returns raw candidate draws for one game.
 * `fetch-draws.mjs` tries them in order and keeps the first that yields a
 * result surviving `validateDraw()`. Adding a source means appending one
 * object to `SOURCES` — nothing else in the pipeline needs to know about it.
 *
 * Why scraping and not "the official API": Germany's lottery operators do not
 * publish an open, documented results API. Every adapter here therefore reads
 * a public results page and is, by nature, breakable. Two things keep that
 * honest rather than dangerous:
 *
 *   1. Strict validation downstream — a broken parser produces no draw, never
 *      a wrong one.
 *   2. `CUSTOM_DRAWS_URL` — point the workflow at any feed that already speaks
 *      this project's JSON and none of the scrapers run at all.
 */

import { GAMES } from './draw-schema.mjs';

const UA = 'german-lottery-draw-sync/1.0 (+https://github.com/sanjayyaluguli-lang/german-lottery)';
const TIMEOUT_MS = 20000;

async function get(url, accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8') {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept, 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

/* --------------------------------------------------------------------------
   Parsing helpers
   -------------------------------------------------------------------------- */

/** `24.07.2026` or `2026-07-24` -> `2026-07-24`. Returns null if neither. */
export function toIsoDate(raw) {
  if (!raw) return null;
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(raw);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const MONTHS_DE = ['januar', 'februar', 'märz', 'maerz', 'april', 'mai', 'juni', 'juli',
  'august', 'september', 'oktober', 'november', 'dezember'];

/** `Freitag, 24. Juli 2026` -> `2026-07-24`. */
export function germanLongDate(raw) {
  const m = /(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})/.exec(raw || '');
  if (!m) return null;
  let idx = MONTHS_DE.indexOf(m[2].toLowerCase());
  if (idx === -1) return null;
  if (idx > 3) idx -= 1;                       // collapse the "märz"/"maerz" alias
  return `${m[3]}-${String(idx + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * Every date spelling these pages use. Dates are removed before numbers are
 * read, otherwise the day in "31. Juli 2026" is picked up as a drawn ball.
 */
const DATE_NOISE = new RegExp(
  '\\d{1,2}\\s*[.\\-/]\\s*\\d{1,2}\\s*[.\\-/]\\s*\\d{2,4}'          // 24.07.2026
  + '|\\d{4}-\\d{2}-\\d{2}'                                         // 2026-07-24
  + `|\\d{1,2}\\s*\\.\\s*(?:${MONTHS_DE.join('|')})\\s*\\d{0,4}`,    // 31. Juli 2026
  'gi'
);

const stripTags = html => html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ');

/** All standalone 1-2 digit integers, in document order. */
const smallInts = text => Array.from(text.matchAll(/(?<!\d)(\d{1,2})(?!\d)/g), m => Number(m[1]));

/**
 * Pull the first `count` numbers that fall inside [min,max] and are not
 * already used. Draws never repeat a number, so "distinct and in range" is a
 * strong filter against picking up prize amounts or page furniture.
 */
function takeDistinct(pool, count, min, max, used = new Set()) {
  const out = [];
  for (const n of pool) {
    if (n < min || n > max || used.has(n) || out.includes(n)) continue;
    out.push(n);
    if (out.length === count) return out;
  }
  return null;
}

/**
 * Read one draw out of a slice of text that is known to contain exactly one
 * result: a date followed by the main numbers, then the extra numbers.
 */
export function readDrawFromText(gameKey, text, dateHint) {
  const g = GAMES[gameKey];
  const date = dateHint || toIsoDate(text) || germanLongDate(text);
  if (!date) return null;

  // Drop the date itself so its day/month digits cannot be read as balls.
  const pool = smallInts(text.replace(DATE_NOISE, ' '));

  const main = takeDistinct(pool, g.main.count, g.main.min, g.main.max);
  if (!main) return null;

  // Extras come after the mains, so continue from where the mains ended.
  const lastMainAt = pool.lastIndexOf(main[main.length - 1]);
  const rest = pool.slice(lastMainAt + 1);
  const extra = takeDistinct(rest, g.extra.count, Math.min(g.extra.min, 0), g.extra.max);
  if (!extra) return null;

  return { date, main, extra };
}

/** Deep-search parsed JSON for objects that look like a draw. */
function harvestJsonDraws(gameKey, root) {
  const g = GAMES[gameKey];
  const found = [];
  const seen = new Set();
  const numArray = v => Array.isArray(v) && v.length && v.every(n => Number.isInteger(Number(n)))
    ? v.map(Number) : null;

  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }

    const keys = Object.keys(node);
    const pick = re => keys.find(k => re.test(k));
    const mainKey = pick(/^(gewinnzahlen|winningnumbers|numbers|zahlen|balls)$/i);
    const extraKey = pick(/^(eurozahlen|euronumbers|zusatzzahlen|superzahl|extranumbers|stars)$/i);
    const dateKey = pick(/(date|datum|ziehung)/i);

    if (mainKey) {
      const main = numArray(node[mainKey]);
      let extra = extraKey ? numArray(node[extraKey]) : null;
      if (extra === null && extraKey != null && Number.isInteger(Number(node[extraKey]))) {
        extra = [Number(node[extraKey])];       // Superzahl arrives as a scalar
      }
      const date = dateKey ? (toIsoDate(String(node[dateKey])) || germanLongDate(String(node[dateKey]))) : null;
      if (main && main.length === g.main.count && extra && date) {
        found.push({ date, main, extra });
      }
    }
    keys.forEach(k => walk(node[k]));
  };

  walk(root);
  return found;
}

/** Every `{...}` / `[...]` blob in a page's inline scripts that parses as JSON. */
function inlineJson(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    for (const start of ['{', '[']) {
      let i = body.indexOf(start);
      while (i > -1 && out.length < 40) {
        const slice = body.slice(i);
        for (let end = slice.length; end > 40; end = Math.floor(end * 0.9)) {
          try { out.push(JSON.parse(slice.slice(0, end))); break; } catch { /* keep shrinking */ }
        }
        i = body.indexOf(start, i + 1);
        if (out.length > 20) break;
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------------------
   Adapters
   -------------------------------------------------------------------------- */

/**
 * A source your workflow controls. Set the repository variable
 * `CUSTOM_DRAWS_URL` to any endpoint returning either this project's
 * `draws.json` shape or a bare `[{date, main, extra}, ...]` array, and it wins
 * over every scraper below.
 */
const customFeed = {
  id: 'custom',
  games: ['euro', 'lotto'],
  enabled: () => Boolean(process.env.CUSTOM_DRAWS_URL),
  async fetch(gameKey) {
    const url = process.env.CUSTOM_DRAWS_URL.replace('{game}', gameKey);
    const data = JSON.parse(await get(url, 'application/json'));
    if (Array.isArray(data)) return data;
    if (data?.games?.[gameKey]?.draws) return data.games[gameKey].draws;
    return harvestJsonDraws(gameKey, data);
  }
};

const lottoDe = {
  id: 'lotto.de',
  games: ['euro', 'lotto'],
  urls: {
    euro: 'https://www.lotto.de/eurojackpot/zahlen-quoten',
    lotto: 'https://www.lotto.de/lotto-6aus49/zahlen-quoten'
  },
  async fetch(gameKey) {
    const html = await get(this.urls[gameKey]);
    const fromJson = inlineJson(html).flatMap(root => harvestJsonDraws(gameKey, root));
    if (fromJson.length) return fromJson;
    const draw = readDrawFromText(gameKey, stripTags(html));
    return draw ? [draw] : [];
  }
};

/**
 * The state lotteries' legacy info service. It has served a machine-readable
 * results blob for well over a decade, which makes it the most stable of the
 * scraped sources — but it is one undocumented text format, so the parser
 * locates the game's block by keyword and reads the first result inside it.
 */
const westlotto = {
  id: 'westlotto-infoservice',
  games: ['euro', 'lotto'],
  url: 'https://www.westlotto.de/wlinfo/WL_InfoService?client=wlinfo&gruppe=ZahlenUndQuoten',
  markers: { euro: /eurojackpot/i, lotto: /(6\s*aus\s*49|\blotto\b)/i },
  async fetch(gameKey) {
    const text = stripTags(await get(this.url, 'application/xml,text/xml,text/plain,*/*'));
    const hit = this.markers[gameKey].exec(text);
    if (!hit) return [];
    // EuroJackpot also contains the word "Lotto" in prose; for 6aus49 start the
    // window at the marker and stop before any EuroJackpot block that follows.
    let window = text.slice(hit.index, hit.index + 1200);
    if (gameKey === 'lotto') window = window.split(/eurojackpot/i)[0];
    const draw = readDrawFromText(gameKey, window);
    return draw ? [draw] : [];
  }
};

const euroJackpotNet = {
  id: 'euro-jackpot.net',
  games: ['euro'],
  url: 'https://www.euro-jackpot.net/en/results',
  async fetch(gameKey) {
    const html = await get(this.url);
    // Results pages list one block per draw; the first block is the newest.
    const blocks = html.split(/<(?:tr|li|article)\b/i).slice(1);
    const draws = [];
    for (const block of blocks.slice(0, 12)) {
      const draw = readDrawFromText(gameKey, stripTags(block));
      if (draw) draws.push(draw);
    }
    return draws;
  }
};

export const SOURCES = [customFeed, lottoDe, westlotto, euroJackpotNet];

export const sourcesFor = gameKey => SOURCES.filter(
  s => s.games.includes(gameKey) && (!s.enabled || s.enabled())
);
