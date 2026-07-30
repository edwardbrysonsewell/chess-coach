import type { Position } from '../core/position.js';
import type { Square } from '../core/types.js';
import { PIECE_VALUE, pieceName, type Motif } from './motifs.js';
import { listSquares } from './geometry.js';

/**
 * Turning detector output into English.
 *
 * Tone, decided by Bryson on 2026-07-30: encouraging teacher. That means warm
 * framing around a hard fact — never warmth *instead* of a fact. "Careful — Nf5
 * would fork your queen and rook" is the job; "keep it up!" is a defect.
 *
 * The iron rule here: every sentence names a square, a piece or a move. If the
 * detectors found nothing solid, the right output is nothing at all, and the
 * caller says less rather than padding.
 */

/**
 * Describe a motif in one clause, e.g. "fork your queen and rook".
 *
 * `owner` is whose pieces are under threat: "your" when warning the player about
 * what the opponent could do, "their" when explaining a move the player could
 * make. Getting this backwards produces sentences that are grammatical and
 * completely wrong, which is worse than saying nothing.
 */
export function describeMotif(
  position: Position,
  motif: Motif,
  owner: 'your' | 'their' = 'your'
): string | null {
  const nameAt = (square: Square): string => {
    const piece = position.pieceAt(square);
    return piece ? pieceName(piece.type) : 'piece';
  };

  switch (motif.kind) {
    case 'fork': {
      // "your queen and rook", not "your queen and your rook".
      const names = [...new Set(motif.targets.map((square) => nameAt(square)))];
      return `fork ${owner} ${listSquares(names)}`;
    }
    case 'hanging': {
      const square = motif.targets[0];
      if (!square) return null;
      return `win ${owner} ${nameAt(square)} on ${square}`;
    }
    case 'pin': {
      const [front, back] = motif.targets;
      if (!front || !back) return null;
      return `pin ${owner} ${nameAt(front)} on ${front} against ${owner} ${nameAt(back)}`;
    }
    case 'skewer': {
      const [front, back] = motif.targets;
      if (!front || !back) return null;
      return `skewer ${owner} ${nameAt(front)}, winning the ${nameAt(back)} behind it`;
    }
    case 'back-rank':
      return owner === 'your'
        ? 'threaten mate on your back rank'
        : 'threaten mate on their back rank';
    case 'trapped': {
      const square = motif.targets[0];
      if (!square) return null;
      return `trap ${owner} ${nameAt(square)} on ${square}`;
    }
    case 'discovered-attack':
      return 'open a discovered attack';
    default:
      return null;
  }
}

/**
 * The danger-warning sentence. `threatMoveSan` is the opponent's reply in
 * standard notation, which is what makes the warning checkable rather than
 * atmospheric.
 */
export function dangerSentence(
  position: Position,
  moveSan: string,
  threatMoveSan: string | null,
  motif: Motif | null,
  materialLoss: number
): string {
  const opening = 'Careful —';

  // Mate is not "a threat worth mentioning", it is the end of the game.
  if (threatMoveSan?.endsWith('#')) {
    const where = motif?.kind === 'back-rank' ? ' on the back rank' : '';
    return `${opening} after ${moveSan}, ${threatMoveSan.replace('#', '')} is checkmate${where}.`;
  }

  if (motif && threatMoveSan) {
    const clause = describeMotif(position, motif);
    if (clause) return `${opening} after ${moveSan}, ${threatMoveSan} would ${clause}.`;
  }
  if (motif) {
    const clause = describeMotif(position, motif);
    if (clause) return `${opening} ${moveSan} lets them ${clause}.`;
  }
  if (threatMoveSan && materialLoss >= 2) {
    return (
      `${opening} after ${moveSan}, they play ${threatMoveSan} and you come out ` +
      `about ${describeMaterial(materialLoss)} down.`
    );
  }
  if (threatMoveSan) {
    return `${opening} ${moveSan} runs into ${threatMoveSan}, which turns the position against you.`;
  }
  return `${opening} ${moveSan} gives up more than it needs to.`;
}

/** Material in pawns, in words a person uses. */
export function describeMaterial(pawns: number): string {
  const rounded = Math.round(pawns);
  if (rounded >= 9) return 'a queen';
  if (rounded >= 5) return 'a rook';
  if (rounded >= 3) return 'a piece';
  if (rounded === 2) return 'two pawns';
  return 'a pawn';
}

/**
 * Why the engine likes a move. Deliberately modest: if nothing concrete can be
 * said, say what it does on the board rather than inventing a plan.
 */
export function hintSentence(
  position: Position,
  moveSan: string,
  motifs: readonly Motif[],
  isCapture: boolean,
  isCheck: boolean
): string {
  const best = motifs[0];
  if (best) {
    const clause = describeMotif(position, best, 'their');
    if (clause) return `${moveSan} looks strongest — it would ${clause}.`;
  }
  if (isCheck) return `${moveSan} is the engine's choice: it gives check and keeps the initiative.`;
  if (isCapture) return `${moveSan} is the engine's choice — it wins material or trades favourably.`;
  return `${moveSan} is the engine's choice here. It improves your position without giving anything away.`;
}

/** Total material on the board for a side, in pawns. */
export function materialFor(position: Position, color: 'w' | 'b'): number {
  let total = 0;
  for (const { piece } of position.occupied()) {
    if (piece.color === color) total += PIECE_VALUE[piece.type];
  }
  return total;
}
