import { Chess } from 'chess.js';

/**
 * Count leaf nodes of the move tree to `depth`. This is the correctness gate:
 * a move generator with a subtle bug in castling, en passant, promotion or pin
 * handling will not reproduce the published counts.
 *
 * Uses chess.js's own `perft`, which walks the same internal move generator the
 * app plays through but skips SAN generation. The public-API walk below agrees
 * with it and is ~40x slower, which is why it is only used as a cross-check.
 */
export function perft(fen: string, depth: number): number {
  if (depth < 0) throw new Error('depth must be >= 0');
  if (depth === 0) return 1;
  return new Chess(fen).perft(depth);
}

/**
 * The same count, but taken through exactly the calls the app makes when a
 * human plays a move: verbose move list, `move`, `undo`. Slow, because every
 * generated move carries a SAN string. Its purpose is to prove that the code
 * path the UI drives agrees with the fast internal one, so the gate above is
 * not measuring a different engine from the one that plays the game.
 */
export function perftViaPublicApi(fen: string, depth: number): number {
  if (depth < 0) throw new Error('depth must be >= 0');
  const game = new Chess(fen);
  const walk = (d: number): number => {
    if (d === 0) return 1;
    const moves = game.moves({ verbose: true });
    if (d === 1) return moves.length;
    let nodes = 0;
    for (const m of moves) {
      game.move(m);
      nodes += walk(d - 1);
      game.undo();
    }
    return nodes;
  };
  return walk(depth);
}

/**
 * Per-move breakdown of the first ply, matching Stockfish's `go perft` output.
 * Used when a total disagrees and the offending branch has to be found.
 */
export function perftDivide(fen: string, depth: number): Map<string, number> {
  const game = new Chess(fen);
  const out = new Map<string, number>();
  if (depth < 1) return out;
  for (const m of game.moves({ verbose: true })) {
    game.move(m);
    out.set(m.lan, depth === 1 ? 1 : game.perft(depth - 1));
    game.undo();
  }
  return out;
}
