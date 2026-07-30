import { Position } from '../core/position.js';
import type { Color, PieceSymbol, Square } from '../core/types.js';
import { DIAGONAL, KNIGHT_STEPS, ORTHOGONAL, fileIndex, rankIndex, ray, toSquare } from './geometry.js';

/**
 * Static tactical motif detection.
 *
 * This is what lets a warning say "Nf5 forks your queen and rook" instead of
 * "careful!". The engine can say a move is bad; only this can say WHY in terms a
 * person recognises.
 *
 * Everything here is static analysis of a position — no search. It is used two
 * ways: to describe what a candidate move would allow, and to name the pattern
 * behind an evaluation swing the engine already found.
 */

export type MotifKind =
  | 'hanging'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'back-rank'
  | 'trapped'
  | 'discovered-attack';

export interface Motif {
  readonly kind: MotifKind;
  /** The side that benefits from this motif. */
  readonly by: Color;
  /** Square of the piece creating the motif, where one exists. */
  readonly attacker?: Square;
  /** The pieces under threat. */
  readonly targets: readonly Square[];
  /** Material at stake, in pawns. Used to rank motifs by importance. */
  readonly value: number;
  /** The move that would execute it, in UCI, when this describes a threat. */
  readonly move?: string;
}

export const PIECE_VALUE: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export function pieceName(piece: PieceSymbol): string {
  return { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[piece];
}

const other = (color: Color): Color => (color === 'w' ? 'b' : 'w');

/**
 * Everything `by` currently threatens in this position, best first.
 *
 * "Currently" means without moving: pieces already hanging, pins and skewers
 * already in place, a back rank already weak. Threats that require a move are
 * found by `threatsAfter`.
 */
export function findMotifs(position: Position, by: Color): Motif[] {
  const motifs: Motif[] = [
    ...hangingPieces(position, by),
    ...pinsAndSkewers(position, by),
    ...backRankWeakness(position, by),
    ...trappedPieces(position, by),
  ];
  return motifs.sort((a, b) => b.value - a.value);
}

/**
 * What `by` would threaten after playing `uci`. This is the one that answers
 * "if I play this, what does it let them do?" — run it for the opponent on the
 * position your candidate move would create.
 */
export function threatsAfter(position: Position, uci: string, by: Color): Motif[] {
  const after = position.clone();
  const made = after.play({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci[4] as PieceSymbol } : {}),
  });
  if (!made) return [];
  const motifs = findMotifs(after, by);
  const forks = forksAvailable(after, by);
  return [...motifs, ...forks].sort((a, b) => b.value - a.value);
}

/**
 * Enemy pieces that `by` attacks and that are not adequately defended.
 *
 * Uses a simple exchange test rather than a full static exchange evaluation: if
 * the cheapest attacker is worth less than the target, or the target is
 * undefended, it is hanging. That is exactly the level of tactics a club player
 * misses, and full SEE would add complexity without changing the verdict often.
 */
export function hangingPieces(position: Position, by: Color): Motif[] {
  const victim = other(by);
  const out: Motif[] = [];
  for (const { square, piece } of position.occupied()) {
    if (piece.color !== victim || piece.type === 'k') continue;
    const attackers = position.attackersOf(square, by);
    if (!attackers.length) continue;
    const defenders = position.attackersOf(square, victim);
    const targetValue = PIECE_VALUE[piece.type];
    const cheapestAttacker = Math.min(
      ...attackers.map((sq) => PIECE_VALUE[position.pieceAt(sq)?.type ?? 'p'])
    );

    const undefended = defenders.length === 0;
    const winsMaterial = cheapestAttacker < targetValue;
    if (!undefended && !winsMaterial) continue;
    // Gain is the whole piece if undefended, otherwise the difference.
    const value = undefended ? targetValue : targetValue - cheapestAttacker;
    if (value <= 0) continue;
    out.push({
      kind: 'hanging',
      by,
      targets: [square],
      value,
      attacker: attackers[0] as Square,
    });
  }
  return out;
}

/**
 * Moves available to `by` that attack two or more valuable targets at once.
 *
 * A fork only counts when the arithmetic actually favours the forker: the
 * targets must be worth more than the forking piece, or be undefended, or be the
 * king. Otherwise every knight move that happens to touch two pawns would be
 * reported as a tactic, and the warnings would become noise.
 */
