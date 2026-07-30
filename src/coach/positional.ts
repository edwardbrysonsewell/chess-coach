import type { Position } from '../core/position.js';
import type { Color, Square } from '../core/types.js';
import { fileIndex, rankIndex } from './geometry.js';
import { findKing } from './motifs.js';

/**
 * Positional facts that can be CHECKED, not felt.
 *
 * Every function here returns something countable — a number of doubled pawns,
 * a count of developed pieces, squares of mobility. That constraint is the
 * point: the coach may only say what one of these can prove. Anything vaguer
 * ("improve your worst piece") is the kind of filler that makes a coach
 * ignorable, and is deliberately impossible to produce from this module.
 */

export interface PawnStructure {
  readonly doubled: readonly Square[];
  readonly isolated: readonly Square[];
  readonly backward: readonly Square[];
  readonly passed: readonly Square[];
}

export function pawnStructure(position: Position, color: Color): PawnStructure {
  const pawns = position
    .occupied()
    .filter((p) => p.piece.color === color && p.piece.type === 'p')
    .map((p) => p.square);
  const enemyPawns = position
    .occupied()
    .filter((p) => p.piece.color !== color && p.piece.type === 'p')
    .map((p) => p.square);

  const byFile = new Map<number, Square[]>();
  for (const square of pawns) {
    const file = fileIndex(square);
    byFile.set(file, [...(byFile.get(file) ?? []), square]);
  }

  const doubled: Square[] = [];
  const isolated: Square[] = [];
  const backward: Square[] = [];
  const passed: Square[] = [];

  for (const [file, squares] of byFile) {
    if (squares.length > 1) doubled.push(...squares);
    const hasNeighbour = byFile.has(file - 1) || byFile.has(file + 1);
    if (!hasNeighbour) isolated.push(...squares);
  }

  const forward = color === 'w' ? 1 : -1;
  for (const square of pawns) {
    const file = fileIndex(square);
    const rank = rankIndex(square);

    // Passed: no enemy pawn ahead on this file or either neighbour.
    const blocked = enemyPawns.some((enemy) => {
      const enemyFile = fileIndex(enemy);
      const enemyRank = rankIndex(enemy);
      if (Math.abs(enemyFile - file) > 1) return false;
      return forward === 1 ? enemyRank > rank : enemyRank < rank;
    });
    if (!blocked) passed.push(square);

    // Backward: no friendly pawn on a neighbouring file at or behind this rank.
    const supported = pawns.some((friend) => {
      if (friend === square) return false;
      const friendFile = fileIndex(friend);
      if (Math.abs(friendFile - file) !== 1) return false;
      const friendRank = rankIndex(friend);
      return forward === 1 ? friendRank <= rank : friendRank >= rank;
    });
    if (!supported && !isolated.includes(square)) backward.push(square);
  }

  return { doubled, isolated, backward, passed };
}

/** Minor and major pieces that have left their starting square. */
export function development(position: Position, color: Color): {
  developed: number;
  total: number;
  undeveloped: readonly Square[];
} {
  const homeRank = color === 'w' ? 0 : 7;
  const homeSquares: Square[] = ['b', 'c', 'f', 'g'].map(
    (file) => `${file}${homeRank + 1}`
  );
  const undeveloped: Square[] = [];
  for (const square of homeSquares) {
    const piece = position.pieceAt(square);
    if (piece && piece.color === color && (piece.type === 'n' || piece.type === 'b')) {
      undeveloped.push(square);
    }
  }
  return { developed: 4 - undeveloped.length, total: 4, undeveloped };
}

/**
 * King safety, counted rather than judged: how many of the three pawns in front
 * of the king are still home, and whether the king still sits in the centre.
 */
export function kingSafety(position: Position, color: Color): {
  shieldPawns: number;
  inCentre: boolean;
  castled: boolean;
  attackedSquaresNearKing: number;
} {
  const king = findKing(position, color);
  if (!king) return { shieldPawns: 0, inCentre: false, castled: false, attackedSquaresNearKing: 0 };
  const file = fileIndex(king);
  const rank = rankIndex(king);
  const forward = color === 'w' ? 1 : -1;
  const enemy: Color = color === 'w' ? 'b' : 'w';

  let shieldPawns = 0;
  for (const dx of [-1, 0, 1]) {
    const f = file + dx;
    const r = rank + forward;
    if (f < 0 || f > 7 || r < 0 || r > 7) continue;
    const square = `${'abcdefgh'[f] as string}${r + 1}`;
    const piece = position.pieceAt(square);
    if (piece?.color === color && piece.type === 'p') shieldPawns++;
  }

  let attackedSquaresNearKing = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const f = file + dx;
      const r = rank + dy;
      if (f < 0 || f > 7 || r < 0 || r > 7) continue;
      const square = `${'abcdefgh'[f] as string}${r + 1}`;
      if (position.isAttackedBy(square, enemy)) attackedSquaresNearKing++;
    }
  }

  const homeRank = color === 'w' ? 0 : 7;
  return {
    shieldPawns,
    inCentre: file >= 3 && file <= 4 && rank === homeRank,
    castled: (file <= 2 || file >= 6) && rank === homeRank,
    attackedSquaresNearKing,
  };
}

/** How many squares this side's pieces can move to — a plain activity count. */
export function mobility(position: Position, color: Color): number {
  if (position.turn() !== color) return -1; // only meaningful for the side to move
  return position.legalMoves().length;
}

/**
 * Space: how many squares on the opponent's half are occupied or attacked.
 * A crude but honest measure, and one a player can verify by looking.
 */
export function space(position: Position, color: Color): number {
  const enemyHalf = color === 'w' ? [4, 5, 6, 7] : [0, 1, 2, 3];
  let count = 0;
  for (let file = 0; file < 8; file++) {
    for (const rank of enemyHalf) {
      const square = `${'abcdefgh'[file] as string}${rank + 1}`;
      if (position.isAttackedBy(square, color)) count++;
    }
  }
  return count;
}

/**
 * The single most useful positional observation about a position, or null.
 *
 * Returns null far more often than not, and that is correct: if nothing
 * mechanical stands out, the coach says nothing rather than padding.
 */
export function positionalNote(position: Position, color: Color): string | null {
  const king = kingSafety(position, color);
  const dev = development(position, color);
  const pawns = pawnStructure(position, color);
  const moveNumber = position.moveNumber();

  if (moveNumber >= 8 && king.inCentre && dev.developed >= 2) {
    return 'Your king is still in the centre — castling would tuck it away and connect your rooks.';
  }
  if (moveNumber >= 10 && dev.undeveloped.length >= 2) {
    return `You still have pieces at home on ${dev.undeveloped.join(' and ')} — bringing them out is worth more than another pawn move.`;
  }
  if (king.castled && king.shieldPawns <= 1 && king.attackedSquaresNearKing >= 3) {
    return 'The pawns in front of your king have gone and several squares round it are covered by their pieces — be careful about opening more lines.';
  }
  if (pawns.passed.length > 0 && moveNumber >= 20) {
    return `Your pawn on ${pawns.passed[0] as string} is passed — nothing can stop it on its file, so pushing it is a real plan.`;
  }
  if (pawns.isolated.length >= 2) {
    return `Your pawns on ${pawns.isolated.slice(0, 2).join(' and ')} are isolated, so pieces have to defend them.`;
  }
  return null;
}
