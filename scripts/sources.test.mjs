#!/usr/bin/env node
/**
 * Parser tests against markup captured from the live sites.
 *
 * These fixtures are verbatim slices of what euro-jackpot.net and
 * dielottozahlende.net actually served, so a passing run means the parsers
 * handle the real shape — including the details that are easy to get wrong:
 * a day-month-year permalink, numbers listed in draw order rather than sorted,
 * and a Superzahl of 0.
 *
 *   node scripts/sources.test.mjs
 */

import { germanDate, slugDate, parseEuroArchiveRow, parseLottoCard } from './sources.mjs';
import { validateDraw, normaliseDraw } from './draw-schema.mjs';

let failures = 0;
const check = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n         got  ${a}\n         want ${b}`);
};

/* ---- Date helpers -------------------------------------------------------- */
console.log('\ndate parsing');
check('german date', germanDate('vom 08.08.2026'), '2026-08-08');
check('german date, single digits', germanDate('vom 3.5.2026'), '2026-05-03');
check('permalink date is day-month-year', slugDate('07-08-2026'), '2026-08-07');
check('permalink date, not month-first', slugDate('01-02-2026'), '2026-02-01');
check('no date', germanDate('vom demnächst'), null);

/* ---- euro-jackpot.net archive rows --------------------------------------- */
const EJ_ROW = `<tr> <td><a href="/results/07-08-2026">Friday 7<sup>th</sup> August 2026</a></td> <td>
<ul class="balls small">
<li class="ball"><span>1</span></li> <li class="ball"><span>3</span></li>
<li class="ball"><span>6</span></li> <li class="ball"><span>13</span></li>
<li class="ball"><span>23</span></li> <li class="euro"><span>5</span></li>
<li class="euro"><span>7</span></li> </ul> </td> <td>€45,000,000</td> </tr>`;

console.log('\neuro-jackpot.net archive row');
const ejDraw = parseEuroArchiveRow(EJ_ROW);
check('parsed', ejDraw, { date: '2026-08-07', main: [1, 3, 6, 13, 23], extra: [5, 7] });
check('validates', validateDraw('euro', ejDraw), null);
// The prize column holds "45,000,000" — those digits must not become balls.
check('prize digits ignored', ejDraw.main.length + ejDraw.extra.length, 7);

/* ---- dielottozahlende.net cards ------------------------------------------ */
const card = (bg, label, date, nums, highlight) => `
<div class="card ${bg} number-card"> <div class="card-body">
<h5 class="card-title number-title">${label}</h5>
<h6 class="card-subtitle mb-3">vom ${date}</h6>
<ul class="list-inline">
${nums.map((n, i) => `<li class="list-inline-item${i >= nums.length - highlight ? ' ml-2' : ''}">
  <span class="numbers ${i >= nums.length - highlight ? 'bg-highlight text-light' : 'bg-white'}">${n}</span></li>`).join('')}
</ul>
<p>Nachste Ziehung<br><strong>Mi. 12.08.2026 19:25 Uhr</strong></p>
</div> </div>`;

// Verbatim from the live page: draw order, not sorted.
const HOME = card('bg-sixaus49', 'LOTTO 6 AUS 49', '08.08.2026', [22, 30, 2, 8, 43, 38, 4], 1)
  + card('bg-euro-jackpot', 'EUROJACKPOT', '07.08.2026', [1, 3, 6, 13, 23, 5, 7], 2);

console.log('\ndielottozahlende.net front page');
const lottoDraw = parseLottoCard(HOME, 'lotto');
check('6aus49 parsed in draw order', lottoDraw,
  { date: '2026-08-08', main: [22, 30, 2, 8, 43, 38], extra: [4] });
check('6aus49 sorted on normalise', normaliseDraw('lotto', lottoDraw).main, [2, 8, 22, 30, 38, 43]);
check('6aus49 validates', validateDraw('lotto', lottoDraw), null);

const euroCard = parseLottoCard(HOME, 'euro');
check('euro card is not the 6aus49 card', euroCard,
  { date: '2026-08-07', main: [1, 3, 6, 13, 23], extra: [5, 7] });
check('euro validates', validateDraw('euro', euroCard), null);

// Superzahl 0 is legal and must not be dropped as falsy.
const ZERO = card('bg-sixaus49', 'LOTTO 6 AUS 49', '08.08.2026', [2, 9, 14, 22, 37, 44, 0], 1);
const zeroDraw = parseLottoCard(ZERO, 'lotto');
check('Superzahl 0 kept', zeroDraw && zeroDraw.extra, [0]);
check('Superzahl 0 validates', validateDraw('lotto', zeroDraw), null);

/* ---- Rejection ----------------------------------------------------------- */
console.log('\nvalidation rejects bad draws');
check('out of range', typeof validateDraw('euro', { date: '2026-08-07', main: [1, 3, 6, 13, 51], extra: [5, 7] }), 'string');
check('duplicate numbers', typeof validateDraw('euro', { date: '2026-08-07', main: [1, 1, 6, 13, 23], extra: [5, 7] }), 'string');
check('wrong weekday', typeof validateDraw('lotto', { date: '2026-08-07', main: [1, 2, 3, 4, 5, 6], extra: [4] }), 'string');
check('future date', typeof validateDraw('euro', { date: '2099-08-07', main: [1, 3, 6, 13, 23], extra: [5, 7] }), 'string');

console.log(failures ? `\n${failures} failing check(s)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
