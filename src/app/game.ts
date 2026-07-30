import { Position } from '../core/position.js';
import { GameTree, type TreeNode } from '../core/variation.js';
import { writePgn } from '../core/pgn.js';
import type { Color, MoveInfo, PieceSymbol, Square } from '../core/types.js';
import type { Bot } from '../engine/bot.js';
import type { Cue } from './sound.js';

export interface ClockConfig {
  minutes: number;
  increment: number;
}

export interface GameConfig {
  humanColor: Color;
  clock: ClockConfig | null;
  botElo: number;
}

export interface ClockState {
  /** Milliseconds remaining. */
  w: number;
  b: number;
  running: Color | null;
}

export interface GameSnapshot {
  fen: string;
  lastMove: { from: Square; to: Square } | null;
  /** Mainline moves up to the current node, for the move list. */
  moves: MoveInfo[];
  /** Index into `moves` the cursor sits on; -1 at the start. */
  cursor: number;
  turn: Color;
  humanColor: Color;
  thinking: boolean;
  /** Set when the game has ended. */
  result: { text: string; reason: string } | null;
  clock: ClockState | null;
  canTakeBack: boolean;
  canRedo: boolean;
}

export interface GameCallbacks {
  onChange(snapshot: GameSnapshot): void;
  onCue(cue: Cue): void;
  /** A move was played, so the view can animate it. */
  onMove?(move: MoveInfo, byHuman: boolean): void;
  /** Fired after every change, for autosave. */
  onPersist?(): void;
}

export type MoveOutcome = 'ok' | 'illegal' | 'needs-promotion' | 'not-your-turn' | 'game-over';

/**
 * One game against the bot.
 *
 * Rules come from Position, the move history is a GameTree so explore mode can
 * branch off it later, and the bot is asked for a move only when it is actually
 * its turn. Take back walks the tree cursor rather than deleting nodes, so redo
 * is free — and every bot reply carries a generation stamp, so a reply that
 * arrives after a take back is discarded instead of being played into a position
 * the user has already left. That race is the usual way undo corrupts a game.
 */
export class GameController {
  readonly tree: GameTree;
  private readonly bot: Bot;
  private readonly callbacks: GameCallbacks;
  private config: GameConfig;

  private thinking = false;
  private generation = 0;
  private clock: ClockState | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private ended: { text: string; reason: string } | null = null;
  /** Nodes ahead of the cursor that redo can walk back into. */
  private redoDepth = 0;

  constructor(bot: Bot, config: GameConfig, callbacks: GameCallbacks, startFen?: string) {
    this.bot = bot;
    this.config = config;
    this.callbacks = callbacks;
    this.tree = new GameTree(startFen);
    if (config.clock) {
      this.clock = {
        w: config.clock.minutes * 60_000,
        b: config.clock.minutes * 60_000,
        running: null,
      };
    }
  }

  humanColor(): Color {
    return this.config.humanColor;
  }

  botElo(): number {
    return this.config.botElo;
  }

  position(): Position {
    return this.tree.position();
  }

  /** Begin play. If the bot has white, it moves first. */
  async start(): Promise<void> {
    this.emit();
    if (this.turn() !== this.config.humanColor) await this.playBotMove();
    else this.startClock();
  }

  turn(): Color {
    return this.tree.position().turn();
  }

  /** Is a promotion piece required for this move? The UI asks before committing. */
  needsPromotion(from: Square, to: Square): boolean {
    return this.tree
      .position()
      .legalMoves(from)
      .some((m) => m.to === to && m.isPromotion);
  }

  /**
   * Play the human's move. Returns why it was refused rather than throwing, since
   * the board asks about moves constantly.
   */
  async humanMove(
    from: Square,
    to: Square,
    promotion?: PieceSymbol
  ): Promise<MoveOutcome> {
    if (this.ended) return 'game-over';
    if (this.thinking || this.turn() !== this.config.humanColor) return 'not-your-turn';
    if (promotion === undefined && this.needsPromotion(from, to)) return 'needs-promotion';

    const before = this.tree.current();
    const node = this.tree.play({ from, to, ...(promotion ? { promotion } : {}) });
    if (!node || node === before) {
      this.callbacks.onCue('illegal');
      return 'illegal';
    }

    // Playing a fresh move abandons anything the cursor could have redone.
    this.redoDepth = 0;
    this.afterMove(node, true);
    if (!this.ended) await this.playBotMove();
    return 'ok';
  }

