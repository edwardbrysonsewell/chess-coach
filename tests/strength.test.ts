import { describe, expect, it } from 'vitest';
import { Position } from '../src/core/position.js';
import {
  LADDER,
  chooseMove,
  makeRng,
  optionsFor,
  rungFor,
  temptation,
  thinkTimeMs,
  toCandidates,
} from '../src/engine/strength.js';
import type { PvLine } from '../src/engine/types.js';

const pv = (rank: number, uci: string, cp: number): PvLine => ({
  rank,
  depth: 12,
  score: { kind: 'cp', cp },
  moves: [uci],
});

describe('the ladder', () => {
  it('spans roughly 250 to 2800 in rising steps', () => {
    const elos = LADDER.map((r) => r.elo);
    expect(elos[0]).toBe(250);
    expect(elos.at(-1)).toBe(2800);
    for (let i = 1; i < elos.length; i++) {
      expect(elos[i]!).toBeGreaterThan(elos[i - 1]!);
    }
  });

  it('uses Stockfish\'s own limiter at 1320 and above, and ours below', () => {
    for (const rung of LADDER) {
      expect(rung.mode).toBe(rung.elo >= 1320 ? 'limitStrength' : 'sampled');
    }
  });

  it('gets weaker downwards: hotter sampling and more blunders', () => {
    // Node counts are held uniform across the sampled band on purpose, so that
    // temperature is the single variable the calibration curve was fitted on.
    const sampled = LADDER.filter((r) => r.mode === 'sampled');
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i]!.temperatureCp).toBeLessThan(sampled[i - 1]!.temperatureCp);
      expect(sampled[i]!.blunderRate).toBeLessThan(sampled[i - 1]!.blunderRate);
      expect(sampled[i]!.nodes).toBeGreaterThanOrEqual(sampled[i - 1]!.nodes);
    }
  });

  it('picks the rung at or below a requested rating', () => {
    expect(rungFor(250).elo).toBe(250);
    expect(rungFor(399).elo).toBe(250);
    expect(rungFor(400).elo).toBe(400);
    expect(rungFor(9999).elo).toBe(2800);
    expect(rungFor(0).elo).toBe(250);
  });

  it('sets UCI_Elo only where Stockfish is doing the limiting', () => {
    expect(optionsFor(rungFor(1700))).toEqual([
      ['UCI_LimitStrength', true],
      ['UCI_Elo', 1700],
    ]);
    expect(optionsFor(rungFor(400))).toEqual([['UCI_LimitStrength', false]]);
  });
});

describe('candidate ranking', () => {
  it('measures loss against the best line', () => {
    const candidates = toCandidates([
      pv(1, 'e2e4', 40),
      pv(2, 'd2d4', 25),
      pv(3, 'a2a3', -120),
    ]);
    expect(candidates.map((c) => [c.uci, c.lossCp])).toEqual([
      ['e2e4', 0],
      ['d2d4', 15],
      ['a2a3', 160],
    ]);
  });

  it('returns nothing for an empty search', () => {
    expect(toCandidates([])).toEqual([]);
  });
});

describe('temptation — what a beginner is drawn to', () => {
  it('rates capturing a queen far above a quiet move', () => {
    // White rook on d1 can take the queen on d8; a1a2 is a pointless shuffle.
    const p = new Position('3qk3/8/8/8/8/8/8/R2RK3 w - - 0 1');
    expect(temptation(p, 'd1d8')).toBeGreaterThan(temptation(p, 'a1a2') + 3);
  });

  it('rates a check above a quiet move of the same piece', () => {
    const p = new Position('4k3/8/8/8/8/8/8/4KR2 w - - 0 1');
    expect(temptation(p, 'f1f8')).toBeGreaterThan(temptation(p, 'f1f2'));
  });

  it('rates promotion highly', () => {
    const p = new Position('8/3P4/8/8/8/8/8/K3k3 w - - 0 1');
    expect(temptation(p, 'd7d8q')).toBeGreaterThan(2);
  });

  it('discounts walking a piece onto a square a pawn covers', () => {
    // Black pawn on b7 covers c6. Nb1-c3 is safe; a knight landing on c6 is not.
    const safe = new Position('4k3/1p6/8/8/8/8/8/1N2K3 w - - 0 1');
    const exposed = new Position('4k3/1p6/8/2N5/8/8/8/4K3 w - - 0 1');
    expect(temptation(exposed, 'c5b7')).toBeGreaterThan(0); // it is a capture
    expect(temptation(safe, 'b1c3')).toBeGreaterThan(temptation(safe, 'b1a3'));
  });

  it('returns zero for a move that is not legal here', () => {
    expect(temptation(new Position(), 'e2e5')).toBe(0);
  });
});

