import { describe, expect, it } from 'vitest';
import { accuracyFromLosses, classifyMove, thresholdsFor } from '../src/coach/classify.js';
import { identifyOpening } from '../src/coach/openings.js';
import { Position } from '../src/core/position.js';
import { development, kingSafety, pawnStructure, positionalNote } from '../src/coach/positional.js';

describe('move classification', () => {
  const cp = (n: number) => ({ kind: 'cp' as const, cp: n });

  it('calls the engine\'s own choice the best move', () => {
    const j = classifyMove({ before: cp(30), after: cp(28), wasBestMove: true, elo: 1000 });
    expect(j.quality).toBe('best');
  });

  it('calls a large swing a blunder', () => {
    const j = classifyMove({ before: cp(50), after: cp(-600), wasBestMove: false, elo: 1000 });
    expect(j.quality).toBe('blunder');
  });

  it('is gentler on a beginner than on a strong player', () => {
    const swing = { before: cp(40), after: cp(-180), wasBestMove: false };
    const beginner = classifyMove({ ...swing, elo: 500 });
    const stronger = classifyMove({ ...swing, elo: 1800 });
    const order = ['good', 'inaccuracy', 'mistake', 'blunder'];
    expect(order.indexOf(beginner.quality)).toBeLessThanOrEqual(order.indexOf(stronger.quality));
  });

  it('reserves brilliant for a sound sacrifice', () => {
    const plain = classifyMove({ before: cp(40), after: cp(40), wasBestMove: true, elo: 1500 });
    const sac = classifyMove({ before: cp(40), after: cp(40), wasBestMove: true, elo: 1500, sacrificedMaterial: true });
    expect(plain.quality).toBe('best');
    expect(sac.quality).toBe('brilliant');
  });

  it('scales thresholds monotonically with rating', () => {
    expect(thresholdsFor(500).blunder).toBeGreaterThan(thresholdsFor(1800).blunder);
  });

  it('treats a swing near equality as worse than the same swing in a won game', () => {
    const nearEqual = classifyMove({ before: cp(0), after: cp(-250), wasBestMove: false, elo: 1200 });
    const alreadyWinning = classifyMove({ before: cp(900), after: cp(650), wasBestMove: false, elo: 1200 });
    expect(nearEqual.winProbabilityLoss).toBeGreaterThan(alreadyWinning.winProbabilityLoss);
  });
});

describe('accuracy', () => {
  it('gives a perfect game 100', () => {
    expect(accuracyFromLosses([0, 0, 0])).toBe(100);
  });

  it('falls as losses grow, and is bounded', () => {
    const clean = accuracyFromLosses([0.01, 0.02, 0.01]);
    const rough = accuracyFromLosses([0.3, 0.25, 0.4]);
    expect(clean).toBeGreaterThan(rough);
    expect(rough).toBeGreaterThan(0);
    expect(clean).toBeLessThanOrEqual(100);
  });

  it('returns 100 for a game with no moves rather than dividing by zero', () => {
    expect(accuracyFromLosses([])).toBe(100);
  });
});

describe('opening book', () => {
  it('names an opening and prefers the most specific match', () => {
    expect(identifyOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])?.entry.name).toBe('Ruy López');
    expect(identifyOpening(['e4', 'c5'])?.entry.name).toBe('Sicilian Defence');
    expect(identifyOpening(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'])?.entry.eco).toBe('E20');
  });

  it('carries a plan, not just a name', () => {
    const match = identifyOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(match?.entry.plan.length).toBeGreaterThan(20);
  });

  it('returns null for a position that is not in the book', () => {
    expect(identifyOpening(['a3', 'h6', 'a4'])).toBeNull();
  });
});

describe('positional facts', () => {
  it('counts doubled and isolated pawns', () => {
    const p = new Position('4k3/8/8/8/8/P7/P7/4K3 w - - 0 1');
    const s = pawnStructure(p, 'w');
    expect([...s.doubled].sort()).toEqual(['a2', 'a3']);
    expect([...s.isolated].sort()).toEqual(['a2', 'a3']);
  });

  it('finds a passed pawn', () => {
    const p = new Position('4k3/8/8/3P4/8/8/8/4K3 w - - 0 1');
    expect(pawnStructure(p, 'w').passed).toContain('d5');
  });

  it('does not call a blocked pawn passed', () => {
    const p = new Position('4k3/3p4/8/3P4/8/8/8/4K3 w - - 0 1');
    expect(pawnStructure(p, 'w').passed).not.toContain('d5');
  });

  it('counts development', () => {
    expect(development(new Position(), 'w').developed).toBe(0);
    const p = new Position();
    p.play('Nf3');
    p.play('Nf6');
    expect(development(p, 'w').developed).toBe(1);
  });

  it('reports king safety facts', () => {
    const start = kingSafety(new Position(), 'w');
    expect(start.shieldPawns).toBe(3);
    expect(start.inCentre).toBe(true);
    expect(start.castled).toBe(false);
  });

  it('says nothing at all when nothing mechanical stands out', () => {
    expect(positionalNote(new Position(), 'w')).toBeNull();
  });

  it('mentions an uncastled king only once it matters', () => {
    const p = new Position('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 6 10');
    const note = positionalNote(p, 'w');
    expect(note).toMatch(/castl/i);
  });
});
