import { describe, expect, it } from 'vitest';
import { perft, perftViaPublicApi } from '../src/core/perft.js';

/**
 * The correctness gate. Every count below is hard-coded, and every count has a
 * stated provenance — nothing here is from memory.
 *
 * Two independent confirmations were used:
 *
 *  (a) STOCKFISH — the vendored Stockfish 18 build's own `go perft` command,
 *      run by tools/perft-stockfish.cjs. Every number below was reproduced by
 *      it on 2026-07-29.
 *  (b) PUBLISHED — a citable table, noted per position.
 *
 * Where a number carries only (a), it says so. That is a weaker claim and is
 * recorded as such rather than dressed up.
 */

interface PerftCase {
  readonly id: string;
  readonly fen: string;
  readonly covers: string;
  readonly provenance: string;
  /** depth -> expected leaf nodes */
  readonly nodes: ReadonlyArray<readonly [depth: number, expected: number]>;
}

const CASES: readonly PerftCase[] = [
  {
    id: 'position 1 — initial position',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    covers: 'baseline legality, double pawn pushes',
    provenance: 'Bryson-supplied; reproduced by Stockfish go perft',
    nodes: [
      [1, 20],
      [2, 400],
      [3, 8_902],
      [4, 197_281],
      [5, 4_865_609],
    ],
  },
  {
    id: 'position 2 — Kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    covers: 'castling both sides, pins, discovered checks',
    provenance: 'Bryson-supplied; reproduced by Stockfish go perft',
    nodes: [
      [1, 48],
      [2, 2_039],
      [3, 97_862],
      [4, 4_085_603],
    ],
  },
  {
    id: 'position 3 — en passant and checks',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    covers: 'en passant legality while the capturing pawn is pinned, checks',
    provenance:
      'python-chess examples/perft/tricky.perft (14/191/2812/43238); depth 5 from Stockfish go perft',
    nodes: [
      [1, 14],
      [2, 191],
      [3, 2_812],
      [4, 43_238],
      [5, 674_624],
    ],
  },
  {
    id: 'position 4 — promotion with check',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    covers: 'promotions for both colours, promotion giving check, underpromotion',
    provenance:
      'Stockfish go perft only — no published table was reachable this session (chessprogramming.org returned 503), so this one rests on the engine alone',
    nodes: [
      [1, 6],
      [2, 264],
      [3, 9_467],
      [4, 422_333],
    ],
  },
  {
    id: 'position 5 — castling rights and promotion',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    covers: 'castling-rights bookkeeping, promotion, king safety',
    provenance:
      'peterellisjones perft gist, depth 3 = 62,379; all depths from Stockfish go perft',
    nodes: [
      [1, 44],
      [2, 1_486],
      [3, 62_379],
      [4, 2_103_487],
    ],
  },
  {
    id: 'position 6 — quiet middlegame',
    fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    covers: 'broad coverage in a normal position',
    provenance:
      'python-chess tricky.perft and peterellisjones gist (46/2079/89890); depth 4 from Stockfish go perft',
    nodes: [
      [1, 46],
      [2, 2_079],
      [3, 89_890],
      [4, 3_894_594],
    ],
  },
];

describe('perft — move generation correctness gate', () => {
  for (const c of CASES) {
    describe(c.id, () => {
      for (const [depth, expected] of c.nodes) {
        // Deep counts are millions of nodes; chess.js manages roughly 800k
        // nodes/sec, so give each one room rather than a flaky default.
        it(`depth ${depth} = ${expected.toLocaleString()}`, () => {
          expect(perft(c.fen, depth)).toBe(expected);
        }, 120_000);
      }
    });
  }
});

describe('perft — the app\'s own move/undo path agrees', () => {
  // The gate above uses chess.js's internal perft. This proves the slower path
  // the UI actually drives (verbose move list, move, undo) counts identically,
  // so the gate is not certifying a different code path from the one that plays.
  for (const c of CASES) {
    it(`${c.id} — depth 3 via public API`, () => {
      const expected = c.nodes.find(([d]) => d === 3)?.[1];
      expect(expected, 'every case has a depth-3 count').toBeTypeOf('number');
      expect(perftViaPublicApi(c.fen, 3)).toBe(expected);
    }, 120_000);
  }
});
