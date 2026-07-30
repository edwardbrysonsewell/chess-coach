# chess-coach — plan

An offline-first chess PWA for one iPhone, played against a Stockfish bot with a
real Elo dial, danger warnings, an explore mode, and an offline coach. No App
Store, no network at runtime.

Status: Phase 1 (spikes + skeleton). Written 2026-07-29.

---

## Spike results

### Spike 1 — haptics on iOS web: **NOT VIABLE for this app. Dropped.**

Two mechanisms exist and both fail the requirement:

- `navigator.vibrate` — WebKit has never shipped it. The polyfill
  `samdenty/ios-vibrator-pro-max` worked without user interaction only on iOS
  18–18.3; from iOS 18.4 Apple required a real click, and the grant expires
  after 1 second.
- `<input type="checkbox" switch>` — introduced in Safari 17.4, fires the Taptic
  Engine when the **user taps the control**. The programmatic trick
  (`label.click()` on a hidden switch, the `tijnjh/ios-haptics` technique) is
  documented to work on **iOS 17.4–26.4 only; Apple patched it in iOS 26.5**.

Even on an unpatched iOS the surviving path needs a direct tap on the control,
so it could at best buzz on my own tap — never on the bot's reply, a check, or
a checkmate, which is exactly what the feedback vocabulary needs. Decision:
**audio and motion are the feedback system**, designed as the real thing rather
than a consolation. No `navigator.vibrate` call will ship. A probe page
(`public/spike/haptics.html`) is included so the negative result can be
confirmed on the actual phone in one minute; if Test C (delayed fire) somehow
buzzes, haptics come back as a garnish behind a Settings toggle, nothing more.

### Spike 2 — Stockfish WASM on mobile: **VIABLE.**

Vendored `stockfish@18.0.8` (nmrugg / Chess.com build of Stockfish 18),
**lite single-threaded**: `stockfish-18-lite-single.js` (21 KB) +
`.wasm` (7.0 MB, NNUE net `nn-9067e33176e8.nnue` 11 MiB embedded — no separate
net download, so nothing to fetch at runtime). Total memory capped at 32 MB by
the build, which is what makes it safe on mobile Safari. No `SharedArrayBuffer`,
so no COOP/COEP headers and any static host works.

Integration is a plain Worker; the build reads its wasm path from the URL hash
and installs its own `onmessage`:

```js
new Worker('/engine/stockfish-18-lite-single.js#/engine/stockfish-18-lite-single.wasm')
```

Measured (this Mac, single-threaded, depth 16):

| where | startpos | kiwipete | sustained (movetime 3000) | boot |
|---|---|---|---|---|
| Node 24 | 868k nps | 986k nps | — | — |
| Chrome tab | 213k nps | 227k nps | 155k nps | 660 ms |

**The iPhone number is not yet measured** — that needs HTTPS hosting, and it is
the one open blocker. `public/spike/nps.html` measures it on the device in one
tap. Strength cost of "lite" vs the full net: the full build is 108 MB and would
be hopeless on mobile; lite is still far above human strength, and every rung of
the ladder below ~2500 is produced by *handicapping* rather than by the engine's
ceiling, so the cost is irrelevant except at the very top rung.

---

## Architecture

```
src/core/     pure rules, no DOM: position, legal moves, SAN/UCI, FEN/PGN,
              draw detection, variation tree.   Vendors chess.js for movegen.
src/engine/   Worker wrapper: bestMove(), evaluate() with MultiPV, promise-based.
src/app/      board rendering (SVG), interaction, sound, coach, persistence, UI.
public/engine/  vendored Stockfish (committed, never fetched from a CDN).
tools/        headless benches and the Elo calibration harness (Node).
tests/        Vitest: perft, notation round-trips, draws, variation tree, coach.
```

Rules live in `core` only. The engine is never asked whether a move is legal,
and the UI never re-derives rules.

## The correctness gate (Phase 2)

chess.js 1.4.0 vendored, then **proved** with a perft suite: start position to
depth 5 (20 / 400 / 8,902 / 197,281 / 4,865,609), Kiwipete to depth 4
(48 / 2,039 / 97,862 / 4,085,603), plus three further standard positions
covering en-passant edge cases and promotion-with-check. Numbers get looked up
against a citable source before use; any I cannot verify, I say so and use one I
can. If chess.js fails a count, that gets reported before anything is built on
top of it.

