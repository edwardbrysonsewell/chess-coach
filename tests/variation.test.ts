import { describe, expect, it } from 'vitest';
import { GameTree } from '../src/core/variation.js';
import { Position } from '../src/core/position.js';

const sans = (tree: GameTree): string[] =>
  tree.mainline().slice(1).map((n) => n.move?.san ?? '?');

describe('GameTree — playing and navigating', () => {
  it('builds a mainline', () => {
    const t = new GameTree();
    for (const san of ['e4', 'e5', 'Nf3']) expect(t.play(san), san).not.toBeNull();
    expect(sans(t)).toEqual(['e4', 'e5', 'Nf3']);
    expect(t.current().move?.san).toBe('Nf3');
  });

  it('refuses an illegal move and leaves the cursor alone', () => {
    const t = new GameTree();
    t.play('e4');
    const where = t.current();
    expect(t.play('e5e6')).toBeNull();
    expect(t.current()).toBe(where);
    expect(t.size()).toBe(2);
  });

  it('branches into a variation without touching the mainline', () => {
    const t = new GameTree();
    t.play('e4');
    t.play('e5');
    t.back();
    const alt = t.play('c5'); // Sicilian as an alternative to 1...e5
    expect(alt).not.toBeNull();
    expect(sans(t)).toEqual(['e4', 'e5']); // mainline unchanged
    expect(t.isOnMainline(alt!)).toBe(false);
    expect(t.root.children[0]?.children.map((c) => c.move?.san)).toEqual(['e5', 'c5']);
  });

  it('promotes a variation to the mainline', () => {
    const t = new GameTree();
    t.play('e4');
    t.play('e5');
    t.back();
    const alt = t.play('c5')!;
    t.promoteToMainline(alt);
    expect(sans(t)).toEqual(['e4', 'c5']);
    expect(t.isOnMainline(alt)).toBe(true);
  });
});

describe('GameTree — take back and redo', () => {
  it('takes back my move and the reply as one action, and redoes them', () => {
    const t = new GameTree();
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) t.play(san);
    expect(t.takeBack(2)).toBe(2);
    expect(t.current().move?.san).toBe('e5');
    // Nothing was deleted, so the moves are still there to redo.
    expect(t.size()).toBe(5);
    expect(t.redo(2)).toBe(2);
    expect(t.current().move?.san).toBe('Nc6');
  });

  it('take back is unlimited and stops cleanly at the start', () => {
    const t = new GameTree();
    for (const san of ['e4', 'e5', 'Nf3']) t.play(san);
    expect(t.takeBack(10)).toBe(3);
    expect(t.current()).toBe(t.root);
    expect(t.takeBack(2)).toBe(0);
    expect(t.back()).toBe(false);
  });

  it('replaying the same move after a take back reuses the branch', () => {
    const t = new GameTree();
    t.play('e4');
    t.play('e5');
    t.takeBack(1);
    const again = t.play('e5');
    expect(t.size()).toBe(3); // root, e4, e5 — no duplicate
    expect(again).toBe(t.root.children[0]?.children[0]);
  });

  it('keeps positions consistent after take back', () => {
    const t = new GameTree();
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) t.play(san);
    t.takeBack(2);
    const pos = t.position();
    expect(pos.turn()).toBe('w');
    expect(pos.legalMoves('g1').some((m) => m.to === 'f3')).toBe(true);
  });
});

describe('GameTree — structure', () => {
  it('removes a branch and retreats the cursor out of it', () => {
    const t = new GameTree();
    t.play('e4');
    const e5 = t.play('e5')!;
    t.play('Nf3');
    t.remove(e5);
    expect(t.current().move?.san).toBe('e4');
    expect(t.size()).toBe(2);
  });

  it('will not remove the root', () => {
    const t = new GameTree();
    expect(() => t.remove(t.root)).toThrow(/root/);
  });

  it('truncates everything after the cursor', () => {
    const t = new GameTree();
    for (const san of ['e4', 'e5', 'Nf3']) t.play(san);
    t.takeBack(2);
    t.truncateHere();
    expect(sans(t)).toEqual(['e4']);
  });

  it('reports the path that reached a node', () => {
    const t = new GameTree();
    for (const san of ['e4', 'e5', 'Nf3']) t.play(san);
    expect(t.pathTo(t.current()).map((n) => n.move?.san ?? 'start')).toEqual([
      'start',
      'e4',
      'e5',
      'Nf3',
    ]);
  });

  it('starts from an arbitrary FEN', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    const t = new GameTree(fen);
    expect(t.fenAtStart()).toBe(fen);
    expect(t.play('e4')).not.toBeNull();
    expect(t.position().fen()).toContain('4P3');
  });

  it('rejects an invalid starting FEN', () => {
    expect(() => new GameTree('rubbish')).toThrow(/invalid FEN/);
  });

  it('goToEnd follows the mainline to its last move', () => {
    const t = new GameTree();
    for (const san of ['e4', 'e5', 'Nf3']) t.play(san);
    t.goToStart();
    expect(t.current()).toBe(t.root);
    t.goToEnd();
    expect(t.current().move?.san).toBe('Nf3');
  });

  it('the cursor position always matches a Position built from its FEN', () => {
    const t = new GameTree();
    for (const san of ['d4', 'd5', 'c4', 'e6']) t.play(san);
    const walked = new Position();
    for (const san of ['d4', 'd5', 'c4', 'e6']) walked.play(san);
    expect(t.current().fen).toBe(walked.fen());
  });
});
