import { describe, expect, it } from 'vitest';
import { readPgn, writePgn } from '../src/core/pgn.js';
import { GameTree } from '../src/core/variation.js';
import { Position } from '../src/core/position.js';

const mainlineSans = (t: GameTree): string[] =>
  t.mainline().slice(1).map((n) => n.move?.san ?? '?');

describe('PGN — writing', () => {
  it('writes numbered move pairs and the result', () => {
    const t = new GameTree();
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) t.play(san);
    const pgn = writePgn(t, { White: 'Me', Black: 'Bot' }, '1-0');
    expect(pgn).toContain('[White "Me"]');
    expect(pgn).toContain('[Result "1-0"]');
    expect(pgn).toContain('1. e4 e5 2. Nf3 Nc6 1-0');
  });

  it('writes a variation in parentheses and renumbers after it', () => {
    const t = new GameTree();
    t.play('e4');
    t.play('e5');
    t.back();
    t.play('c5');
    t.goToStart();
    t.goToEnd();
    t.play('Nf3');
    const pgn = writePgn(t);
    expect(pgn).toContain('1. e4 e5 (1... c5) 2. Nf3');
  });

  it('emits SetUp and FEN tags for a non-standard start', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    const t = new GameTree(fen);
    t.play('e4');
    const pgn = writePgn(t);
    expect(pgn).toContain('[SetUp "1"]');
    expect(pgn).toContain(`[FEN "${fen}"]`);
    expect(pgn).toContain('1. e4');
  });

  it('writes comments in braces', () => {
    const t = new GameTree();
    const e4 = t.play('e4')!;
    e4.comment = 'best by test';
    expect(writePgn(t)).toContain('1. e4 {best by test}');
  });
});

describe('PGN — reading', () => {
  it('reads a plain game', () => {
    const { tree, result, headers } = readPgn(
      '[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n'
    );
    expect(headers['White']).toBe('A');
    expect(result).toBe('1-0');
    expect(mainlineSans(tree)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('reads a variation as a sibling, not as part of the mainline', () => {
    const { tree } = readPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3 Nc6 *');
    expect(mainlineSans(tree)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    const afterE4 = tree.root.children[0]!;
    expect(afterE4.children.map((c) => c.move?.san)).toEqual(['e5', 'c5']);
    const sicilian = afterE4.children[1]!;
    expect(sicilian.children.map((c) => c.move?.san)).toEqual(['Nf3']);
  });

  it('reads nested variations', () => {
    const { tree } = readPgn('1. e4 e5 (1... c5 2. Nf3 (2. Nc3) d6) 2. Nf3 *');
    const sicilian = tree.root.children[0]!.children[1]!;
    const afterC5 = sicilian.children;
    expect(afterC5.map((c) => c.move?.san)).toEqual(['Nf3', 'Nc3']);
    expect(afterC5[0]!.children.map((c) => c.move?.san)).toEqual(['d6']);
  });

  it('reads comments and attaches them to the move', () => {
    const { tree } = readPgn('1. e4 {a good start} e5 *');
    expect(tree.root.children[0]?.comment).toBe('a good start');
  });

  it('ignores NAGs and rest-of-line comments', () => {
    const { tree } = readPgn('1. e4 $1 e5 ; trailing\n2. Nf3 *');
    expect(mainlineSans(tree)).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('honours a SetUp FEN', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    const { tree } = readPgn(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. e4 *`);
    expect(tree.fenAtStart()).toBe(fen);
    expect(mainlineSans(tree)).toEqual(['e4']);
  });

  it('throws on an illegal move rather than silently dropping it', () => {
    expect(() => readPgn('1. e4 e5 2. Qh8 *')).toThrow(/illegal move "Qh8"/);
  });

  it('throws on unbalanced parentheses', () => {
    expect(() => readPgn('1. e4 e5 (1... c5 *')).toThrow(/unbalanced/);
  });
});

describe('PGN — round-trips', () => {
  it('round-trips a mainline game', () => {
    const t = new GameTree();
    for (const san of ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6']) t.play(san);
    const again = readPgn(writePgn(t, {}, '1/2-1/2'));
    expect(mainlineSans(again.tree)).toEqual(mainlineSans(t));
    expect(again.result).toBe('1/2-1/2');
  });

  it('round-trips a game with a variation', () => {
    const t = new GameTree();
    t.play('e4');
    t.play('e5');
    t.back();
    t.play('c5');
    t.play('Nf3');
    t.goToStart();
    t.goToEnd();
    t.play('Bc4');
    const pgn = writePgn(t);
    const again = readPgn(pgn).tree;
    expect(mainlineSans(again)).toEqual(mainlineSans(t));
    const alt = again.root.children[0]!.children[1]!;
    expect(alt.move?.san).toBe('c5');
    expect(alt.children[0]?.move?.san).toBe('Nf3');
  });

  it('round-trips a game that started from a FEN', () => {
    const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    const t = new GameTree(fen);
    for (const san of ['O-O', 'O-O']) t.play(san);
    const again = readPgn(writePgn(t)).tree;
    expect(again.fenAtStart()).toBe(fen);
    expect(mainlineSans(again)).toEqual(['O-O', 'O-O']);
  });

  it('round-trips through a real position after promotion and en passant', () => {
    const t = new GameTree('8/2P5/8/3pP3/8/8/8/K3k3 w - d6 0 1');
    t.play({ from: 'e5', to: 'd6' }); // en passant
    t.play({ from: 'e1', to: 'f1' });
    t.play({ from: 'c7', to: 'c8', promotion: 'q' });
    const pgn = writePgn(t);
    expect(pgn).toContain('exd6');
    expect(pgn).toContain('c8=Q');
    const again = readPgn(pgn).tree;
    again.goToEnd();
    expect(again.current().fen).toBe(t.mainline().at(-1)?.fen);
    expect(new Position(again.current().fen).pieceAt('c8')).toEqual({
      color: 'w',
      type: 'q',
    });
  });
});