## Bot strength

Rungs: 250, 400, 550, 700, 850, 1000, 1150, then 1320, 1500, 1700, 1900, 2100,
2300, 2500, 2800.

At **1320 and above**: Stockfish's own `UCI_LimitStrength` + `UCI_Elo`, used
faithfully, with a per-rung node cap for pacing.

**Below 1320** the handicap is ours, and the design goal is *human beginner*,
not *random*:

1. Ask the engine for `MultiPV` 10 at a small fixed node budget.
2. Score each candidate by centipawn loss against the best move, and sample with
   a softmax whose temperature rises as rating falls.
3. Add a rating-dependent blunder rate — but draw blunders only from moves a
   beginner would actually be *attracted* to: captures, checks, forward pawn
   pushes, moves that attack something, moves that grab material while ignoring
   a threat. Aimless rook shuffles and undefended-square nonsense are explicitly
   excluded. That filter is the difference between a 400-rated human and a
   randomiser, and it is the quality bar for this whole section.
4. Per-rung thinking-time profile with jitter, longer when the position has more
   captures and checks available, so the bot does not answer instantly.

**Calibration is a deliverable.** `tools/calibrate.mjs` (Node, no browser) plays
each rung against fixed reference settings over a few hundred fast games,
converts score to an Elo difference, anchors on the trusted 1320 rung, and
prints measured win rates per rung. Mislabelled rungs get renamed to what they
measured. Numbers go in the README and in the checkpoint report.

## Feedback vocabulary (audio + motion, since haptics are out)

Synthesised at runtime with WebAudio — short, dry, wooden, no sample files and
nothing stock: piece lift, piece placed, capture (two-beat), check (double
pulse), illegal move, promotion (rising), checkmate (composed pattern), draw,
danger-warning cue. Respects the silent switch by routing through an element
that iOS treats as non-ambient audio. Master toggle plus intensity, and
`prefers-reduced-motion` honoured for the visual half.

## Offline / PWA

Service worker precaching every asset including the 7 MB engine; manifest with
`display: standalone`; `apple-touch-icon`; `viewport-fit=cover` with safe-area
insets; `navigator.storage.persist()` requested. Settings in `localStorage`,
games and puzzle progress in IndexedDB. Final audit greps the built output for
`fetch(` and `http` and runs a DevTools offline pass, both pasted.

## Licences

- Stockfish / stockfish.js — **GPLv3**. Fine for personal use; it matters only
  if this is ever distributed. Flagging once, not deciding it.
- chess.js — **BSD-2-Clause**, not MIT as specified. Permissive and
  attribution-only, so functionally equivalent here, but it is a deviation from
  the brief and yours to accept.
- Piece art — Cburnett (CC BY-SA 3.0) planned, vendored, credited in README.

## Phases

1. Spikes + skeleton. ← **here**
2. Rules core, perft gate green.
3. Engine worker, Elo mapping, calibration numbers.
4. Playable board, feedback, take back, persistence, installed and offline on
   the phone.
5. Suggestions, danger warnings, explore mode.
6. Coach mode and post-game review.
7. Polish, accessibility, offline audit, README.

Each phase ends with evidence pasted and a stop.

## PARKED — judgment calls for Bryson

1. ~~Hosting~~ — **settled 2026-07-29**: no preference between GitHub and
   Cloudflare, so GitHub Pages, because `gh` was already authenticated and
   Cloudflare needed an interactive login. Public repo
   `edwardbrysonsewell/chess-coach`, live at
   <https://edwardbrysonsewell.github.io/chess-coach/>, deployed by GitHub
   Actions on every push to `main`.
2. chess.js is BSD-2-Clause, not MIT.
3. Post-game accuracy formula: Lichess-style win-probability model vs a simpler
   ACPL curve. Whichever we pick gets documented in the README.
4. Coach tone: terse analyst or encouraging teacher.
5. Piece set licence: Cburnett is CC BY-SA 3.0, which carries a share-alike
   condition — irrelevant for personal use, relevant if ever published.
