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
| `data/draws.json` | Published draw results — the feed the app learns from |
| `scripts/fetch-draws.mjs` | Builds that feed. Run by GitHub Actions after each draw |
| `scripts/sources.mjs` | One adapter per results source |
| `scripts/sources.test.mjs` | Parser tests over captured markup, no network |
| `scripts/draw-schema.mjs` | Game rules and draw validation |

## The four tabs

**Generate** — pick one of seven modes, 1–10 tickets, hit Generate (or press `Space`/`Enter`). Every
ticket is stored as a *prediction*, tagged with the strategy that produced it.

**Decision Matrix** — sortable table of all six ranked strategies plus the adaptive ensemble, showing
predictions made, predictions evaluated, average numbers matched, tier hits (`3+1` = three main numbers
and one extra), prize rate, edge and weight.

**Learning** — official results arrive on their own from the [results feed](#automatic-results-feed);
you can also enter a draw by hand. Either way every open prediction for that game is compared against it,
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

Both are static snapshots. **Pair statistics ship empty in the page itself** — they need actual draw
combinations, not per-number counts. In practice the [results feed](#automatic-results-feed) fills them
in: it backfills EuroJackpot from the source's yearly archives, so the Pattern strategy has real pairs to
work with on first load. You can also import an archive (Statistics tab) or record results yourself. CSV format, one draw per line:

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
2. **Record Actual Draw Result** — the [results feed](#automatic-results-feed) supplies the official
   numbers after each draw, or you enter them yourself.
3. **Evaluate** — every prediction for that game that is not yet evaluated and was created *before* the
   draw is compared: main hits, extra hits, tier, prize yes/no. Predictions are evaluated exactly once,
   so recording the same draw twice cannot inflate anything.
4. **Update** — the strategy's totals, tier histogram and prize count grow; edge, confidence and weight
   are recomputed from those totals on every render.
5. **Feed forward** — the new weights change the adaptive ensemble immediately.

All of it lives in `localStorage` under `lotto-smart-v1` (predictions, recorded draws, matrix, imported
archive). Nothing is sent anywhere. The progress bar tracks evaluated predictions toward 60, the point
where weights can move reasonably freely.

## Automatic results feed

Step 2 of that loop used to be the only manual part. It isn't any more: a scheduled job fetches the
official results and publishes them as `data/draws.json`, and the app records everything new it finds
there — no typing, no accounts, no backend.

### How it fits together

```
GitHub Actions (after each draw)
  └─ scripts/fetch-draws.mjs
       ├─ tries each source in scripts/sources.mjs, in order
       ├─ validates every candidate against scripts/draw-schema.mjs
       └─ merges into data/draws.json, commits it
                    │
GitHub Pages serves data/draws.json next to index.html
                    │
  └─ the app fetches it on load, on "Sync now", and when the tab
     regains focus (at most twice an hour)
       ├─ re-validates every draw
       ├─ skips any it already has (one result per game per day)
       └─ applies the rest oldest-first through applyDraw()
```

Serving the feed from the site's own origin is the point of the design. A static page cannot call a
lottery website directly — the browser's same-origin policy blocks it, and none of those sites send CORS
headers — so the fetch happens in CI instead, where there is no browser to object. The app only ever
talks to the host it is already loaded from.

### The feed format

```json
{
  "version": 1,
  "updated": "2026-08-04T21:32:11.508Z",
  "games": {
    "euro": {
      "label": "EuroJackpot",
      "latest": { "date": "2026-08-07", "main": [1,3,6,13,23], "extra": [5,7], "source": "euro-jackpot.net" },
      "count": 167,
      "draws": [ "newest first, up to 750 per game" ]
    },
    "lotto": { "…": "same shape" }
  }
}
```

It is a plain static file, so anything else may read it too.

### Schedule

`.github/workflows/update-draws.yml` runs at 21:30 UTC on each of the four draw days — after
EuroJackpot's 21:00 Tuesday/Friday draw and 6aus49's Wednesday/Saturday draw in both CET and CEST — plus
a morning catch-up run in case a source was down or a result was published late. It only commits when
`data/draws.json` actually changed.

The workflow declares `permissions: contents: write`, which is enough to push its commit on a personal
repository — no repository setting to change. If an organisation policy caps the default `GITHUB_TOKEN`
scope, the commit step will fail with a 403; the fix is Settings → Actions → General → Workflow
permissions → **Read and write permissions**.

### Sources, and how they break

Germany's lottery operators publish no open results API, and the obvious candidates are dead ends:
`lotto.de` renders its numbers client-side into an empty `WinningNumbers` shell, and WestLotto's
`WL_InfoService` — for years *the* machine-readable feed for German draws — now answers `400` on every
path. So each adapter in `scripts/sources.mjs` reads a public results page instead:

| Adapter | Covers | Reads |
|---|---|---|
| `euro-jackpot.net` | EuroJackpot | The yearly archive table. The date comes from each row's `/results/DD-MM-YYYY` permalink, and main vs. Euro numbers are separated by CSS class, so nothing is positional. Reads the previous year too, since in early January the current archive is nearly empty. |
| `dielottozahlende.net` | Both | The front page, which carries the latest draw for each game as a card. Numbers appear in draw order, not sorted. |

EuroJackpot is deliberately covered twice: both sites rate-limit, and a shared CI IP gets refused often
enough that one source alone is not dependable. `get()` retries once with a backoff, and a refusal falls
through to the next source.

Scraping is inherently fragile — a redesign breaks a parser. Two things keep fragile from meaning wrong:

- **Nothing unvalidated reaches the feed.** `validateDraw()` checks the count, range, uniqueness and
  ordering of every number, that the date is real, recent and lands on an actual draw day for that game,
  and that the newest draw a source offers is at most 21 days old. A broken parser therefore produces
  *no* draw, never a plausible-looking wrong one — and the app re-runs the same range checks on whatever
  the feed hands it, because a feed fetched over the network is an input like any other.
- **Sources are tried in order and fall through.** The first one to return a valid draw wins; if it
  fails, the next is tried. A failed run leaves the previous `data/draws.json` untouched and exits
  non-zero, so it shows up as a red run rather than as silently missing data.

`scripts/sources.test.mjs` runs the exported parsers over markup captured verbatim from both sites, and
runs in CI before any fetch — so a red run tells you whether the site changed or the parser was already
broken. It covers the details that are easy to get wrong: day-month-year permalinks, numbers in draw
order rather than sorted, and a Superzahl of `0`, which must not be dropped as falsy.

```bash
node scripts/sources.test.mjs              # parser tests, no network
node scripts/fetch-draws.mjs --check       # probes every source live, writes nothing
node scripts/fetch-draws.mjs --game euro   # one game
```

or run the workflow manually with **Probe the sources** ticked. Node 20+, no dependencies.

### The escape hatch

If every scraper breaks, or you already have a results source you trust, set the repository variable
`CUSTOM_DRAWS_URL` (Settings → Secrets and variables → Actions → Variables). It takes priority over every
scraper and needs no code change. The URL may contain `{game}`, replaced with `euro` or `lotto`, and may
return either this project's `draws.json` shape or a bare array:

```json
[{ "date": "2026-08-04", "main": [4,17,23,38,45], "extra": [3,9] }]
```

Adding a source properly is one object appended to `SOURCES` in `scripts/sources.mjs`: an `id`, the
`games` it covers, and an async `fetch(gameKey)` returning candidate draws. Validation and merging are
already handled.

### What this does and does not change

It automates the bookkeeping, and nothing else. The matrix now updates from real results without anyone
remembering to type them in, which makes the learning loop honest — every draw counts, not just the ones
you felt like recording. It does not make any strategy better. See the closing section: the weights will
still wander around 50 forever, only now they will do it unattended.

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
