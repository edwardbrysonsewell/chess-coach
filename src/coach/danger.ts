import { Position } from '../core/position.js';
import type { PieceSymbol, Square } from '../core/types.js';
import type { UciEngine } from '../engine/engine.js';
import { scoreToCp } from '../engine/uci.js';
import { threatsAfter, type Motif } from './motifs.js';
import { dangerSentence, materialFor } from './language.js';

/**
 * Danger warnings.
 *
 * Concretely: a shallow engine check of the position the move would create, an
 * evaluation delta against a threshold scaled to the player's level, and a motif
 * detector run on the resulting position to name what is actually threatened.
 *
 * The warning must name the threat. "Careful!" teaches nothing, and a warning
 * that cannot say why is not shown at all — silence is better than noise.
 */

export interface DangerWarning {
  /** How bad, once scaled to the player's level. */
  readonly severity: 'inaccuracy' | 'mistake' | 'blunder';
  /** Centipawns given up compared with the best move. */
  readonly lossCp: number;
  /** The sentence to show. Always names a move, a piece or a square. */
  readonly message: string;
  /** Squares worth highlighting on the board. */
  readonly highlight: readonly Square[];
  /** The opponent's punishing reply, in UCI, when there is one. */
  readonly threatMove?: string;
}

export interface DangerOptions {
  /** Player rating, used to scale the threshold. */
  readonly elo: number;
  /** Search budget for the check. Kept small: this runs before every move. */
  readonly nodes?: number;
}

/**
 * Warning thresholds in centipawns, by rating.
 *
 * A beginner who is warned about every 60-centipawn slip will turn warnings off
 * within a game, so the bar starts high and comes down as the player improves.
 * These are judgement calls, not measurements, and are deliberately in one place
 * so they can be tuned.
 */
export function thresholdFor(elo: number): number {
  if (elo <= 400) return 300; // only real disasters: a piece or worse
  if (elo <= 700) return 250;
  if (elo <= 1000) return 200;
  if (elo <= 1400) return 150;
  return 110;
}

/**
 * Check a candidate move. Returns null when the move is fine, when the position
 * is already lost enough that a warning is pointless, or when nothing specific
 * can be said about it.
 */
export async function assessMove(
  engine: UciEngine,
  position: Position,
  from: Square,
  to: Square,
  promotion: PieceSymbol | undefined,
  options: DangerOptions
): Promise<DangerWarning | null> {
  const mover = position.turn();
  const nodes = options.nodes ?? 80_000;

  const candidate = position.clone();
  const made = candidate.play({ from, to, ...(promotion ? { promotion } : {}) });
  if (!made) return null;

  // Best available, and what this move actually gives.
  const [beforeLines, afterLines] = await Promise.all([
    engine.evaluate(position.fen(), { multiPv: 1, nodes }),
    engine.evaluate(candidate.fen(), { multiPv: 1, nodes }),
  ]);
  const bestCp = beforeLines[0] ? scoreToCp(beforeLines[0].score) : null;
  const afterLine = afterLines[0];
  if (bestCp === null || !afterLine) return null;

  // The after-evaluation is from the opponent's point of view; flip it.
  const afterCp = -scoreToCp(afterLine.score);
  const lossCp = bestCp - afterCp;
  const threshold = thresholdFor(options.elo);
  if (lossCp < threshold) return null;

  // If the move the engine likes best is the one being played, there is nothing
  // to warn about even if the position is grim.
  const engineBest = beforeLines[0]?.moves[0];
  if (engineBest === made.uci) return null;

  const threatMove = afterLine.moves[0];
  let threatSan: string | null = null;
  if (threatMove) {
    const probe = new Position(candidate.fen());
    const reply = probe.play({
      from: threatMove.slice(0, 2),
      to: threatMove.slice(2, 4),
      ...(threatMove.length > 4 ? { promotion: threatMove[4] as PieceSymbol } : {}),
    });
    threatSan = reply?.san ?? null;
  }

  // What does the move actually allow? Look for a named pattern.
  const opponent = mover === 'w' ? 'b' : 'w';
  const motifs = threatsAfter(position, made.uci, opponent);
  const motif: Motif | null = motifs[0] ?? null;

  // Material swing, for the fallback wording.
  const materialBefore = materialFor(position, mover);
  const afterThreat = new Position(candidate.fen());
  if (threatMove) {
    afterThreat.play({
      from: threatMove.slice(0, 2),
      to: threatMove.slice(2, 4),
      ...(threatMove.length > 4 ? { promotion: threatMove[4] as PieceSymbol } : {}),
    });
  }
  const materialLoss = materialBefore - materialFor(afterThreat, mover);

  // Nothing specific to say and no material at stake: stay quiet rather than
  // producing an atmospheric warning.
  if (!motif && !threatSan && materialLoss <= 0) return null;

  const severity: DangerWarning['severity'] =
    lossCp >= threshold * 2.5 ? 'blunder' : lossCp >= threshold * 1.5 ? 'mistake' : 'inaccuracy';

  const highlight = new Set<Square>();
  if (motif) for (const square of motif.targets) highlight.add(square);
  if (threatMove) highlight.add(threatMove.slice(2, 4));

  return {
    severity,
    lossCp,
    message: dangerSentence(candidate, made.san, threatSan, motif, materialLoss),
    highlight: [...highlight],
    ...(threatMove ? { threatMove } : {}),
  };
}
