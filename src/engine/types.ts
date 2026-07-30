/** Engine-layer vocabulary. Knows about UCI and about search, not about chess rules. */

/** A score from the moving side's point of view. */
export type Score =
  | { readonly kind: 'cp'; readonly cp: number }
  | { readonly kind: 'mate'; readonly moves: number };

/** One principal variation from a MultiPV search. */
export interface PvLine {
  /** 1-based MultiPV rank as the engine reported it. */
  readonly rank: number;
  readonly depth: number;
  readonly score: Score;
  /** Moves in UCI form, best first. Always at least one. */
  readonly moves: readonly string[];
  readonly nodes?: number;
  readonly nps?: number;
  readonly timeMs?: number;
}

/** How long to search. At least one bound must be given. */
export interface SearchLimits {
  readonly depth?: number;
  readonly movetimeMs?: number;
  readonly nodes?: number;
}

export interface BestMove {
  /** UCI move, e.g. 'e2e4' or 'e7e8q'. */
  readonly uci: string;
  readonly ponder?: string;
}

/**
 * A duplex line-oriented link to a UCI engine. The browser implementation wraps
 * a Web Worker; the Node implementation wraps the same wasm build loaded
 * in-process, so the calibration harness and the app drive identical code.
 */
export interface EngineTransport {
  send(command: string): void;
  onLine(handler: (line: string) => void): void;
  terminate(): void;
}
