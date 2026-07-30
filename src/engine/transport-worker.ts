import type { EngineTransport } from './types.js';

/**
 * Browser transport: the vendored Stockfish build, in a Web Worker.
 *
 * The build reads its .wasm location from the worker URL's hash and installs
 * its own `onmessage`, so no glue code is needed beyond constructing the Worker.
 * It is single-threaded, so no SharedArrayBuffer and no COOP/COEP headers.
 */
export function createWorkerTransport(
  engineUrl: string,
  wasmUrl: string
): EngineTransport {
  const worker = new Worker(`${engineUrl}#${wasmUrl}`);
  const handlers = new Set<(line: string) => void>();

  worker.onmessage = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (typeof data !== 'string') return; // progress objects, not UCI output
    for (const line of data.split('\n')) {
      if (line.trim()) for (const h of handlers) h(line);
    }
  };

  return {
    send(command: string): void {
      worker.postMessage(command);
    },
    onLine(handler: (line: string) => void): void {
      handlers.add(handler);
    },
    terminate(): void {
      handlers.clear();
      worker.terminate();
    },
  };
}

/** Default asset paths, relative to the page, for the vendored engine. */
export const ENGINE_ASSETS = {
  js: 'engine/stockfish-18-lite-single.js',
  wasm: 'engine/stockfish-18-lite-single.wasm',
} as const;

/** Build a transport from the vendored assets, resolved against the page URL. */
export function createVendoredEngineTransport(baseUrl = document.baseURI): EngineTransport {
  const js = new URL(ENGINE_ASSETS.js, baseUrl).href;
  const wasm = new URL(ENGINE_ASSETS.wasm, baseUrl).pathname;
  return createWorkerTransport(js, wasm);
}