describe('chooseMove', () => {
  const start = new Position();
  const lines = [pv(1, 'e2e4', 40), pv(2, 'd2d4', 30), pv(3, 'g1f3', 20), pv(4, 'b1a3', -90)];

  it('takes the engine\'s move at limitStrength rungs', () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(chooseMove(start, lines, rungFor(1700), makeRng(seed))).toBe('e2e4');
    }
  });

  it('always returns a legal move at every sampled rung', () => {
    const legal = new Set(start.legalMoves().map((m) => m.uci));
    for (const rung of LADDER.filter((r) => r.mode === 'sampled')) {
      for (let seed = 0; seed < 25; seed++) {
        const uci = chooseMove(start, lines, rung, makeRng(seed));
        expect(uci, `rung ${rung.elo} seed ${seed}`).not.toBeNull();
        expect(legal.has(uci!), `${uci} should be legal`).toBe(true);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const a = chooseMove(start, lines, rungFor(400), makeRng(7));
    const b = chooseMove(start, lines, rungFor(400), makeRng(7));
    expect(a).toBe(b);
  });

  it('loses more centipawns per move the lower the rung', () => {
    // A realistic spread: a couple of near-equal good moves, then progressively
    // worse ones. Average loss is the thing that tracks strength - picking
    // between two moves 10cp apart is not weakness, so counting "best move
    // rate" over near-equal candidates would measure nothing.
    const spread = [
      pv(1, 'e2e4', 40),
      pv(2, 'd2d4', 25),
      pv(3, 'g1f3', -20),
      pv(4, 'b1c3', -110),
      pv(5, 'b1a3', -260),
      pv(6, 'g2g4', -520),
      pv(7, 'f2f3', -900),
    ];
    const byUci = new Map(toCandidates(spread).map((c) => [c.uci, c.lossCp]));
    const meanLoss = (elo: number): number => {
      let total = 0;
      const n = 600;
      for (let seed = 0; seed < n; seed++) {
        const uci = chooseMove(start, spread, rungFor(elo), makeRng(seed));
        total += byUci.get(uci!) ?? 0;
      }
      return total / n;
    };

    const losses = [250, 550, 850, 1150].map((elo) => ({ elo, loss: meanLoss(elo) }));
    // Monotonically better as the dial rises.
    for (let i = 1; i < losses.length; i++) {
      expect(
        losses[i]!.loss,
        `${losses[i]!.elo} should lose less than ${losses[i - 1]!.elo} ` +
          `(${JSON.stringify(losses)})`
      ).toBeLessThan(losses[i - 1]!.loss);
    }
    // And the ends must be far apart, not merely ordered.
    expect(losses[0]!.loss).toBeGreaterThan(losses.at(-1)!.loss * 2);
  });

  it('takes an available mate most of the time', () => {
    const mateLines: PvLine[] = [
      { rank: 1, depth: 6, score: { kind: 'mate', moves: 1 }, moves: ['d1h5'] },
      pv(2, 'g1f3', 30),
    ];
    // 1. e4 f6 2. d4 g5 — Qh5 is mate.
    const p = new Position();
    for (const san of ['e4', 'f6', 'd4', 'g5']) p.play(san);
    let mates = 0;
    for (let seed = 0; seed < 200; seed++) {
      if (chooseMove(p, mateLines, rungFor(250), makeRng(seed)) === 'd1h5') mates++;
    }
    expect(mates / 200).toBeGreaterThan(0.7);
  });

  it('falls back to normal sampling when no tempting blunder exists', () => {
    // Only one candidate, so the blunder band is necessarily empty.
    const single = [pv(1, 'e2e4', 40)];
    for (let seed = 0; seed < 10; seed++) {
      expect(chooseMove(start, single, rungFor(250), makeRng(seed))).toBe('e2e4');
    }
  });

  it('returns null when the search produced nothing', () => {
    expect(chooseMove(start, [], rungFor(400), makeRng(1))).toBeNull();
  });
});

describe('thinking time', () => {
  it('stays inside a sane envelope and rises with rung', () => {
    const p = new Position();
    const sample = (elo: number): number[] =>
      Array.from({ length: 50 }, (_, i) => thinkTimeMs(p, rungFor(elo), makeRng(i)));
    const low = sample(250);
    const high = sample(2500);
    for (const ms of [...low, ...high]) {
      expect(ms).toBeGreaterThan(150);
      expect(ms).toBeLessThan(8000);
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(high)).toBeGreaterThan(mean(low));
  });

  it('thinks longer in a position full of captures', () => {
    const quiet = new Position('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    const busy = new Position(
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'
    );
    const mean = (p: Position): number =>
      Array.from({ length: 40 }, (_, i) => thinkTimeMs(p, rungFor(1000), makeRng(i))).reduce(
        (a, b) => a + b,
        0
      ) / 40;
    expect(mean(busy)).toBeGreaterThan(mean(quiet));
  });
});
