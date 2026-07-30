import { describe, expect, it } from 'vitest';
import { Position } from '../src/core/position.js';

describe('Position — legality and special moves', () => {
  it('rejects an illegal move without throwing', () => {
    const p = new Position();
    expect(p.play({ from: 'e2', to: 'e5' })).toBeNull();
    expect(p.fen()).toBe(Position.START_FEN);
  });

  it('plays en passant and removes the captured pawn', () => {
    const p = new Position();
    for (const san of ['e4', 'a6', 'e5', 'd5']) expect(p.play(san)).not.toBeNull();
    const ep = p.play({ from: 'e5', to: 'd6' });
    expect(ep?.isEnPassant).toBe(true);
    expect(ep?.captured).toBe('p');
    expect(ep?.san).toBe('exd6');
    expect(p.pieceAt('d5')).toBeNull();
  });

  it('castles kingside and reports it as a castle', () => {
    const p = new Position('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    const castle = p.play({ from: 'e1', to: 'g1' });
    expect(castle?.isCastle).toBe(true);
    expect(castle?.san).toBe('O-O');
    expect(p.pieceAt('f1')).toEqual({ color: 'w', type: 'r' });
    expect(p.pieceAt('g1')).toEqual({ color: 'w', type: 'k' });
  });

  it('requires a promotion piece and honours underpromotion', () => {
    const p = new Position('8/P7/8/8/8/8/8/K6k w - - 0 1');
    const knight = p.play({ from: 'a7', to: 'a8', promotion: 'n' });
    expect(knight?.isPromotion).toBe(true);
    expect(knight?.san).toBe('a8=N');
    expect(p.pieceAt('a8')).toEqual({ color: 'w', type: 'n' });
  });

  it('flags a move that gives check and one that mates', () => {
    const p = new Position('rnbqkbnr/ppppp2p/5p2/6p1/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3');
    const mate = p.play({ from: 'd1', to: 'h5' });
    expect(mate?.san).toBe('Qh5#');
    expect(mate?.isCheck).toBe(true);
    expect(mate?.isCheckmate).toBe(true);
  });

  it('does not offer moves that leave the king in check (pins)', () => {
    // Black knight on d7 is pinned by the bishop on a4 along a4-b5-c6-d7-e8.
    const p = new Position('4k3/3n4/8/8/B7/8/8/4K3 b - - 0 1');
    expect(p.legalMoves('d7')).toHaveLength(0);
  });

  it('validates FEN input', () => {
    expect(Position.isValidFen(Position.START_FEN)).toBe(true);
    expect(Position.isValidFen('not a fen')).toBe(false);
    expect(() => new Position('not a fen')).toThrow(/invalid FEN/);
  });
});

describe('Position — game endings', () => {
  it('detects checkmate and names the winner', () => {
    // 1. e4 f6 2. d4 g5 3. Qh5# — the queen mates along h5-e8.
    const p = new Position();
    for (const san of ['e4', 'f6', 'd4', 'g5']) expect(p.play(san), san).not.toBeNull();
    expect(p.play('Qh5')?.san).toBe('Qh5#');
    expect(p.outcome()).toEqual({
      over: true,
      result: '1-0',
      reason: 'checkmate',
      winner: 'w',
    });
  });

  it('names black as the winner when black mates', () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4#
    const p = new Position();
    for (const san of ['f3', 'e5', 'g4']) expect(p.play(san), san).not.toBeNull();
    expect(p.play('Qh4')?.san).toBe('Qh4#');
    expect(p.outcome()).toEqual({
      over: true,
      result: '0-1',
      reason: 'checkmate',
      winner: 'b',
    });
  });

  it('detects stalemate', () => {
    const p = new Position('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(p.outcome()).toEqual({
      over: true,
      result: '1/2-1/2',
      reason: 'stalemate',
    });
  });

  it('detects insufficient material (bare kings)', () => {
    expect(new Position('4k3/8/8/8/8/8/8/4K3 w - - 0 1').outcome()).toEqual({
      over: true,
      result: '1/2-1/2',
      reason: 'insufficient-material',
    });
  });

  it('detects insufficient material (king and bishop)', () => {
    expect(new Position('4k3/8/8/8/8/8/8/3BK3 w - - 0 1').outcome()).toEqual({
      over: true,
      result: '1/2-1/2',
      reason: 'insufficient-material',
    });
  });

  it('detects threefold repetition', () => {
    const p = new Position();
    // Knights out and back twice: the start position occurs a third time.
    for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) {
      expect(p.play(san), san).not.toBeNull();
    }
    const out = p.outcome();
    expect(out.over).toBe(true);
    expect(out.over && out.reason).toBe('threefold-repetition');
  });

  it('detects the fifty-move rule from the halfmove clock', () => {
    // A rook each, so this is not also insufficient material.
    const p = new Position('4k2r/8/8/8/8/8/8/R3K3 w - - 99 60');
    expect(p.outcome().over).toBe(false);
    p.play({ from: 'e1', to: 'e2' }); // 100th half-move without capture or pawn move
    const out = p.outcome();
    expect(out.over).toBe(true);
    expect(out.over && out.reason).toBe('fifty-move-rule');
  });

  it('reports an ongoing game as not over', () => {
    expect(new Position().outcome()).toEqual({ over: false });
  });
});

describe('Position — notation round-trips', () => {
  it('agrees between SAN and UCI for every legal move in a busy position', () => {
    const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    for (const move of new Position(fen).legalMoves()) {
      const viaSan = new Position(fen);
      const viaUci = new Position(fen);
      const a = viaSan.play(move.san);
      const b = viaUci.play({
        from: move.from,
        to: move.to,
        ...(move.promotion ? { promotion: move.promotion } : {}),
      });
      expect(a, `SAN ${move.san} should be playable`).not.toBeNull();
      expect(b, `UCI ${move.uci} should be playable`).not.toBeNull();
      expect(viaSan.fen()).toBe(viaUci.fen());
      expect(a?.uci).toBe(move.uci);
      expect(b?.san).toBe(move.san);
    }
  });

  it('round-trips a FEN unchanged', () => {
    const fens = [
      Position.START_FEN,
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
      '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
      '4k3/8/8/8/8/8/8/4K2R w K - 12 34',
    ];
    for (const fen of fens) expect(new Position(fen).fen()).toBe(fen);
  });

  it('undo restores the previous position exactly', () => {
    const p = new Position();
    const before = p.fen();
    p.play('e4');
    const undone = p.undo();
    expect(undone?.san).toBe('e4');
    expect(p.fen()).toBe(before);
    expect(p.undo()).toBeNull();
  });

  it('history reports every move played, oldest first', () => {
    const p = new Position();
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) p.play(san);
    expect(p.history().map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });
});