  /**
   * Undo the human's move and the bot's reply as one action. Unlimited, and it
   * keeps the tree intact so redo can put them back.
   */
  takeBack(): number {
    if (!this.canTakeBack()) return 0;
    // Cancel any search in flight; its answer is about a position we are leaving.
    this.generation++;
    this.thinking = false;
    this.bot.stop?.();

    // Two plies normally. If the bot is on the move (so the last ply was the
    // human's), one ply is enough to hand the move back.
    const wanted = this.turn() === this.config.humanColor ? 2 : 1;
    const undone = this.tree.takeBack(wanted);
    this.redoDepth += undone;
    if (undone > 0) {
      this.ended = null;
      this.callbacks.onCue('takeback');
      this.startClock();
      this.emit();
      this.callbacks.onPersist?.();
    }
    return undone;
  }

  /** Replay what take back undid. */
  redo(): number {
    if (this.redoDepth <= 0 || this.thinking) return 0;
    const wanted = Math.min(this.redoDepth, 2);
    const done = this.tree.redo(wanted);
    this.redoDepth -= done;
    if (done > 0) {
      this.callbacks.onCue('place');
      this.checkEnd();
      this.emit();
      this.callbacks.onPersist?.();
    }
    return done;
  }

  canTakeBack(): boolean {
    return this.tree.current().parent !== null;
  }

  canRedo(): boolean {
    return this.redoDepth > 0;
  }

  /** Move the cursor for scrubbing the move list. Does not change the game. */
  goTo(node: TreeNode): void {
    const path = this.tree.pathTo(this.tree.mainline().at(-1) as TreeNode);
    const index = path.indexOf(node);
    if (index < 0) return;
    this.tree.goTo(node);
    this.redoDepth = path.length - 1 - index;
    this.emit();
  }

  /** Every mainline move, for the move list. */
  mainlineMoves(): MoveInfo[] {
    return this.tree
      .mainline()
      .slice(1)
      .map((n) => n.move as MoveInfo);
  }

  pgn(): string {
    return writePgn(
      this.tree,
      {
        Event: 'Chess Coach',
        White: this.config.humanColor === 'w' ? 'Me' : `Bot ${this.config.botElo}`,
        Black: this.config.humanColor === 'b' ? 'Me' : `Bot ${this.config.botElo}`,
      },
      this.ended?.text ?? '*'
    );
  }

  result(): { text: string; reason: string } | null {
    return this.ended;
  }

  /** Stop clocks and searches; call when leaving the game. */
  dispose(): void {
    this.generation++;
    this.stopClock();
  }

  /** Human resigns. */
  resign(): void {
    if (this.ended) return;
    this.ended = {
      text: this.config.humanColor === 'w' ? '0-1' : '1-0',
      reason: 'you resigned',
    };
    this.stopClock();
    this.callbacks.onCue('draw');
    this.emit();
    this.callbacks.onPersist?.();
  }

