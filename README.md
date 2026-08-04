# Lotto & EuroJackpot Smart Generator

A single-page, fully client-side generator for **EuroJackpot** (5 of 50 + 2 of 12) and **Lotto 6 aus 49**
(6 of 49 + optional Superzahl), with a transparent decision matrix that scores six selection strategies
against real draw results and an adaptive mode that blends them.

> **Lotteries are random. Past results and this learning system do not improve the mathematical odds of
> winning. This tool is for entertainment and statistical exploration only. 18+.**

## Running it

`index.html` is self-contained — open it in any browser and everything works except the service worker
(browsers only register those over `http(s)`).

```bash
python3 -m http.server 8000   # or: npx serve .
```

Then open `http://localhost:8000`. For GitHub Pages, push all files to the repo root and enable
Settings → Pages → Deploy from branch → `main` / root.

| File | Purpose |
|---|---|
| `index.html` | The entire app: markup, Tailwind config, historical data, logic |
| `manifest.webmanifest`, `icon.svg` | PWA metadata |
| `sw.js` | Service worker, cache-first offline support |

## The four tabs

**Generate** — pick one of seven modes, 1–10 tickets, hit Generate (or press `Space`/`Enter`). Every
ticket is stored as a *prediction*, tagged with the strategy that produced it.

**Decision Matrix** — sortable table of all six ranked strategies plus the adaptive ensemble, showing
predictions made, predictions evaluated, average numbers matched, tier hits (`3+1` = three main numbers
and one extra), prize rate, edge and weight.

**Learning** — enter an official draw result. Every open prediction for that game is compared against it,
the matrix updates, and the rows that moved flash.

**Statistics** — frequency heatmap, hottest and coldest numbers, structural profile, most common pairs,
and CSV import for your own draw archive.

## Randomness

`crypto.getRandomValues()` throughout, never `Math.random()`. Two details keep it exactly uniform:

1. **Rejection sampling.** `value % 50` on a 32-bit integer is biased, since 2³² is not divisible by 50.
   Values above `floor(2³² / range) × range` are discarded and redrawn.
2. **Partial Fisher–Yates** for unique picks — no retry-on-duplicate loop, so every combination is
   equally likely.

Weighted strategies use roulette-wheel selection without replacement against the same CSPRNG stream.

## Historical data

Embedded as plain counts, taken from published draw archives:

- **EuroJackpot** — 452 draws, from 25 March 2022. That window is deliberate: the Euro-number pool grew
  from 10 to 12 balls on that date, so earlier draws are a different game and would distort the
  frequencies for numbers 11 and 12.
- **Lotto 6aus49** — 5,029 draws since 9 October 1955; the Superzahl counts cover the 3,143 draws since
  it was introduced in December 1991.

Both are static snapshots. **Pair statistics ship empty on purpose** — they need actual draw
combinations, not per-number counts, so the Pattern strategy falls back to structural rules until you
import an archive (Statistics tab) or record results yourself. CSV format, one draw per line:

```
date,n1,n2,n3,n4,n5[,n6],extra1[,extra2]
2026-07-24,4,17,23,38,45,3,9
```

## Decision Matrix scoring

Every evaluated prediction produces a **value**:

```
value = mainMatched + extraWeight × extraMatched
extraWeight = 1.5 (Euro numbers) or 1.0 (Superzahl)
```

That value is compared against what pure chance delivers. For a k-of-N draw the expected number of hits
is `k²/N`, so:

```
baseline(EuroJackpot) = 5×5/50 + 1.5 × 2×2/12 = 0.5 + 0.5 = 1.000
baseline(6aus49)      = 6×6/49 + 1.0 × 1×1/10 = 0.735 + 0.1 = 0.835
```

From there:

```
edge       = (Σ value / evaluated) / baseline      1.0 = exactly as good as random
confidence = evaluated / (evaluated + 25)          0 → 1 as the sample grows
weight     = clamp(round(50 × (1 + (edge − 1) × confidence)), 5, 100)
```

The `confidence` term is the important one. It is [James–Stein style
shrinkage](https://en.wikipedia.org/wiki/James%E2%80%93Stein_estimator): with 5 evaluations a strategy
keeps only 17% of its apparent edge, at 25 evaluations half of it, at 100 about 80%. Without it, one
lucky ticket would send a strategy to weight 100 and the ensemble would chase noise immediately.
**Weight 50 means "indistinguishable from random"** — which, for a fair lottery, is where all six belong.

`prizeRate` is separate: the share of evaluated predictions reaching the lowest paying tier (2 main + 1
Euro number, or 2 main + Superzahl).

## The learning loop

1. **Generate** — the ticket is stored with its strategy, numbers and timestamp, and the strategy's
   `predictions` counter increments.
2. **Record Actual Draw Result** — you enter the official numbers and the draw date.
3. **Evaluate** — every prediction for that game that is not yet evaluated and was created *before* the
   draw is compared: main hits, extra hits, tier, prize yes/no. Predictions are evaluated exactly once,
   so recording the same draw twice cannot inflate anything.
4. **Update** — the strategy's totals, tier histogram and prize count grow; edge, confidence and weight
   are recomputed from those totals on every render.
5. **Feed forward** — the new weights change the adaptive ensemble immediately.

All of it lives in `localStorage` under `lotto-smart-v1` (predictions, recorded draws, matrix, imported
archive). Nothing is sent anywhere. The progress bar tracks evaluated predictions toward 60, the point
where weights can move reasonably freely.

## How Adaptive mode combines strategies

Each of the six strategies exposes a **score vector**: a normalised preference over every main number.

- *Random* — flat.
- *Hot* — softmax over standardised frequencies, `exp(z / T)` with `T = 1.0`. A number one standard
  deviation above average is about 2.7× more likely than an average one; nothing ever reaches zero.
- *Cold* — the same with the sign flipped, `exp(−z / T)`.
- *Balanced* — the sum of the hot and cold vectors.
- *Pattern* — how often each number appears in the archive's most frequent pairs.
- *Monte Carlo* — appearance counts from the simulation.

The ensemble share of each strategy comes from its matrix weight, squared and normalised:

```
share(s) = weight(s)² / Σ weight(k)²
blended[n] = Σ share(s) × vector(s)[n]
```

Squaring sharpens real differences once they exist while leaving an untrained matrix (all weights 50) as
an even 16.7% split. The blended vector is then sampled without replacement — so adaptive mode is a
genuine mixture over number-level preferences, not just "pick whichever strategy is winning".

## Monte Carlo

The simulation runs frequency-weighted draws in a Web Worker (built from a Blob, so the file stays
standalone) and counts how often each number surfaces. It samples with replacement against a cumulative
weight array via binary search, skipping duplicates within a draw — fast enough for a million
iterations. If workers are unavailable, an identical chunked main-thread version takes over so the UI
keeps responding. The final ticket is drawn from a shortlist of the top `3k` numbers, weighted by their
simulated counts, so repeated runs are not identical.

Progress is reported every 5%. **More iterations sharpen the estimate of the frequency model — they do
not make a combination more likely to win.**

## An honest note on what you will observe

All six strategies sample from the same 50 balls. Their true expected value is identical, so their
weights will wander around 50 forever and whichever one leads today is leading by chance. That is the
interesting part: the matrix is a well-built instrument for watching a null result stay null, and a good
way to see how convincing pure noise can look when you put it in a table.
