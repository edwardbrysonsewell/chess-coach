# Chess Coach

An offline chess app for one iPhone. Play a bot with a real, measured Elo dial,
get warned before you hang a piece, and have the game explained to you
afterwards. No App Store, no account, and **no network calls at runtime, ever**.

Live: <https://edwardbrysonsewell.github.io/chess-coach/>

Open that in Safari, then Share → Add to Home Screen. After the first load it
works in airplane mode.

---

## What it does

**Play.** Drag a piece or tap it and tap the destination — both work, and a drag
that ends where it started falls back to a tap. Legal moves are dotted, the last
move and any check are highlighted, and the board flips. Promotion asks which
piece. Castle by moving the king two squares.

**A real Elo dial, 250 to 2800.** Not a guess — see [Bot strength](#bot-strength).

**Take back.** Undoes your move and the bot's reply together, as many times as
you like, and redo puts them back. Taken-back moves stay visible in the move
list, struck through, because they are still there to redo.

**Hints.** A toggle: turn it on and the engine's preferred move is drawn as an
arrow for every move, with a sentence explaining why.

**Danger warnings.** Before a move that gives something away, you get a sentence
naming the actual threat — "Careful — after g4, Ne2 would fork your queen and
rook" — with the option to play it anyway. Warned once per move, never blocked.

**Post-game review.** Accuracy for both sides, an evaluation graph, the opening
named with its plan, every move classified, and the moments that decided the game
explained.

**Clocks** from bullet to classical, optional. **Sound** for every move, capture,
check, promotion and mate. **Dark and light** follow the system. Games are saved
automatically.

---

## Bot strength

Rungs: 250, 400, 550, 700, 850, 1000, 1150, 1320, 1500, 1700, 1900, 2100, 2300,
2500, 2800.

At **1320 and above** the app uses Stockfish's own `UCI_LimitStrength` /
`UCI_Elo`, which the Stockfish project calibrates.

**Below 1320 Stockfish's limiter bottoms out**, so the handicap is ours:

1. A wide MultiPV search, so a weak move is chosen *knowing* how weak it is.
2. Moves sampled from a softmax over centipawn loss — a low rung drifts into
   mediocre moves constantly, rather than alternating between perfect and insane.
3. Real blunders drawn from a loss band and weighted by how **tempting** a move
   looks to a human: captures weighted by what they take, checks, promotions,
   moves that attack something bigger, advances toward the king; discounted for
   landing on a square a pawn covers. A beginner grabs a defended pawn and misses
   a fork; a beginner does not shuffle a rook into a corner. That filter is the
   whole quality bar.

### The dial is measured, not asserted

The first attempt at this ladder was badly wrong — a nominal 150-point step
measured 512 Elo. It was replaced by measurement: a temperature sweep against the
1320 anchor, then a weighted least-squares fit
(`Elo = 1476 − 160.5·√temperature − 6115·blunderRate`, residual RMS 83 Elo),
which showed **blunder rate dominates at roughly 61 Elo per percent** — as it
does for real players.

Re-measured after re-spacing, 1,080 games at 120 per match:

| labelled | measured | from                  |
| -------: | -------: | --------------------- |
|      250 |      313 | 9.2% vs rung 700      |
|      400 |      394 | 25.8% vs rung 550     |
|      550 |      577 | 31.7% vs rung 700     |
|      700 |      711 | 2.9% vs rung 1320     |
|      850 |      873 | 34.2% vs rung 1000    |
|     1000 |      987 | 37.1% vs rung 1150    |
|     1150 |     1079 | 20.0% vs rung 1320    |
|     1320 |     1320 | anchor                |

Every rung is within 71 Elo of its label, most within 30, against per-match
standard errors of 33–55.

Two honest caveats. Elo is not perfectly transitive over wide gaps: rung 250
reads 313 measured directly against 700 but 175 chained up through 400 and 550,
so read it as roughly 250 ± 70. And rungs 1500 and above are Stockfish's own
figures, not independently verified here.

Raw match data, the probe sweep and the fit are in [`calibration/`](calibration/).
Reproduce with `tools/calibrate.ts`, `tools/calibrate-report.ts`, `tools/fit-ladder.ts`.

---

## The accuracy formula

Documented because a number nobody can reproduce is decoration.

1. For each of your moves, take the win probability before and after, both from
   your point of view. Win probability comes from the evaluation via the standard
   logistic fit, `1 / (1 + e^(−cp/350))`.
2. The loss is the drop between them, floored at zero.
3. Each move's accuracy is `100 × e^(−4 × loss)`. An exact move scores 100;
   giving up 10 points of win probability scores about 67; giving up 40 scores
   about 20. The exponential matches how damage actually feels — the first slip
   hurts far more than the tenth.
4. The game's accuracy is the mean of those per-move figures.

Deliberately simpler than the volatility-weighted figures the big sites use. It
is reproducible and cannot be inflated by shuffling in a dead-drawn position.

Move classification works on the same win-probability loss rather than raw
centipawns, with thresholds scaled by rating: an inaccuracy for a 2000 is simply
how a 600 plays. "Brilliant" is reserved for a sound sacrifice, so the label
means something.

---

## Architecture

```
src/core/     rules. no DOM, no engine. chess.js wrapped so nothing else touches it
src/engine/   Stockfish in a Worker, promise API, the Elo ladder and move sampling
src/coach/    motif detector, danger warnings, classification, openings, review
src/app/      board, sound, game controller, persistence, UI
tools/        calibration harness, browser driver, smoke tests, icon and SW builders
tests/        Vitest
```

The rules layer has the final say on legality. The engine is never asked whether
a move is legal, and the UI never re-derives the rules.

## Verification

```
npm test                      # 166 unit tests
node tools/smoke-ui.mjs       # 36 checks in a real browser at iPhone size
node tools/smoke-offline.mjs  # 6 checks with the network genuinely cut
node tools/smoke-audio.mjs    # 13 checks measuring actual audio samples
```

The move generator is proved by a **perft** suite with hard-coded counts —
4,865,609 nodes at depth 5 from the start position, 4,085,603 for Kiwipete, plus
en-passant, promotion-with-check, castling-rights and quiet-middlegame positions.
Counts were cross-checked against Stockfish's own `go perft` and published tables;
provenance is recorded per position in `tests/perft.test.ts`, including the one
position that rests on Stockfish alone.

The browser tests drive a headless Chrome over the DevTools protocol with real
touch events (`tools/drive.mjs`, no dependencies).

## Offline

A service worker precaches every asset, including the 7 MB engine, from a list
generated from the actual build output so it cannot drift. `display: standalone`,
`apple-touch-icon`, safe-area insets, and `navigator.storage.persist()` requested
so saved games are not evicted. Settings live in `localStorage`, games in
IndexedDB.

Audited: the app bundle contains **zero** `fetch(` calls. The only two in the
build are the service worker's own same-origin fallback and the engine loading
its local `.wasm`. No remote URLs, no fonts, no analytics, no CDN.

## Licences

- **Stockfish / stockfish.js — GPLv3.** Fine for personal use. It matters only if
  this is ever distributed, in which case the GPL's obligations apply to the
  whole work. Flagged, not decided. Full text: `licenses/stockfish-GPLv3.txt`.
- **chess.js — BSD-2-Clause**, not MIT as originally specified. Permissive and
  attribution-only, so equivalent in practice. `licenses/chess.js-BSD-2-Clause.txt`.
- **Cburnett piece artwork — CC BY-SA 3.0.** Attribution plus share-alike, which
  is irrelevant to private use and relevant if published.
  `public/pieces/LICENCE.txt`.
- Sound is synthesised at runtime; no samples, so no audio licences.

## Not built yet

Explore mode (branch from any position, set up a FEN), puzzle mode from your own
blunders, board themes, PGN import/export in the interface, an opening trainer,
and a full accessibility pass. The variation tree and PGN reader/writer that
explore mode needs are already built and tested.
