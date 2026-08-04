#!/usr/bin/env node
/**
 * Build `data/draws.json` — the feed the app reads to learn from real results.
 *
 * Run by `.github/workflows/update-draws.yml` after each draw. Merges whatever
 * the sources return into the existing file, so history accumulates and a
 * temporarily broken source costs nothing but a missed update.
 *
 *   node scripts/fetch-draws.mjs                 # update data/draws.json
 *   node scripts/fetch-draws.mjs --check         # probe sources, write nothing
 *   node scripts/fetch-draws.mjs --game euro     # one game only
 *
 * Exit codes: 0 = file written (or already current), 1 = no game could be
 * updated from any source.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAMES, GAME_KEYS, validateDraw, normaliseDraw, drawKey } from './draw-schema.mjs';
import { sourcesFor } from './sources.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/draws.json');

/** Draws kept per game. Feeds the app's pair statistics, so keep it generous. */
const HISTORY_LIMIT = 750;

/** A scraped "latest" result older than this means the parser lost the page. */
const MAX_AGE_DAYS = 21;

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const opt = name => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null; };

const CHECK_ONLY = flag('--check') || flag('--dry-run');
const ONLY_GAME = opt('--game');

const log = (...a) => console.log(...a);

async function loadExisting() {
  try {
    const parsed = JSON.parse(await readFile(OUT, 'utf8'));
    if (parsed && parsed.games) return parsed;
  } catch { /* first run, or the file was hand-edited into invalid JSON */ }
  return { version: 1, updated: null, games: {} };
}

/**
 * Ask each source for this game in turn. The first one to return at least one
 * draw that passes validation wins; later sources are not contacted.
 */
async function collect(gameKey) {
  const attempts = [];

  for (const source of sourcesFor(gameKey)) {
    const started = Date.now();
    try {
      const raw = await source.fetch(gameKey);
      const valid = [];
      const rejected = [];

      for (const candidate of raw || []) {
        const err = validateDraw(gameKey, candidate);
        if (err) rejected.push(err);
        else valid.push(normaliseDraw(gameKey, { ...candidate, source: source.id }));
      }

      // Freshness is judged on the newest draw the source offered, not on each
      // row — a results page legitimately lists old draws, but if none of them
      // is recent the parser has lost the page.
      const newest = valid.reduce((a, b) => (!a || b.date > a.date ? b : a), null);
      const stale = newest && Date.now() - Date.parse(newest.date + 'T00:00:00Z') > MAX_AGE_DAYS * 86400000;
      if (stale) {
        rejected.unshift(`newest draw ${newest.date} is over ${MAX_AGE_DAYS} days old`);
        valid.length = 0;
      }

      attempts.push({
        source: source.id, ok: valid.length > 0, ms: Date.now() - started,
        got: (raw || []).length, kept: valid.length, why: rejected[0] || null
      });

      if (valid.length) return { draws: valid, attempts };
    } catch (e) {
      attempts.push({ source: source.id, ok: false, ms: Date.now() - started, error: e.message });
    }
  }

  return { draws: [], attempts };
}

function mergeGame(previous, incoming) {
  const byKey = new Map();
  for (const d of previous?.draws || []) byKey.set(d.date, d);
  let added = 0;
  for (const d of incoming) {
    if (byKey.has(d.date)) continue;          // never rewrite a recorded result
    byKey.set(d.date, d);
    added++;
  }
  const draws = [...byKey.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, HISTORY_LIMIT);
  return { draws, added };
}

async function main() {
  const games = ONLY_GAME ? [ONLY_GAME] : GAME_KEYS;
  for (const g of games) {
    if (!GAMES[g]) { console.error(`Unknown game "${g}". Expected: ${GAME_KEYS.join(', ')}`); process.exit(2); }
  }

  const file = await loadExisting();
  let anyOk = false, totalAdded = 0;

  for (const gameKey of games) {
    const g = GAMES[gameKey];
    log(`\n${g.label}`);

    const { draws, attempts } = await collect(gameKey);
    for (const a of attempts) {
      const detail = a.error ? `error: ${a.error}`
        : a.ok ? `kept ${a.kept}/${a.got}`
        : a.got ? `all ${a.got} rejected (${a.why})`
        : 'no draws found';
      log(`  ${a.ok ? 'ok  ' : 'fail'}  ${a.source.padEnd(24)} ${String(a.ms).padStart(5)}ms  ${detail}`);
    }

    if (!draws.length) { log('  -> no usable result'); continue; }
    anyOk = true;

    const { draws: merged, added } = mergeGame(file.games[gameKey], draws);
    totalAdded += added;
    const top = merged[0];
    log(`  -> newest ${top.date} [${top.main.join(' ')}] + [${top.extra.join(' ')}] via ${top.source}`);
    log(`  -> ${added} new, ${merged.length} stored`);

    if (CHECK_ONLY) continue;
    file.games[gameKey] = {
      label: g.label,
      main: g.main,
      extra: g.extra,
      latest: merged[0] || null,
      count: merged.length,
      draws: merged
    };
  }

  if (CHECK_ONLY) {
    log(`\n--check: nothing written.`);
    process.exit(anyOk ? 0 : 1);
  }

  if (!anyOk) {
    console.error('\nNo game could be updated from any source — leaving data/draws.json untouched.');
    process.exit(1);
  }

  file.version = 1;
  file.updated = new Date().toISOString();
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(file, null, 2) + '\n');
  log(`\nWrote ${OUT} (${totalAdded} new draw${totalAdded === 1 ? '' : 's'}).`);
}

main().catch(e => { console.error(e); process.exit(1); });
