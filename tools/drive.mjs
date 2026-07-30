/**
 * A small Chrome DevTools Protocol driver, so the app can be exercised in a real
 * browser at a real iPhone viewport without needing a visible window.
 *
 * Why this exists: the interactive browser tooling on this machine was attached
 * to a minimised Chrome window, which reports a zero-size viewport, so nothing
 * laid out and nothing could be clicked or screenshotted. Apple Events are also
 * blocked for this process, so the window could not be raised. This launches its
 * own headless Chrome instead and talks to it over CDP with node's built-in
 * WebSocket — no dependencies, nothing for anyone to click.
 *
 * Input goes through Input.dispatchMouseEvent, so the browser generates genuine
 * pointer events; the app's real gesture path is what gets tested, not synthetic
 * events dispatched from page script.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME =
  process.env['CHROME_PATH'] ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launch({ width = 402, height = 874, port = 9333, profile } = {}) {
  // A fresh profile per run, because the app's service worker is cache-first by
  // design: reusing a profile means the next test run is served the PREVIOUS
  // build's assets and quietly tests the wrong code. That cost an hour once.
  const userDataDir =
    profile ?? `/tmp/chess-coach-chrome-${process.pid}-${port}`;
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(String(d)));

  const target = await waitForTarget(port, stderr);
  const session = await connect(target.webSocketDebuggerUrl);

  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Log.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  // Input goes in as touch, not mouse: with a mobile metrics override, dispatched
  // mouse events never reach the page at all (verified — the board saw nothing),
  // and touch is what a thumb actually produces anyway.
  await session.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 1,
  });

  const problems = [];
  session.on('Runtime.exceptionThrown', (params) => {
    const d = params.exceptionDetails;
    problems.push(`exception: ${d.exception?.description ?? d.text}`);
  });
  session.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error' || params.type === 'warning') {
      problems.push(
        `console.${params.type}: ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`
      );
    }
  });
  session.on('Log.entryAdded', (params) => {
    if (params.entry.level === 'error') problems.push(`log: ${params.entry.text}`);
  });

  return {
    problems,
    async goto(url) {
      await session.send('Page.navigate', { url });
      await this.waitFor('document.readyState === "complete"');
    },
    async eval(expression) {
      const result = await session.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
        );
      }
      return result.result.value;
    },
    /** Poll a JS predicate until it is true. */
    async waitFor(expression, { timeoutMs = 60_000, label = expression } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await this.eval(`Boolean(${expression})`)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(120);
      }
    },
    /** A real tap at viewport coordinates. */
    async click(x, y) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1 }],
      });
      await sleep(40);
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    },
    /** Press, slide through intermediate points, lift — a real drag. */
    async drag(from, to) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from.x, y: from.y, id: 1 }],
      });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: from.x + ((to.x - from.x) * i) / steps,
              y: from.y + ((to.y - from.y) * i) / steps,
              id: 1,
            },
          ],
        });
        await sleep(16);
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    /** Pretend the system is in dark or light mode. */
    async setColorScheme(scheme) {
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
    },
    /** Cut or restore the network at the browser level, as airplane mode would. */
    async offline(enabled) {
      await session.send('Network.enable');
      await session.send('Network.emulateNetworkConditions', {
        offline: enabled,
        latency: 0,
        downloadThroughput: enabled ? 0 : -1,
        uploadThroughput: enabled ? 0 : -1,
      });
    },
    async screenshot(path) {
      const { data } = await session.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true });
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },
    async close() {
      try {
        await session.close();
      } finally {
        child.kill('SIGTERM');
      }
    },
  };
}

async function waitForTarget(port, stderr) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome is not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`Chrome did not expose a debugging target.\n${stderr.join('')}`);
    }
    await sleep(200);
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      const handlers = listeners.get(message.method);
      if (handlers) for (const h of handlers) h(message.params);
    });
    socket.addEventListener('error', () => reject(new Error('CDP socket error')));
    socket.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, handler) {
          const existing = listeners.get(method) ?? [];
          existing.push(handler);
          listeners.set(method, existing);
        },
        close() {
          socket.close();
        },
      })
    );
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
