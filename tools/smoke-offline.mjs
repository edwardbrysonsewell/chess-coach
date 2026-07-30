/**
 * Prove the app works with the network cut off, which is the whole point of the
 * service worker: load once, then fly.
 *
 * Sequence: load online so the worker installs and precaches, then switch the
 * browser to offline, reload, and play a full move against the bot — engine load
 * included. If anything still needed the network, the reload would fail or the
 * bot would never answer.
 *
 * Usage: node tools/smoke-offline.mjs [url] [screenshot-dir]
 */
import { launch, sleep } from './drive.mjs';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:4173/';
const SHOTS = process.argv[3] ?? 'screenshots';

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const page = await launch({ width: 402, height: 874, port: 9355 });
try {
  // 1. Online, so the worker installs and fills the cache.
  await page.goto(URL_UNDER_TEST);
  await page.waitFor('document.querySelectorAll(".board-host image").length === 32', {
    timeoutMs: 120_000,
    label: 'first online load',
  });
  await page.waitFor(
    'navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))',
    { timeoutMs: 60_000, label: 'service worker to activate' }
  );
  const cached = await page.eval(`(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    return (await cache.keys()).length;
  })()`);
  check('precache filled while online', cached >= 20, `${cached} entries`);

  // 2. Cut the network at the browser level, not in page script.
  await page.offline(true);
  const navigatorOffline = await page.eval('navigator.onLine');
  check('browser reports offline', navigatorOffline === false, `navigator.onLine=${navigatorOffline}`);
  const fetchFails = await page.eval(
    `fetch('https://example.com/ping').then(() => 'reached network').catch(() => 'blocked')`
  );
  check('outbound network really is blocked', fetchFails === 'blocked', fetchFails);

  // 3. Reload with no network at all.
  await page.eval('location.reload(); true');
  await sleep(1200);
  await page.waitFor('document.querySelectorAll(".board-host image").length === 32', {
    timeoutMs: 120_000,
    label: 'offline reload to render the board',
  });
  check('app loads with no network', true, 'board rendered from cache');
  await page.screenshot(`${SHOTS}/10-offline-loaded.png`);

  // 4. Play a move offline and make sure the bot answers.
  await page.eval(`window.__sq = (sq) => {
    const svg = document.querySelector('.board-host svg');
    const r = svg.getBoundingClientRect();
    const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]) - 1;
    return { x: r.left + (file + 0.5) * r.width / 8, y: r.top + ((7 - rank) + 0.5) * r.height / 8 };
  }; true`);
  const from = await page.eval('__sq("d2")');
  const to = await page.eval('__sq("d4")');
  await page.drag(from, to);
  await page.waitFor('document.querySelectorAll(".ply:not([data-ahead])").length >= 3', {
    timeoutMs: 120_000,
    label: 'bot to reply while offline',
  });
  const played = await page.eval(
    'JSON.stringify([...document.querySelectorAll(".ply:not([data-ahead])")].map(p => p.textContent).slice(1))'
  );
  check('engine loads and the bot plays while offline', true, `moves: ${JSON.parse(played).join(' ')}`);
  await page.screenshot(`${SHOTS}/11-offline-played.png`);

  const problems = page.problems.filter(
    (p) => !p.includes('favicon') && !p.toLowerCase().includes('err_internet_disconnected')
  );
  check('no console errors while offline', problems.length === 0, problems.slice(0, 3).join(' | '));
} finally {
  await page.close();
}

const failed = checks.filter((c) => !c.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} offline checks passed\n`);
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`);
  process.exit(1);
}