export function forksAvailable(position: Position, by: Color): Motif[] {
  if (position.turn() !== by) {
    // Forks are about what the side to move can do; if it is not their turn,
    // ask about the position they would reach after a null move by borrowing
    // the opponent's turn is unsound, so report nothing rather than guess.
    return [];
  }
  const out: Motif[] = [];
  const enemy = other(by);
  for (const move of position.legalMoves()) {
    const after = position.clone();
    const made = after.play({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
    if (!made) continue;
    const moverType = after.pieceAt(move.to)?.type;
    if (!moverType) continue;
    const moverValue = PIECE_VALUE[moverType];

    // If the forking piece can simply be taken for free, it is not a fork.
    const recapture = after.attackersOf(move.to, enemy);
    const defended = after.attackersOf(move.to, by).length > 0;
    if (recapture.length > 0 && !defended) continue;

    const targets: Square[] = [];
    let worth = 0;
    for (const { square, piece } of after.occupied()) {
      if (piece.color !== enemy) continue;
      if (!after.attackersOf(square, by).includes(move.to)) continue;
      const value = PIECE_VALUE[piece.type];
      const undefended = after.attackersOf(square, enemy).length === 0;
      if (piece.type === 'k') {
        targets.push(square);
        continue;
      }
      if (value > moverValue || undefended) {
        targets.push(square);
        worth = Math.max(worth, value);
      }
    }
    if (targets.length >= 2) {
      out.push({ kind: 'fork', by, attacker: move.to, targets, value: worth, move: move.uci });
    }
  }
  // Keep only the best fork per attacking square, so one knight does not produce
  // six near-identical warnings.
  const best = new Map<string, Motif>();
  for (const motif of out) {
    const key = motif.attacker as string;
    const existing = best.get(key);
    if (!existing || motif.value > existing.value) best.set(key, motif);
  }
  return [...best.values()];
}

/**
 * Pins and skewers: two enemy pieces on one line from a line-moving piece of
 * `by`, with nothing in between.
 *
 * Pin  — the nearer piece is worth less than the one behind it (it cannot move
 *        without exposing the better piece; absolute when the rear piece is the king).
 * Skewer — the nearer piece is worth more, so it must move and the one behind falls.
 */
export function pinsAndSkewers(position: Position, by: Color): Motif[] {
  const enemy = other(by);
  const out: Motif[] = [];

  for (const { square, piece } of position.occupied()) {
    if (piece.color !== by) continue;
    const directions =
      piece.type === 'r'
        ? ORTHOGONAL
        : piece.type === 'b'
          ? DIAGONAL
          : piece.type === 'q'
            ? [...ORTHOGONAL, ...DIAGONAL]
            : null;
    if (!directions) continue;

    for (const [dx, dy] of directions) {
      const line = ray(square, dx, dy);
      const occupiedOnLine: Array<{ square: Square; type: PieceSymbol; color: Color }> = [];
      for (const sq of line) {
        const found = position.pieceAt(sq);
        if (!found) continue;
        occupiedOnLine.push({ square: sq, type: found.type, color: found.color });
        if (occupiedOnLine.length === 2) break;
      }
      if (occupiedOnLine.length < 2) continue;
      const [near, far] = occupiedOnLine as [
        { square: Square; type: PieceSymbol; color: Color },
        { square: Square; type: PieceSymbol; color: Color },
      ];
      if (near.color !== enemy || far.color !== enemy) continue;

      const nearValue = PIECE_VALUE[near.type];
      const farValue = far.type === 'k' ? 100 : PIECE_VALUE[far.type];
      if (farValue > nearValue) {
        out.push({
          kind: 'pin',
          by,
          attacker: square,
          targets: [near.square, far.square],
          value: nearValue,
        });
      } else if (nearValue > farValue && near.type !== 'k') {
        out.push({
          kind: 'skewer',
          by,
          attacker: square,
          targets: [near.square, far.square],
          value: farValue,
        });
      } else if (near.type === 'k') {
        // King in front, something behind: taking the king is not a thing, but
        // this is a skewer in the usual sense once check is given.
        out.push({
          kind: 'skewer',
          by,
          attacker: square,
          targets: [near.square, far.square],
          value: farValue,
        });
      }
    }
  }
  return out;
}

/**
 * Is the enemy king shut in on its back rank with no escape squares, while `by`
 * has a rook or queen that could reach that rank?
 */
export function backRankWeakness(position: Position, by: Color): Motif[] {
  const enemy = other(by);
  const kingSquare = findKing(position, enemy);
  if (!kingSquare) return [];
  const backRank = enemy === 'w' ? 0 : 7;
  if (rankIndex(kingSquare) !== backRank) return [];

  // Escape squares are the three in front of the king (and the two beside it).
  const forward = enemy === 'w' ? 1 : -1;
  let escapes = 0;
  for (const dx of [-1, 0, 1]) {
    const square = toSquare(fileIndex(kingSquare) + dx, backRank + forward);
    if (!square) continue;
    const occupant = position.pieceAt(square);
    if (occupant?.color === enemy) continue; // blocked by their own piece
    if (position.isAttackedBy(square, by)) continue; // covered by us
    escapes++;
  }
  if (escapes > 0) return [];

  /*
   * A boxed-in king is only a back-rank weakness if we can actually get there.
   * Without this check the detector fires on move one of every game — the
   * starting position has a king on its back rank with no escape squares — and
   * announces mate threats that are nonsense. A confidently wrong coach is worse
   * than a quiet one.
   *
   * So: find a rook or queen with a clear path to a square on that back rank
   * which the enemy does not defend.
   */
  const heavy = position
    .occupied()
    .filter((p) => p.piece.color === by && (p.piece.type === 'r' || p.piece.type === 'q'));

  for (const { square, piece } of heavy) {
    const directions = piece.type === 'r' ? ORTHOGONAL : [...ORTHOGONAL, ...DIAGONAL];
    for (const [dx, dy] of directions) {
      for (const step of ray(square, dx, dy)) {
        const occupant = position.pieceAt(step);
        if (occupant) break; // path blocked; cannot see past it
        if (rankIndex(step) !== backRank) continue;
        // An entry square on the back rank. Is it safe to land on?
        if (position.isAttackedBy(step, enemy)) continue;
        return [{ kind: 'back-rank', by, targets: [kingSquare], value: 5, attacker: square }];
      }
    }
  }
  return [];
}

/**
 * Enemy pieces that are attacked and have nowhere safe to go. Restricted to
 * pieces worth more than a pawn, since a trapped pawn is rarely the point.
 */
export function trappedPieces(position: Position, by: Color): Motif[] {
  const enemy = other(by);
  if (position.turn() !== enemy) return [];
  const out: Motif[] = [];

  for (const { square, piece } of position.occupied()) {
    if (piece.color !== enemy || piece.type === 'k' || piece.type === 'p') continue;
    if (!position.attackersOf(square, by).length) continue;

    const escapes = position.legalMoves(square).filter((move) => {
      const after = position.clone();
      const made = after.play({
        from: move.from,
        to: move.to,
        ...(move.promotion ? { promotion: move.promotion } : {}),
      });
      if (!made) return false;
      const attackers = after.attackersOf(move.to, by);
      if (!attackers.length) return true;
      const defenders = after.attackersOf(move.to, enemy);
      const cheapest = Math.min(
        ...attackers.map((sq) => PIECE_VALUE[after.pieceAt(sq)?.type ?? 'p'])
      );
      return defenders.length > 0 && cheapest >= PIECE_VALUE[piece.type];
    });

    if (escapes.length === 0) {
      out.push({ kind: 'trapped', by, targets: [square], value: PIECE_VALUE[piece.type] });
    }
  }
  return out;
}

/** Knight-move squares from a square, for describing knight forks. */
export function knightTargets(from: Square): Square[] {
  const out: Square[] = [];
  for (const [dx, dy] of KNIGHT_STEPS) {
    const square = toSquare(fileIndex(from) + dx, rankIndex(from) + dy);
    if (square) out.push(square);
  }
  return out;
}

export function findKing(position: Position, color: Color): Square | null {
  for (const { square, piece } of position.occupied()) {
    if (piece.type === 'k' && piece.color === color) return square;
  }
  return null;
}
