import { describe, expect, it } from 'vitest';
import { parseBestMove, parseInfoLine, scoreToCp, winProbability } from '../src/engine/uci.js';

describe('UCI parsing', () => {
  it('parses a full info line', () => {
    const line =
      'info depth 18 seldepth 24 multipv 2 score cp -37 nodes 412339 nps 830000 ' +
      'hashfull 120 tbhits 0 time 497 pv e7e5 g1f3 b8c6 f1b5';
    const pv = parseInfoLine(line);
    expect(pv).not.toBeNull();
    expect(pv).toMatchObject({
      depth: 18,
      rank: 2,
      score: { kind: 'cp', cp: -37 },
      nodes: 412339,
      nps: 830000,
      timeMs: 497,
    });
    expect(pv?.moves).toEqual(['e7e5', 'g1f3', 'b8c6', 'f1b5']);
  });

  it('parses a mate score', () => {
    const pv = parseInfoLine('info depth 12 score mate 3 pv d1h5 g8h6 h5f7');
    expect(pv?.score).toEqual({ kind: 'mate', moves: 3 });
  });

  it('parses a negative mate score', () => {
    const pv = parseInfoLine('info depth 9 score mate -2 pv e8f8 h5f7');
    expect(pv?.score).toEqual({ kind: 'mate', moves: -2 });
  });

  it('defaults multipv to 1 when absent', () => {
    expect(parseInfoLine('info depth 5 score cp 12 pv e2e4')?.rank).toBe(1);
  });

  it('ignores info lines without a principal variation', () => {
    expect(parseInfoLine('info depth 1 currmove e2e4 currmovenumber 1')).toBeNull();
    expect(parseInfoLine('info string NNUE evaluation using nn-9067e33176e8.nnue')).toBeNull();
    expect(parseInfoLine('bestmove e2e4')).toBeNull();
  });

  it('parses bestmove with and without a ponder move', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toEqual({
      uci: 'e2e4',
      ponder: 'e7e5',
    });
    expect(parseBestMove('bestmove g1f3')).toEqual({ uci: 'g1f3' });
    expect(parseBestMove('bestmove (none)')).toBeNull();
    expect(parseBestMove('info depth 3')).toBeNull();
  });
});

describe('score conversion', () => {
  it('keeps centipawns as they are', () => {
    expect(scoreToCp({ kind: 'cp', cp: -250 })).toBe(-250);
  });

  it('ranks a faster mate above a slower one, and any mate above material', () => {
    const mateIn1 = scoreToCp({ kind: 'mate', moves: 1 });
    const mateIn5 = scoreToCp({ kind: 'mate', moves: 5 });
    const hugeMaterial = scoreToCp({ kind: 'cp', cp: 2000 });
    expect(mateIn1).toBeGreaterThan(mateIn5);
    expect(mateIn5).toBeGreaterThan(hugeMaterial);
  });

  it('makes being mated worse than any material deficit', () => {
    expect(scoreToCp({ kind: 'mate', moves: -2 })).toBeLessThan(
      scoreToCp({ kind: 'cp', cp: -3000 })
    );
  });

  it('maps scores onto a win probability between 0 and 1', () => {
    expect(winProbability({ kind: 'cp', cp: 0 })).toBeCloseTo(0.5, 6);
    expect(winProbability({ kind: 'cp', cp: 350 })).toBeCloseTo(0.731, 2);
    expect(winProbability({ kind: 'mate', moves: 1 })).toBeGreaterThan(0.999);
    expect(winProbability({ kind: 'mate', moves: -1 })).toBeLessThan(0.001);
  });
});
