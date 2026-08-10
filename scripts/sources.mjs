/**
 * Draw-result sources.
 *
 * Each adapter returns raw candidate draws for one game. `fetch-draws.mjs`
 * tries them in order and keeps the first that yields a result surviving
 * `validateDraw()`. Adding a source means appending one object to `SOURCES`.
 *
 * Germany's lottery operators publish no open results API, and the obvious
 * candidates are dead ends: lotto.de renders its numbers client-side into an
 * empty `WinningNumbers` shell, and WestLotto's old `WL_InfoService` — for
 * years the go-to machine-readable feed — now answers 400 on every path. So
 * these adapters read public results pages, written against markup captured
 * from the live sites rather than guessed at.
 *
 * That makes them breakable by design. Two things keep breakable from meaning
 * wrong: every candidate is validated downstream, so a broken parser yields no
 * draw rather than a plausible wrong one; and `CUSTOM_DRAWS_URL` bypasses the
 * scrapers entirely if they all fail.
 */

import { GAMES } from './draw-schema.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const TIMEOUT_MS = 20000;

/**
 * These sites rate-limit, and a CI runner's IP is shared — a source that
 * answered a minute ago can refuse the next request. One retry turns most of
 * that into a slow success instead of a failed run.
 */
async function get(url, { accept = 'text/html,application/xhtml+xml,*/*;q=0.8', tries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1500 * attempt));
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept, 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res.text();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/* --------------------------------------------------------------------------
   Parsing helpers
   -------------------------------------------------------------------------- */

/** `08.08.2026` -> `2026-08-08`. */
export function germanDate(raw) {
  const m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(raw || '');
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/** `07-08-2026` (day-month-year, as used in result permalinks) -> `2026-08-07`. */
export function slugDate(raw) {
  const m = /(\d{2})-(\d{2})-(\d{4})/.exec(raw || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Split `numbers` into the game's main and extra sets, or null if it can't. */
function splitDraw(gameKey, numbers) {
  const g = GAMES[gameKey];
  if (numbers.length !== g.main.count + g.extra.count) return null;
  return { main: numbers.slice(0, g.main.count), extra: numbers.slice(g.main.count) };
}

/**
 * One row of euro-jackpot.net's archive table. Exported so the tests drive the
 * same code the adapter does.
 */
export function parseEuroArchiveRow(row) {
  const date = slugDate((/href="\/results\/(\d{2}-\d{2}-\d{4})"/.exec(row) || [])[1]);
  if (!date) return null;
  const pick = cls => Array.from(
    row.matchAll(new RegExp(`<li[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>\\s*<span>(\\d{1,2})</span>`, 'gi')),
    m => Number(m[1])
  );
  const main = pick('ball'), extra = pick('euro');
  return main.length && extra.length ? { date, main, extra } : null;
}

const CARD_CLASS = { lotto: 'bg-sixaus49', euro: 'bg-euro-jackpot' };

/**
 * One game card from dielottozahlende.net's front page. The card is bounded at
 * the next `number-card` rather than by a fixed window: the two game cards sit
 * next to each other, so a window wide enough for one reaches into the other
 * and collects both draws' numbers.
 */
export function parseLottoCard(html, gameKey) {
  const at = new RegExp(`class="card\\s+${CARD_CLASS[gameKey]}\\s+number-card"`, 'i').exec(html);
  if (!at) return null;

  const rest = html.slice(at.index + at[0].length);
  const next = rest.search(/number-card/i);
  const card = next === -1 ? rest.slice(0, 3000) : rest.slice(0, next);

  const date = germanDate((/vom\s+([\d.]+)/i.exec(card) || [])[1]);
  if (!date) return null;

  const numbers = Array.from(
    card.matchAll(/<span[^>]*class="[^"]*\bnumbers\b[^"]*"[^>]*>\s*(\d{1,2})\s*<\/span>/gi),
    m => Number(m[1])
  );
  const split = splitDraw(gameKey, numbers);
  return split ? { date, ...split } : null;
}

/* --------------------------------------------------------------------------
   Adapters
   -------------------------------------------------------------------------- */

/**
 * A source you control. Set the repository variable `CUSTOM_DRAWS_URL` to any
 * endpoint returning this project's `draws.json` shape or a bare
 * `[{date, main, extra}, ...]` array, and it wins over every scraper below.
 */
const customFeed = {
  id: 'custom',
  games: ['euro', 'lotto'],
  enabled: () => Boolean(process.env.CUSTOM_DRAWS_URL),
  async fetch(gameKey) {
    const url = process.env.CUSTOM_DRAWS_URL.replace('{game}', gameKey);
    const data = JSON.parse(await get(url, { accept: 'application/json' }));
    if (Array.isArray(data)) return data;
    return data?.games?.[gameKey]?.draws || [];
  }
};

/**
 * euro-jackpot.net's yearly archive — a table of every draw, one per row:
 *
 *   <td><a href="/results/07-08-2026">Friday 7th August 2026</a></td>
 *   <td><ul class="balls small">
 *         <li class="ball"><span>1</span></li>   ...five of these
 *         <li class="euro"><span>5</span></li>   ...two of these
 *
 * The date comes from the permalink rather than the visible text, since
 * "Friday 7th August 2026" is far more fragile to parse than `07-08-2026`.
 * Main and extra numbers are separated by CSS class, so no positional guessing
 * is involved. EuroJackpot only.
 */
const euroJackpotNet = {
  id: 'euro-jackpot.net',
  games: ['euro'],
  async fetch(gameKey) {
    const year = new Date().getUTCFullYear();
    // In early January the current year's archive is nearly empty, so read the
    // previous one too and let the merge sort it out.
    const pages = await Promise.allSettled([
      get(`https://www.euro-jackpot.net/results-archive-${year}`),
      get(`https://www.euro-jackpot.net/results-archive-${year - 1}`)
    ]);

    const draws = [];
    for (const page of pages) {
      if (page.status !== 'fulfilled') continue;
      for (const row of page.value.split(/<tr\b/i).slice(1)) {
        const draw = parseEuroArchiveRow(row);
        if (draw) draws.push(draw);
      }
    }
    return draws;
  }
};

/**
 * dielottozahlende.net's front page carries the latest draw for both games as
 * two cards:
 *
 *   <div class="card bg-sixaus49 number-card">
 *     <h6 ...>vom 08.08.2026</h6>
 *     <li class="list-inline-item"><span class="numbers bg-white ...">22</span></li>
 *     ...
 *     <li class="list-inline-item ml-2"><span class="numbers bg-...-highlight ...">4</span></li>
 *
 * Only the newest draw, which is all the feed needs on an ongoing basis — the
 * app accumulates history as results arrive. Numbers appear in draw order, not
 * sorted; `normaliseDraw()` sorts them. The extra numbers are last, so the
 * split is by count rather than by class, which holds for both cards.
 */
const dieLottozahlen = {
  id: 'dielottozahlende.net',
  games: ['euro', 'lotto'],
  async fetch(gameKey) {
    const draw = parseLottoCard(await get('https://www.dielottozahlende.net/'), gameKey);
    return draw ? [draw] : [];
  }
};

export const SOURCES = [customFeed, euroJackpotNet, dieLottozahlen];

export const sourcesFor = gameKey => SOURCES.filter(
  s => s.games.includes(gameKey) && (!s.enabled || s.enabled())
);
