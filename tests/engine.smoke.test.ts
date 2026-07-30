import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UciEngine } from '../src/engine/engine.js';
import { createNodeTransport } from '../src/engine/transport-node.js';
import { Bot } from '../src/engine/bot.js';
import { Position } from '../src/core/position.js';
import { makeRng } from '../src/engine/strength.js';

/**
 * Boots the real vendored wasm engine. Slower than the rest of the suite, and
 * the point is precisely that it is real: the worker boots, the handshake
 * completes, and every move it hands back is legal by the rules layer.
 */
describe('engine smoke test — the real Stockfish build', () => {
  let engine: UciEngine;

  beforeAll(async () => {
    engine = new UciEngine(await createNodeTransport('lite-single'));
  }, 180_000);

  afterAll(async () => {
    await engine?.quit().catch(() => undefined);
  });

  it('completes the UCI handshake and identifies itself', async () => {
    const info = await engine.init();
    expect(info.name).toMatch(/Stockfish/i);
  }, 180_000);

  it('returns a legal best move from the start position', async () => {
    const best = await engine.bestMove(Position.START_FEN, { depth: 8 });
    expect(best).not.toBeNull();
    const legal = new Position().legalMoves().map((m) => m.uci);
    expect(legal).toContain(best!.uci);
  }, 60_000);

  it('returns several distinct ranked lines under MultiPV', async () => {
    const lines = await engine.evaluate(Position.START_FEN, { multiPv: 5, depth: 8 });
    expect(lines.length).toBe(5);
    expect(lines.map((l) => l.rank)).toEqual([1, 2, 3, 4, 5]);
    const firstMoves = lines.map((l) => l.moves[0]);
    expect(new Set(firstMoves).size).toBe(5);
    // Rank 1 must not be worse than rank 5.
    const cp = (i: number): number => {
      const s = lines[i]!.score;
      return s.kind === 'cp' ? s.cp : 100000;
    };
    expect(cp(0)).toBeGreaterThanOrEqual(cp(4));
  }, 60_000);

  it('finds mate in one', async () => {
    // 1. e4 f6 2. d4 g5 — Qh5 mates.
    const p = new Position();
    for (const san of ['e4', 'f6', 'd4', 'g5']) p.play(san);
    const best = await engine.bestMove(p.fen(), { depth: 10 });
    expect(best?.uci).toBe('d1h5');
  }, 60_000);

  it('reports being mated rather than inventing a move', async () => {
    const mated = new Position('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
    expect(mated.outcome().over).toBe(true);
    expect(await engine.bestMove(mated.fen(), { depth: 4 })).toBeNull();
  }, 60_000);

  it('serialises overlapping searches instead of interleaving them', async () => {
    const [a, b, c] = await Promise.all([
      engine.bestMove(Position.START_FEN, { depth: 6 }),
      engine.evaluate(Position.START_FEN, { multiPv: 3, depth: 6 }),
      engine.bestMove('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 3', {
        depth: 6,
      }),
    ]);
    expect(a?.uci).toMatch(/^[a-h][1-8][a-h][1-8]/);
    expect(b).toHaveLength(3);
    expect(c?.uci).toMatch(/^[a-h][1-8][a-h][1-8]/);
  }, 120_000);

  it('a weak bot plays legal moves and does not always play the engine\'s pick', async () => {
    const bot = new Bot(engine, 400, makeRng(12345));
    const p = new Position();
    let differed = 0;
    for (let i = 0; i < 8 && !p.outcome().over; i++) {
      const move = await bot.move(p.fen());
      expect(move, `move ${i}`).not.toBeNull();
      if (move!.uci !== move!.engineBest) differed++;
      expect(move!.thinkMs).toBeGreaterThan(100);
      // Position.play is the authority; if the bot were illegal this returns null.
      expect(p.play({
        from: move!.uci.slice(0, 2),
        to: move!.uci.slice(2, 4),
        ...(move!.uci.length > 4 ? { promotion: move!.uci[4] as 'q' } : {}),
      }), `bot move ${move!.uci} must be legal`).not.toBeNull();
      // Reply with a plain legal move so the game moves on.
      const reply = p.legalMoves()[0];
      if (reply) p.play({ from: reply.from, to: reply.to, ...(reply.promotion ? { promotion: reply.promotion } : {}) });
    }
    expect(differed).toBeGreaterThan(0);
  }, 180_000);
});
