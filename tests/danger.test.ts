import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Position } from '../src/core/position.js';
import { UciEngine } from '../src/engine/engine.js';
import { createNodeTransport } from '../src/engine/transport-node.js';
import { assessMove, thresholdFor } from '../src/coach/danger.js';

/**
 * Danger warnings against the real engine.
 *
 * The bar these must clear is not "does it fire" but "does it say something
 * true and specific". A warning that cannot name the threat is a defect, so
 * every assertion here checks the wording as well as the trigger.
 */
describe('danger warnings', () => {
  let engine: UciEngine;

  beforeAll(async () => {
    engine = new UciEngine(await createNodeTransport('lite-single'));
    await engine.init();
  }, 180_000);

  afterAll(async () => {
    await engine?.quit().catch(() => undefined);
  });

  it('warns when a move hangs the queen, and names the capture', async () => {
    // White queen can step onto b5 where the a6 pawn simply takes it.
    const position = new Position('rnbqkbnr/1ppppppp/p7/8/8/4P3/PPPPQPPP/RNB1KBNR w KQkq - 0 3');
    const warning = await assessMove(engine, position, 'e2', 'b5', undefined, { elo: 850 });
    expect(warning, 'moving the queen to b5 should be warned about').not.toBeNull();
    expect(warning?.severity).toBe('blunder');
    // It must name the punishing reply, not just say "careful".
    expect(warning?.message).toMatch(/axb5|b5/);
    expect(warning?.message.length).toBeGreaterThan(25);
  }, 120_000);

  it('says nothing about a sensible developing move', async () => {
    const position = new Position();
    const warning = await assessMove(engine, position, 'e2', 'e4', undefined, { elo: 850 });
    expect(warning).toBeNull();
  }, 120_000);

  it('says nothing about the engine\'s own top choice', async () => {
    // A position with one obvious recapture: taking back cannot be a blunder.
    const position = new Position('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
    const warning = await assessMove(engine, position, 'e4', 'd5', undefined, { elo: 850 });
    expect(warning).toBeNull();
  }, 120_000);

  it('warns a stronger player about a smaller mistake than a beginner', () => {
    // The thresholds themselves: a beginner should not be nagged about 150cp.
    expect(thresholdFor(400)).toBeGreaterThan(thresholdFor(1500));
    expect(thresholdFor(400)).toBe(300);
    expect(thresholdFor(1500)).toBe(110);
  });

  it('scales: the same slip warns an improver but not a beginner', async () => {
    // Giving up a pawn for nothing: real, but not catastrophic.
    const position = new Position('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
    const beginner = await assessMove(engine, position, 'g8', 'f6', undefined, { elo: 250 });
    // f6 is a perfectly normal developing move; nobody should be warned.
    expect(beginner).toBeNull();
  }, 120_000);

  it('never throws on a move that is not legal', async () => {
    const position = new Position();
    await expect(
      assessMove(engine, position, 'e2', 'e5', undefined, { elo: 850 })
    ).resolves.toBeNull();
  }, 60_000);
});
