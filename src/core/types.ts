/** Shared vocabulary for the rules layer. No DOM, no engine, no app concerns. */

export type Color = 'w' | 'b';
export type PieceSymbol = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/** Algebraic square name, 'a1' through 'h8'. */
export type Square = string;

export interface Piece {
  readonly color: Color;
  readonly type: PieceSymbol;
}

/** A move that has been played, with everything the app and coach need. */
export interface MoveInfo {
  readonly from: Square;
  readonly to: Square;
  /** Promotion piece, present only on promotions. */
  readonly promotion?: PieceSymbol;
  readonly piece: PieceSymbol;
  /** Type of the captured piece, including the pawn taken en passant. */
  readonly captured?: PieceSymbol;
  readonly san: string;
  /** Engine-facing form, e.g. 'e2e4', 'e7e8q'. */
  readonly uci: string;
  readonly color: Color;
  readonly isCapture: boolean;
  readonly isEnPassant: boolean;
  readonly isCastle: boolean;
  readonly isPromotion: boolean;
  /** True if this move leaves the opponent in check. */
  readonly isCheck: boolean;
  readonly isCheckmate: boolean;
  /** Position before and after the move. */
  readonly before: string;
  readonly after: string;
}

/** A legal move offered to the UI, before it is played. */
export interface LegalMove {
  readonly from: Square;
  readonly to: Square;
  readonly promotion?: PieceSymbol;
  readonly san: string;
  readonly uci: string;
  readonly isCapture: boolean;
  readonly isCastle: boolean;
  readonly isPromotion: boolean;
}

export type DrawReason =
  | 'stalemate'
  | 'insufficient-material'
  | 'threefold-repetition'
  | 'fifty-move-rule';

export type Outcome =
  | { readonly over: false }
  | { readonly over: true; readonly result: '1-0' | '0-1'; readonly reason: 'checkmate'; readonly winner: Color }
  | { readonly over: true; readonly result: '1/2-1/2'; readonly reason: DrawReason };

/** Long-algebraic move description accepted by `Position.play`. */
export interface MoveRequest {
  readonly from: Square;
  readonly to: Square;
  readonly promotion?: PieceSymbol;
}