  private async playBotMove(): Promise<void> {
    if (this.ended) return;
    const generation = this.generation;
    this.thinking = true;
    this.stopClock();
    this.startClock(); // the bot's clock now runs
    this.emit();

    const fen = this.tree.position().fen();
    let chosen: { uci: string; thinkMs: number } | null = null;
    try {
      chosen = await this.bot.move(fen);
    } catch {
      chosen = null;
    }
    if (generation !== this.generation) return; // taken back while thinking

    if (!chosen) {
      this.thinking = false;
      this.checkEnd();
      this.emit();
      return;
    }

    // Let the bot appear to think, but never add delay it has already spent.
    const spent = 0;
    const wait = Math.max(0, chosen.thinkMs - spent);
    await sleep(wait);
    if (generation !== this.generation) return;

    const node = this.tree.play({
      from: chosen.uci.slice(0, 2),
      to: chosen.uci.slice(2, 4),
      ...(chosen.uci.length > 4 ? { promotion: chosen.uci[4] as PieceSymbol } : {}),
    });
    this.thinking = false;
    if (!node) {
      // The rules layer refused the engine's move. Never paper over this.
      throw new Error(`bot returned an illegal move ${chosen.uci} for ${fen}`);
    }
    this.redoDepth = 0;
    this.afterMove(node, false);
  }

  private afterMove(node: TreeNode, byHuman: boolean): void {
    const move = node.move as MoveInfo;
    this.applyIncrement(move.color);
    this.cueFor(move);
    this.callbacks.onMove?.(move, byHuman);
    this.checkEnd();
    if (!this.ended) this.startClock();
    this.emit();
    this.callbacks.onPersist?.();
  }

  private cueFor(move: MoveInfo): void {
    if (move.isCheckmate) this.callbacks.onCue('checkmate');
    else if (move.isCheck) this.callbacks.onCue('check');
    else if (move.isPromotion) this.callbacks.onCue('promotion');
    else if (move.isCapture) this.callbacks.onCue('capture');
    else this.callbacks.onCue('place');
  }

  private checkEnd(): void {
    const outcome = this.tree.position().outcome();
    if (!outcome.over) {
      this.ended = null;
      return;
    }
    const reason =
      outcome.reason === 'checkmate'
        ? outcome.winner === this.config.humanColor
          ? 'you won by checkmate'
          : 'the bot won by checkmate'
        : readableDraw(outcome.reason);
    this.ended = { text: outcome.result, reason };
    this.stopClock();
    if (outcome.reason !== 'checkmate') this.callbacks.onCue('draw');
  }

  private applyIncrement(mover: Color): void {
    const increment = this.config.clock?.increment ?? 0;
    if (this.clock && increment > 0) this.clock[mover] += increment * 1000;
  }

  private startClock(): void {
    if (!this.clock || this.ended) return;
    this.stopClock();
    this.clock.running = this.turn();
    this.lastTick = Date.now();
    this.clockTimer = setInterval(() => this.tickClock(), 100);
  }

  private stopClock(): void {
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.clock) this.clock.running = null;
  }

  private tickClock(): void {
    const clock = this.clock;
    if (!clock?.running) return;
    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    clock[clock.running] -= elapsed;
    if (clock[clock.running] <= 0) {
      clock[clock.running] = 0;
      const flagged = clock.running;
      this.stopClock();
      this.ended = {
        text: flagged === 'w' ? '0-1' : '1-0',
        reason:
          flagged === this.config.humanColor ? 'you ran out of time' : 'the bot ran out of time',
      };
      this.callbacks.onCue('draw');
      this.callbacks.onPersist?.();
    }
    this.emit();
  }

  private emit(): void {
    const position = this.tree.position();
    const current = this.tree.current();
    const path = this.tree.pathTo(current);
    this.callbacks.onChange({
      fen: position.fen(),
      lastMove: current.move ? { from: current.move.from, to: current.move.to } : null,
      moves: this.mainlineMoves(),
      cursor: path.length - 2,
      turn: position.turn(),
      humanColor: this.config.humanColor,
      thinking: this.thinking,
      result: this.ended,
      clock: this.clock ? { ...this.clock } : null,
      canTakeBack: this.canTakeBack(),
      canRedo: this.canRedo(),
    });
  }
}

function readableDraw(reason: string): string {
  switch (reason) {
    case 'stalemate':
      return 'drawn by stalemate';
    case 'insufficient-material':
      return 'drawn — not enough material to mate';
    case 'threefold-repetition':
      return 'drawn by repetition';
    case 'fifty-move-rule':
      return 'drawn by the fifty-move rule';
    default:
      return `drawn (${reason})`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
