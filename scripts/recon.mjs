#!/usr/bin/env node
/**
 * TEMPORARY diagnostic. Round 2.
 *
 * Round 1 found EuroJackpot: euro-jackpot.net's archive serves a clean table,
 * `<a href="/results/07-08-2026">` for the date and `<li class="ball">` /
 * `<li class="euro">` for the numbers. It is EuroJackpot-only, so this round
 * hunts for the same thing for 6aus49 — starting with lotto.net, which looks
 * like the same publisher's network, and dielottozahlende.net.
 *
 * Round 1 also ruled out: lotto.de (numbers are client-rendered into an empty
 * `WinningNumbers__loading` shell), westlotto.de (404 / 400 on every path),
 * eurojackpot.org and lottozahlenonline.com (404).
 */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const YEAR = new Date().getUTCFullYear();

const CANDIDATES = [
  ['lotto', `https://www.lotto.net/german-lotto/results`],
  ['lotto', `https://www.lotto.net/german-lotto/results-archive-${YEAR}`],
  ['lotto', `https://www.lotto.net/german-lotto/past-results`],
  ['lotto', 'https://www.dielottozahlende.net/'],
  ['lotto', 'https://www.dielottozahlende.net/lottozahlen/6aus49'],
  ['lotto', 'https://www.lotto-bayern.de/lotto-6aus49/gewinnzahlen'],
  ['euro',  `https://www.lotto.net/eurojackpot/results-archive-${YEAR}`],
  ['euro',  `https://www.euro-jackpot.net/results-archive-${YEAR}`]
];

/** Print a decent slab of raw markup around the first ball-like element. */
function slab(body) {
  const anchors = [/<ul[^>]*class="[^"]*balls/i, /class="[^"]*number-card/i, /class="[^"]*\bball\b/i,
    /class="[^"]*numbers/i, /gewinnzahl/i];
  for (const re of anchors) {
    const m = re.exec(body);
    if (m) return body.slice(Math.max(0, m.index - 500), m.index + 1600).replace(/\s+/g, ' ');
  }
  return null;
}

async function probe(game, url) {
  console.log(`\n${'='.repeat(78)}\n[${game}] ${url}`);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*', 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(25000), redirect: 'follow'
    });
    const body = await res.text();
    console.log(`  HTTP ${res.status} ${body.length}b${res.url !== url ? ` -> ${res.url}` : ''}`);
    if (!res.ok) return;
    const s = slab(body);
    console.log(s ? '  ' + s : '  no ball-like markup found');
  } catch (e) {
    console.log(`  ERROR ${e.message}`);
  }
}

for (const [game, url] of CANDIDATES) await probe(game, url);
