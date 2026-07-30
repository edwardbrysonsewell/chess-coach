/** The rules layer. Nothing in here touches the DOM or the engine. */
export { Position } from './position.js';
export { perft, perftDivide, perftViaPublicApi } from './perft.js';
export { GameTree, type TreeNode } from './variation.js';
export { readPgn, writePgn, type PgnGame } from './pgn.js';
export type {
  Color,
  DrawReason,
  LegalMove,
  MoveInfo,
  MoveRequest,
  Outcome,
  Piece,
  PieceSymbol,
  Square,
} from './types.js';
