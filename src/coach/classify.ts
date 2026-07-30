import { winProbability } from '../engine/uci.js';
import type { Score } from '../engine/types.js';

/**
 * Move classification and the accuracy figure.
 *
 * Classification works on WIN PROBABILITY, not raw centipawns. Going from +0.2
 * to +0.6 barely matters; going from 0.0 to -0.4 is the game. A centipawn
 * threshold treats those the same, which is why raw-centipawn classifiers feel
 * wrong to players.
 *
 * The thresholds are scaled by rating: an inaccuracy for a 2000 is simply how a
 * 600 plays, and labelling every one of their moves a mistake teaches nothing.
 */

export type MoveQuality =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

export interface Judgement {
  readonly quality: MoveQuality;
  /** Win probability given up, 0 to 1. */
  readonly winProbabilityLoss: number;
  /** Centipawns given up against the best move. */
  readonly lossCp: number;
}

/**
 * Thresholds in win-probability loss. Above the blunder line the game has
 * materially changed hands; below the inaccuracy line it is noise.
 */
export function thresholdsFor(elo: number): {
  inaccuracy: number;
  mistake: number;
  blunder: number;
} {
  // A beginner's game swings constantly; only flag what they could act on.
  if (elo <= 600) return { inaccuracy: 0.16, mistake: 0.26, blunder: 0.4 };
  if (elo <= 1000) return { inaccuracy: 0.12, mistake: 0.2, blunder: 0.32 };
  if (elo <= 1600) return { inaccuracy: 0.1, mistake: 0.16, blunder: 0.26 };
  return { inaccuracy: 0.06, mistake: 0.12, blunder: 0.2 };
}

export interface ClassifyInput {
  /** Evaluation before the move, from the mover's point of view. */
  readonly before: Score;
  /** Evaluation after the move, already flipped to the mover's point of view. */
  readonly after: Score;
  /** Was this the engine's first choice? */
  readonly wasBestMove: boolean;
  /** Was it the only move that holds the position together? */
  readonly wasOnlyGoodMove?: boolean;
  /** Did it give up material that the engine nonetheless approves of? */
  readonly sacrificedMaterial?: boolean;
  readonly elo: number;
}

export function classifyMove(input: ClassifyInput): Judgement {
  const beforeWin = winProbability(input.before);
  const afterWin = winProbability(input.after);
  const loss = Math.max(0, beforeWin - afterWin);
  const lossCp = centipawnLoss(input.before, input.after);
  const limits = thresholdsFor(input.elo);

  // Brilliant is reserved for a good move that gives up material - otherwise
  // the label is meaningless and every strong move gets a firework.
  if (input.wasBestMove && input.sacrificedMaterial && loss <= 0.02) {
    return { quality: 'brilliant', winProbabilityLoss: loss, lossCp };
  }
  if (input.wasOnlyGoodMove && loss <= 0.03) {
    return { quality: 'great', winProbabilityLoss: loss, lossCp };
  }
  if (input.wasBestMove) return { quality: 'best', winProbabilityLoss: loss, lossCp };
  if (loss >= limits.blunder) return { quality: 'blunder', winProbabilityLoss: loss, lossCp };
  if (loss >= limits.mistake) return { quality: 'mistake', winProbabilityLoss: loss, lossCp };
  if (loss >= limits.inaccuracy) {
    return { quality: 'inaccuracy', winProbabilityLoss: loss, lossCp };
  }
  return { quality: 'good', winProbabilityLoss: loss, lossCp };
}

function centipawnLoss(before: Score, after: Score): number {
  const cp = (score: Score): number =>
    score.kind === 'cp' ? score.cp : score.moves > 0 ? 2000 : -2000;
  return Math.max(0, cp(before) - cp(after));
}

/**
 * Accuracy, 0 to 100.
 *
 * The formula, documented here and in the README so the number means something:
 *
 *   1. For each of your moves, take the win probability before and after, both
 *      from your point of view, and the loss between them.
 *   2. Convert each loss to a per-move accuracy with
 *          moveAccuracy = 100 * exp(-4 * loss)
 *      An exact move scores 100; giving up 10 points of win probability scores
 *      about 67; giving up 40 scores about 20. The exponential matches how
 *      players actually think about damage: the first slip hurts far more than
 *      the tenth.
 *   3. The game's accuracy is the mean of those per-move figures.
 *
 * This is deliberately simpler than the volatility-weighted figures the big
 * sites use. It is documented, reproducible, and cannot be gamed by shuffling
 * in a dead-drawn position.
 */
export function accuracyFromLosses(losses: readonly number[]): number {
  if (!losses.length) return 100;
  const perMove = losses.map((loss) => 100 * Math.exp(-4 * Math.max(0, loss)));
  const mean = perMove.reduce((a, b) => a + b, 0) / perMove.length;
  return Math.round(mean * 10) / 10;
}

/** Words for a quality label, in the encouraging-teacher voice. */
export function qualityLabel(quality: MoveQuality): string {
  return {
    brilliant: 'Brilliant',
    great: 'Great find',
    best: 'Best move',
    good: 'Good',
    inaccuracy: 'Inaccuracy',
    mistake: 'Mistake',
    blunder: 'Blunder',
  }[quality];
}

/** Colour for the label, shared by the move list and the review. */
export function qualityColour(quality: MoveQuality): string {
  return {
    brilliant: '#12b5a4',
    great: '#3d8bfd',
    best: '#4a9d5f',
    good: '#7a8794',
    inaccuracy: '#d99b2b',
    mistake: '#e07b39',
    blunder: '#d9453d',
  }[quality];
}
