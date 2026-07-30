import type { Square } from '../core/types.js';

/** Board geometry helpers. Pure arithmetic on square names, no rules knowledge. */

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

export function fileIndex(square: Square): number {
  return square.charCodeAt(0) - 97;
}

export function rankIndex(square: Square): number {
  return Number(square[1]) - 1;
}

export function toSquare(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${FILES[file] as string}${rank + 1}`;
}

/** Rook directions, then bishop directions. */
export const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
export const DIAGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
export const KNIGHT_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

/** Squares along a direction from `from`, exclusive of `from`, until the edge. */
export function ray(from: Square, dx: number, dy: number): Square[] {
  const out: Square[] = [];
  let file = fileIndex(from) + dx;
  let rank = rankIndex(from) + dy;
  for (;;) {
    const square = toSquare(file, rank);
    if (!square) return out;
    out.push(square);
    file += dx;
    rank += dy;
  }
}

/** Chebyshev distance — how many king moves apart two squares are. */
export function kingDistance(a: Square, b: Square): number {
  return Math.max(
    Math.abs(fileIndex(a) - fileIndex(b)),
    Math.abs(rankIndex(a) - rankIndex(b))
  );
}

/** Human-readable square list: "e4, d5 and f6". */
export function listSquares(squares: readonly string[]): string {
  if (squares.length <= 1) return squares[0] ?? '';
  return `${squares.slice(0, -1).join(', ')} and ${squares[squares.length - 1] as string}`;
}
