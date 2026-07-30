/**
 * Prove the boot watchdog works: if the app cannot start, the user gets a
 * readable screen with a working reset button — never a blank white screen with
 * nothing to tap, which is exactly what happened on Bryson's phone.
 *
 * Simulates the failure by poisoning the cached script before loading.
 */
import { launch, sleep } from './drive.mjs';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:4173/';
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const page = await launch({ width: 402, height: 874, port: 9388 });
try {
  // 1. Normal boot must NOT show the rescue screen.
  await page.goto(URL_UNDER_TEST);
  await page.waitFor('window.__appBooted === true', { timeoutMs: 60_000, label: 'app boot flag' });
  await sleep(1000);
  check(
    'a healthy app never shows the rescue screen',
    (await page.eval('document.getElementById("rescue") === null')) === true
  );

  // 2. Break it: register a service worker cache entry that returns broken JS.
  await page.eval(`(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    const keys = await cache.keys();
    const script = keys.find(r => r.url.endsWith('.js') && r.url.includes('assets'));
    await cache.put(script, new Response('throw new Error("simulated broken build");', {
      headers: { 'Content-Type': 'application/javascript' },
    }));
    return script.url;
  })()`);
  await page.eval('location.reload(); true');
  await sleep(3000);
  await page.waitFor('document.getElementById("rescue") !== null', {
    timeoutMs: 30_000,
    label: 'the rescue screen to appear',
  });
  check('a broken build shows a readable rescue screen instead of a white page', true);
  const text = await page.eval('document.getElementById("rescue").innerText');
  check('the rescue screen explains itself', (text ?? '').includes('did not start'), text?.split('\n')[0]);
  await page.screenshot('screenshots/19-rescue.png');

  // 3. The reset button must actually recover the app.
  await page.eval('document.querySelector("#rescue button").click()');
  await sleep(2500);
  await page.waitFor('window.__appBooted === true', {
    timeoutMs: 90_000,
    label: 'the app to recover after reset',
  });
  check(
    'the reset button clears the bad cache and the app comes back',
    (await page.eval('document.querySelectorAll(".board-host image").length')) === 32
  );
} finally {
  await page.close();
}

const failed = checks.filter((c) => !c.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} rescue checks passed\n`);
if (failed.length) process.exit(1);
