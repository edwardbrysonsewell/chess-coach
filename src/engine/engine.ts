import { parseBestMove, parseInfoLine } from './uci.js';
import type { BestMove, EngineTransport, PvLine, SearchLimits } from './types.js';

export interface EvaluateOptions extends SearchLimits {
  /** How many distinct lines to return. Defaults to 1. */
  readonly multiPv?: number;
}

export interface EngineInfo {
  readonly name: string;
}

/**
 * Promise-based wrapper around a UCI engine.
 *
 * Two things this guarantees, both of which are easy to get wrong:
 *
 *  - Only one search runs at a time. UCI is a stateful line protocol, so
 *    overlapping searches would interleave and return each other's moves.
 *    Calls queue instead.
 *  - Nothing here runs on the UI thread except message handling. The search
 *    itself lives in the transport (a Web Worker in the browser).
 */
export class UciEngine {
  private readonly transport: EngineTransport;
  private lineHandlers = new Set<(line: string) => void>();
  /** Serialises searches: every public call chains onto this. */
  private queue: Promise<unknown> = Promise.resolve();
  private ready = false;
  private name = 'unknown';
  private currentMultiPv = 1;
  private searching = false;

  constructor(transport: EngineTransport) {
    this.transport = transport;
    this.transport.onLine((line) => {
      for (const h of [...this.lineHandlers]) h(line.trim());
    });
  }

  /** Boot the engine and complete the UCI handshake. Safe to call once. */
  async init(): Promise<EngineInfo> {
    if (this.ready) return { name: this.name };
    return this.enqueue(async () => {
      const lines = await this.collectUntil('uci', (l) => l === 'uciok', 180_000);
      this.name = lines.find((l) => l.startsWith('id name '))?.slice(8) ?? 'unknown';
      await this.collectUntil('isready', (l) => l === 'readyok', 60_000);
      this.ready = true;
      return { name: this.name };
    });
  }

  /** Tell the engine a new game started, so it drops stale search state. */
  async newGame(): Promise<void> {
    await this.enqueue(async () => {
      this.transport.send('ucinewgame');
      await this.collectUntil('isready', (l) => l === 'readyok', 60_000);
    });
  }

  async setOption(name: string, value: string | number | boolean): Promise<void> {
    await this.enqueue(async () => {
      this.transport.send(`setoption name ${name} value ${String(value)}`);
      await this.collectUntil('isready', (l) => l === 'readyok', 60_000);
    });
  }

  /** Best move for a position. Returns null if the position has no legal moves. */
  async bestMove(fen: string, limits: SearchLimits): Promise<BestMove | null> {
    const lines = await this.search(fen, limits, 1);
    return lines.bestMove;
  }

  /**
   * Ranked candidate lines. Ask for `multiPv` of them; the engine returns fewer
   * when the position has fewer legal moves, which callers must tolerate.
   */
  async evaluate(fen: string, options: EvaluateOptions = {}): Promise<PvLine[]> {
    const { multiPv = 1, ...limits } = options;
    const result = await this.search(fen, limits, multiPv);
    return result.lines;
  }

  /** Ask a running search to stop early. Harmless if nothing is running. */
  stop(): void {
    if (this.searching) this.transport.send('stop');
  }

  /** Shut the engine down. The instance is unusable afterwards. */
  async quit(): Promise<void> {
    await this.enqueue(async () => {
      this.transport.send('quit');
      this.transport.terminate();
      this.ready = false;
    });
  }

  private async search(
    fen: string,
    limits: SearchLimits,
    multiPv: number
  ): Promise<{ lines: PvLine[]; bestMove: BestMove | null }> {
    if (!this.ready) await this.init();
    if (limits.depth === undefined && limits.movetimeMs === undefined && limits.nodes === undefined) {
      throw new Error('search needs at least one of depth, movetimeMs or nodes');
    }
    return this.enqueue(async () => {
      if (multiPv !== this.currentMultiPv) {
        this.transport.send(`setoption name MultiPV value ${multiPv}`);
        this.currentMultiPv = multiPv;
      }
      this.transport.send(`position fen ${fen}`);

      const go = [
        'go',
        limits.depth !== undefined ? `depth ${limits.depth}` : '',
        limits.movetimeMs !== undefined ? `movetime ${limits.movetimeMs}` : '',
        limits.nodes !== undefined ? `nodes ${limits.nodes}` : '',
      ]
        .filter(Boolean)
        .join(' ');

      // Keep the deepest line seen for each MultiPV rank; the engine reports a
      // rank repeatedly as the search deepens.
      const best = new Map<number, PvLine>();
      let bestMove: BestMove | null = null;

      this.searching = true;
      try {
        await this.collectUntil(
          go,
          (line) => {
            const info = parseInfoLine(line);
            if (info) {
              const prev = best.get(info.rank);
              if (!prev || info.depth >= prev.depth) best.set(info.rank, info);
              return false;
            }
            if (line.startsWith('bestmove')) {
              bestMove = parseBestMove(line);
              return true;
            }
            return false;
          },
          // A depth-limited search in a wild position can take a while; the
          // caller's own limits are the real bound, this only catches a hang.
          600_000
        );
      } finally {
        this.searching = false;
      }

      const lines = [...best.values()].sort((a, b) => a.rank - b.rank);
      return { lines, bestMove };
    });
  }

  /**
   * Send a command and gather lines until `done` says stop. `done` may also
   * consume lines as they arrive, which is how MultiPV output is collected.
   */
  private collectUntil(
    command: string,
    done: (line: string) => boolean,
    timeoutMs: number
  ): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const seen: string[] = [];
      const handler = (line: string): void => {
        seen.push(line);
        let finished = false;
        try {
          finished = done(line);
        } catch (e) {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        if (finished) {
          cleanup();
          resolve(seen);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`engine timed out after ${timeoutMs} ms waiting on: ${command}`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.lineHandlers.delete(handler);
      };

      this.lineHandlers.add(handler);
      this.transport.send(command);
    });
  }

  /** Chain a task onto the queue so searches never overlap. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even if a task rejects, so one failure does not
    // wedge the engine for the rest of the session.
    this.queue = run.catch(() => undefined);
    return run;
  }
}
