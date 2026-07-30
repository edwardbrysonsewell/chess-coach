import { createRequire } from 'node:module';
import type { EngineTransport } from './types.js';

/**
 * Node transport: the same wasm build, loaded in-process.
 *
 * This exists so the calibration harness and the engine smoke test drive the
 * identical UciEngine and strength policy the app uses. If calibration ran
 * against a different engine wrapper, its numbers would describe something the
 * phone never runs.
 */
export async function createNodeTransport(
  flavor = 'lite-single'
): Promise<EngineTransport> {
  const require = createRequire(import.meta.url);
  const initEngine = require('stockfish') as (
    flavor?: string
  ) => Promise<NodeStockfish>;

  const engine = await initEngine(flavor);
  const handlers = new Set<(line: string) => void>();
  const deliver = (raw: unknown): void => {
    const text = String(raw);
    for (const line of text.split('\n')) {
      if (line.trim()) for (const h of [...handlers]) h(line.trim());
    }
  };

  if (typeof engine.addMessageListener === 'function') {
    engine.addMessageListener(deliver);
  } else {
    engine.listener = deliver;
    engine.print = deliver;
    engine.printErr = deliver;
  }

  return {
    send(command: string): void {
      engine.sendCommand(command);
    },
    onLine(handler: (line: string) => void): void {
      handlers.add(handler);
    },
    terminate(): void {
      handlers.clear();
      // The in-process build has no kill switch beyond `quit`, which UciEngine
      // sends before calling this.
    },
  };
}

interface NodeStockfish {
  sendCommand(command: string): void;
  addMessageListener?: (handler: (line: unknown) => void) => void;
  listener?: (line: unknown) => void;
  print?: (line: unknown) => void;
  printErr?: (line: unknown) => void;
}
