/**
 * Shared game rules and draw validation.
 *
 * Every adapter in `sources.mjs` funnels its output through `validateDraw()`.
 * That is the safety net: scrapers break silently when a site is redesigned,
 * and a tolerant parser that keeps running against changed markup is far worse
 * than one that fails loudly. Nothing reaches `draws.json` unless it is a
 * structurally valid draw, on a legal draw weekday, with a plausible date.
 */

export const GAMES = {
  euro: {
    key: 'euro',
    label: 'EuroJackpot',
    main: { count: 5, min: 1, max: 50 },
    extra: { count: 2, min: 1, max: 12 },
    // EuroJackpot is drawn Tuesday and Friday (Fri only before 2022-03-25).
    drawDays: [2, 5]
  },
  lotto: {
    key: 'lotto',
    label: 'Lotto 6 aus 49',
    main: { count: 6, min: 1, max: 49 },
    extra: { count: 1, min: 0, max: 9 },
    // 6aus49 is drawn Wednesday and Saturday.
    drawDays: [3, 6]
  }
};

export const GAME_KEYS = Object.keys(GAMES);

/** ISO `YYYY-MM-DD` -> weekday index (0 = Sunday), evaluated in UTC. */
function weekdayOf(iso) {
  return new Date(iso + 'T12:00:00Z').getUTCDay();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate one candidate draw.
 *
 * @param {string} gameKey            'euro' | 'lotto'
 * @param {object} draw               { date, main, extra }
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays]  reject draws older than this (freshness
 *                                    check — a "latest" result from six weeks
 *                                    ago means the parser lost the page, not
 *                                    that the lottery paused)
 * @returns {string|null}             error message, or null when valid
 */
export function validateDraw(gameKey, draw, opts = {}) {
  const g = GAMES[gameKey];
  if (!g) return `unknown game "${gameKey}"`;
  if (!draw || typeof draw !== 'object') return 'draw is not an object';

  const { date, main, extra } = draw;

  if (typeof date !== 'string' || !ISO_DATE.test(date)) return `bad date "${date}"`;
  const t = Date.parse(date + 'T00:00:00Z');
  if (Number.isNaN(t)) return `unparseable date "${date}"`;

  const now = Date.now();
  if (t > now + 36 * 3600 * 1000) return `date "${date}" is in the future`;
  if (opts.maxAgeDays != null && now - t > opts.maxAgeDays * 86400000) {
    return `date "${date}" is older than ${opts.maxAgeDays} days`;
  }
  if (!g.drawDays.includes(weekdayOf(date))) {
    return `"${date}" is not a ${g.label} draw day`;
  }

  const checkSet = (label, values, spec, allowZero) => {
    if (!Array.isArray(values)) return `${label} is not an array`;
    if (values.length !== spec.count) return `${label}: expected ${spec.count} numbers, got ${values.length}`;
    for (const n of values) {
      if (!Number.isInteger(n)) return `${label}: "${n}" is not an integer`;
      const lo = allowZero ? Math.min(spec.min, 0) : spec.min;
      if (n < lo || n > spec.max) return `${label}: ${n} outside ${lo}-${spec.max}`;
    }
    if (new Set(values).size !== values.length) return `${label}: duplicate numbers`;
    return null;
  };

  return checkSet('main', main, g.main, false)
    || checkSet('extra', extra, g.extra, true);
}

/** Canonical form: sorted numbers, no stray fields, stable key ordering. */
export function normaliseDraw(gameKey, draw) {
  const asc = (a, b) => a - b;
  return {
    date: draw.date,
    main: draw.main.slice().sort(asc),
    extra: draw.extra.slice().sort(asc),
    source: draw.source || 'unknown'
  };
}

/** Two draws are the same event if they share a game and a date. */
export const drawKey = (gameKey, draw) => `${gameKey}|${draw.date}`;
