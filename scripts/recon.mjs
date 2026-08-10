#!/usr/bin/env node
/**
 * TEMPORARY diagnostic. Probes candidate results URLs and reports what each
 * one actually returns, so the adapters in sources.mjs can be written against
 * real markup instead of guesses. Delete once the sources work.
 */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const CANDIDATES = [
  ['euro', 'https://www.euro-jackpot.net/en/results'],
  ['euro', 'https://www.euro-jackpot.net/en/results-archive-2026'],
  ['euro', 'https://www.lotto.de/eurojackpot/zahlen-quoten'],
  ['euro', 'https://www.lotto.de/eurojackpot/gewinnzahlen'],
  ['euro', 'https://www.lotto.de/eurojackpot'],
  ['euro', 'https://www.westlotto.de/eurojackpot/zahlen-quoten/eurojackpot-gewinnzahlen.html'],
  ['euro', 'https://www.eurojackpot.org/en/results/'],
  ['euro', 'https://www.lottozahlenonline.com/eurojackpot/zahlen-archiv.php'],
  ['lotto', 'https://www.lotto.de/lotto-6aus49/zahlen-quoten'],
  ['lotto', 'https://www.lotto.de/lotto-6aus49/lottozahlen'],
  ['lotto', 'https://www.lotto.de/lotto-6aus49'],
  ['lotto', 'https://www.westlotto.de/lotto-6aus49/zahlen-quoten/lotto-gewinnzahlen.html'],
  ['lotto', 'https://www.lottozahlen.net/'],
  ['lotto', 'https://www.dielottozahlende.net/'],
  ['both', 'https://www.westlotto.de/wlinfo/WL_InfoService?client=wlinfo&gruppe=ZahlenUndQuoten'],
  ['both', 'https://www.westlotto.de/wlinfo/WL_InfoService?client=wlinfo&gruppe=ZahlenUndQuoten&spielart=eurojackpot']
];

const KEYWORDS = /(gewinnzahl|winningnumber|eurozahl|superzahl|lottozahl|drawresult|"numbers"|ball)/i;

async function probe(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/json,*/*', 'accept-language': 'de-DE,de;q=0.9' },
      signal: AbortSignal.timeout(25000), redirect: 'follow'
    });
    const body = await res.text();
    console.log(`\n${'='.repeat(78)}\n${url}`);
    console.log(`  HTTP ${res.status} ${res.headers.get('content-type') || '?'} ${body.length}b ${Date.now() - started}ms`);
    if (res.url !== url) console.log(`  redirected -> ${res.url}`);
    if (!res.ok) { console.log('  ' + body.slice(0, 200).replace(/\s+/g, ' ')); return; }

    // Class/attribute names that look like ball markup.
    const classes = new Set();
    for (const m of body.matchAll(/class="([^"]{0,120})"/g)) {
      for (const c of m[1].split(/\s+/)) if (/ball|zahl|number|kugel|lotto|draw/i.test(c)) classes.add(c);
    }
    console.log('  ball-ish classes:', [...classes].slice(0, 25).join(' ') || '(none)');

    // JSON keys that look like draw data.
    const keys = new Set();
    for (const m of body.matchAll(/"([A-Za-z_]{3,30})"\s*:/g)) if (KEYWORDS.test(m[1])) keys.add(m[1]);
    console.log('  draw-ish JSON keys:', [...keys].slice(0, 20).join(' ') || '(none)');

    // Context around the first few keyword hits — this is what a parser needs.
    let shown = 0;
    for (const m of body.matchAll(new RegExp(KEYWORDS.source, 'gi'))) {
      if (shown++ >= 4) break;
      console.log(`  ...${body.slice(Math.max(0, m.index - 160), m.index + 340).replace(/\s+/g, ' ')}...`);
    }
    if (!shown) console.log('  no keyword hits — page is probably JS-rendered');
  } catch (e) {
    console.log(`\n${'='.repeat(78)}\n${url}\n  ERROR ${e.message}`);
  }
}

for (const [game, url] of CANDIDATES) {
  process.stdout.write(`\n[${game}]`);
  await probe(url);
}
