import { Chess, validateFen } from 'chess.js';
import type { Move as ChessJsMove } from 'chess.js';
import type {
  Color,
  LegalMove,
  MoveInfo,
  MoveRequest,
  Outcome,
  Piece,
  PieceSymbol,
  Square,
} from './types.js';

/**
 * The single source of truth for chess rules in this app.
 *
 * chess.js does the move generation (proved against Stockfish's own perft in
 * tests/perft.test.ts); this class is the only thing allowed to touch it, so
 * the engine layer and the UI can never disagree with the rules or duplicate
 * them. Nothing here knows about the DOM.
 */
export class Position {
  private readonly game: Chess;

  constructor(fen?: string) {
    if (fen !== undefined) {
      const check = validateFen(fen);
      if (!check.ok) throw new Error(`invalid FEN: ${check.error}`);
    }
    this.game = new Chess(fen);
  }

  static readonly START_FEN =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  /** Is this a legal, parseable position? Cheap enough for a FEN input box. */
  static isValidFen(fen: string): boolean {
    return validateFen(fen).ok;
  }

  fen(): string {
    return this.game.fen();
  }

  turn(): Color {
    return this.game.turn();
  }

  /** Full move number, as it would appear in a scoresheet. */
  moveNumber(): number {
    return this.game.moveNumber();
  }

  pieceAt(square: Square): Piece | null {
    const p = this.game.get(square as never);
    return p ? { color: p.color as Color, type: p.type as PieceSymbol } : null;
  }

  /** Every legal move, or only those leaving `from`, for the UI's target dots. */
  legalMoves(from?: Square): LegalMove[] {
    const raw = (
      from === undefined
        ? this.game.moves({ verbose: true })
        : this.game.moves({ square: from as never, verbose: true })
    ) as ChessJsMove[];
    return raw.map(toLegalMove);
  }

  /** True if the requested move is legal in this position. */
  isLegal(req: MoveRequest): boolean {
    return this.legalMoves(req.from).some(
      (m) => m.to === req.to && (req.promotion === undefined || m.promotion === req.promotion)
    );
  }

  /**
   * Play a move. Returns the move that was made, or null if it was illegal —
   * illegal moves never throw, because the UI asks about them constantly.
   */
  play(move: MoveRequest | string): MoveInfo | null {
    let made: ChessJsMove;
    try {
      made = this.game.move(
        typeof move === 'string'
          ? move
          : { from: move.from, to: move.to, promotion: move.promotion }
      );
    } catch {
      return null; // chess.js throws on illegal input; that is not exceptional here.
    }
    // `isCheck` on the resulting position describes the side that just moved
    // into giving check, which is what MoveInfo wants.
    return toMoveInfo(made, this.game.isCheck(), this.game.isCheckmate());
  }

  /** Take one move off, returning it, or null at the start of the game. */
  undo(): MoveInfo | null {
    const undone = this.game.undo();
    if (!undone) return null;
    // Check flags describe the position the move created, which we have just
    // left, so recompute them from the move's own resulting FEN.
    const after = new Chess(undone.after);
    return toMoveInfo(undone, after.isCheck(), after.isCheckmate());
  }

  isCheck(): boolean {
    return this.game.isCheck();
  }

  /**
   * Game state. Checkmate and stalemate first, then the three draw rules;
   * threefold and fifty-move are reported even though a real arbiter would
   * need them claimed, because a solo app should just call the game.
   */
  outcome(): Outcome {
    if (this.game.isCheckmate()) {
      const winner: Color = this.game.turn() === 'w' ? 'b' : 'w';
      return {
        over: true,
        result: winner === 'w' ? '1-0' : '0-1',
        reason: 'checkmate',
        winner,
      };
    }
    if (this.game.isStalemate())
      return { over: true, result: '1/2-1/2', reason: 'stalemate' };
    if (this.game.isInsufficientMaterial())
      return { over: true, result: '1/2-1/2', reason: 'insufficient-material' };
    if (this.game.isThreefoldRepetition())
      return { over: true, result: '1/2-1/2', reason: 'threefold-repetition' };
    if (this.game.isDrawByFiftyMoves())
      return { over: true, result: '1/2-1/2', reason: 'fifty-move-rule' };
    return { over: false };
  }

  /** Moves played so far, oldest first. */
  history(): MoveInfo[] {
    const moves = this.game.history({ verbose: true }) as ChessJsMove[];
    return moves.map((m) => {
      const after = new Chess(m.after);
      return toMoveInfo(m, after.isCheck(), after.isCheckmate());
    });
  }

  /** Zobrist-style hash of the position, for repetition and cache keys. */
  hash(): string {
    return this.game.hash();
  }

  clone(): Position {
    const copy = new Position();
    copy.load(this.fen());
    return copy;
  }

  /** Replace the position wholesale, discarding history. */
  load(fen: string): void {
    const check = validateFen(fen);
    if (!check.ok) throw new Error(`invalid FEN: ${check.error}`);
    this.game.load(fen);
  }

  /** Text board, for debugging and test failure messages. */
  ascii(): string {
    return this.game.ascii();
  }
}

function toLegalMove(m: ChessJsMove): LegalMove {
  return {
    from: m.from,
    to: m.to,
    ...(m.promotion ? { promotion: m.promotion as PieceSymbol } : {}),
    san: m.san,
    uci: m.lan,
    isCapture: m.isCapture(),
    isCastle: m.isKingsideCastle() || m.isQueensideCastle(),
    isPromotion: m.isPromotion(),
  };
}

function toMoveInfo(m: ChessJsMove, isCheck: boolean, isCheckmate: boolean): MoveInfo {
  return {
    from: m.from,
    to: m.to,
    ...(m.promotion ? { promotion: m.promotion as PieceSymbol } : {}),
    piece: m.piece as PieceSymbol,
    ...(m.captured ? { captured: m.captured as PieceSymbol } : {}),
    san: m.san,
    uci: m.lan,
    color: m.color as Color,
    isCapture: m.isCapture(),
    isEnPassant: m.isEnPassant(),
    isCastle: m.isKingsideCastle() || m.isQueensideCastle(),
    isPromotion: m.isPromotion(),
    isCheck,
    isCheckmate,
    before: m.before,
    after: m.after,
  };
}
