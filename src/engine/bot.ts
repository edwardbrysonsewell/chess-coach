import { Position } from '../core/position.js';
import type { UciEngine } from './engine.js';
import {
  chooseMove,
  LADDER,
  makeRng,
  optionsFor,
  rungFor,
  thinkTimeMs,
  type Rng,
  type RungConfig,
} from './strength.js';
import type { PvLine } from './types.js';

export interface BotMove {
  readonly uci: string;
  /** How long the bot should appear to think, in ms. */
  readonly thinkMs: number;
  /** The candidate lines the choice was made from, for the coach and hints. */
  readonly lines: readonly PvLine[];
  /** The engine's own first choice, which may differ from what was played. */
  readonly engineBest: string | null;
}

/**
 * Which rung's options are currently live on an engine.
 *
 * Share one of these between every Bot that talks to the same engine. The
 * calibration harness runs both players through a single engine instance — the
 * vendored build's module factory is single-use, so a second in-process
 * instance is not possible — and without a shared cache each Bot would believe
 * its own options were still applied after the other had changed them.
 */
export interface EngineOptionState {
  appliedElo: number | null;
}

/**
 * An opponent at a chosen rung of the ladder. Owns the engine options that the
 * rung implies, so switching level mid-game cannot leave stale options behind.
 */
export class Bot {
  private readonly engine: UciEngine;
  private readonly rng: Rng;
  private readonly optionState: EngineOptionState;
  private rung: RungConfig;

  constructor(
    engine: UciEngine,
    elo = 1320,
    rng: Rng = makeRng(0x5eed),
    optionState: EngineOptionState = { appliedElo: null }
  ) {
    this.engine = engine;
    this.rng = rng;
    this.rung = rungFor(elo);
    this.optionState = optionState;
  }

  static levels(): readonly number[] {
    return LADDER.map((r) => r.elo);
  }

  currentRung(): RungConfig {
    return this.rung;
  }

  async setElo(elo: number): Promise<void> {
    this.rung = rungFor(elo);
    await this.applyOptions();
  }

  /**
   * Play with an explicit configuration rather than a ladder rung. Used by the
   * calibration harness to measure candidate settings against a known anchor,
   * which is how the ladder's numbers were fitted instead of guessed.
   */
  setRung(rung: RungConfig): void {
    this.rung = rung;
  }

  /** Choose a move for `fen`. Returns null when there is nothing legal to play. */
  async move(fen: string): Promise<BotMove | null> {
    await this.applyOptions();
    const position = new Position(fen);
    const legal = position.legalMoves();
    if (!legal.length) return null;

    const multiPv = Math.min(this.rung.multiPv, legal.length);
    const lines = await this.engine.evaluate(fen, {
      multiPv,
      nodes: this.rung.nodes,
    });

    const engineBest = lines.find((l) => l.rank === 1)?.moves[0] ?? null;
    const uci = chooseMove(position, lines, this.rung, this.rng) ?? legal[0]?.uci;
    if (!uci) return null;

    // The rules layer has the final say on legality; the engine is never trusted
    // for it. A candidate that fails this is a bug, not a move.
    if (!legal.some((m) => m.uci === uci)) {
      throw new Error(`bot produced an illegal move ${uci} in ${fen}`);
    }

    return {
      uci,
      thinkMs: thinkTimeMs(position, this.rung, this.rng),
      lines,
      engineBest,
    };
  }

  /** Abandon a search in progress, e.g. because the move was taken back. */
  stop(): void {
    this.engine.stop();
  }

  private async applyOptions(): Promise<void> {
    if (this.optionState.appliedElo === this.rung.elo) return;
    for (const [name, value] of optionsFor(this.rung)) {
      await this.engine.setOption(name, value);
    }
    this.optionState.appliedElo = this.rung.elo;
  }
}
