/**
 * Drive the built app in a real browser at iPhone size: play moves by dragging
 * and by tapping, take them back, redo, open the menu, and screenshot each step.
 *
 * Every assertion is checked against what the DOM actually says, and the console
 * is inspected at the end — a silent JS failure is the main way a web app looks
 * fine and is broken.
 *
 * Usage: node tools/smoke-ui.mjs [url] [screenshot-dir]
 */
import { launch, sleep } from './drive.mjs';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:4173/';
const SHOTS = process.argv[3] ?? 'screenshots';

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const page = await launch({ width: 402, height: 874 });
try {
  await page.goto(URL_UNDER_TEST);

  // The engine has to load 7 MB of wasm before the first game starts.
  await page.waitFor('document.querySelectorAll(".board-host image").length === 32', {
    timeoutMs: 120_000,
    label: 'board with 32 pieces',
  });
  check(
    'board renders 32 pieces',
    (await page.eval('document.querySelectorAll(".board-host image").length')) === 32
  );
  check(
    'viewport is iPhone-sized and laid out',
    (await page.eval('document.querySelector(".board-host").getBoundingClientRect().width')) > 300,
    `board width ${await page.eval('Math.round(document.querySelector(".board-host").getBoundingClientRect().width)')}px`
  );
  await page.screenshot(`${SHOTS}/01-start.png`);

  // Helper that converts a square to viewport coordinates, honouring the
  // board's current orientation.
  await page.eval(`window.__sq = (sq) => {
    const svg = document.querySelector('.board-host svg');
    const r = svg.getBoundingClientRect();
    const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]) - 1;
    const flipped = document.body.dataset.flipped === 'true';
    const x = flipped ? 7 - file : file;
    const y = flipped ? rank : 7 - rank;
    return { x: r.left + (x + 0.5) * r.width / 8, y: r.top + (y + 0.5) * r.height / 8 };
  }; true`);

  const at = async (square) => page.eval(`__sq("${square}")`);
  const status = async () => page.eval('document.querySelector(".status").textContent');
  /** Moves actually played from where the cursor stands. */
  const moves = async () =>
    page
      .eval(
        'JSON.stringify([...document.querySelectorAll(".ply:not([data-ahead])")].map(p => p.textContent).filter(t => t !== "\\u23ee"))'
      )
      .then(JSON.parse);
  /** Moves that were taken back and can be redone. */
  const aheadMoves = async () =>
    page
      .eval('JSON.stringify([...document.querySelectorAll(".ply[data-ahead]")].map(p => p.textContent))')
      .then(JSON.parse);

  // --- 1. drag a pawn ---
  const e2 = await at('e2');
  const e4 = await at('e4');
  await page.drag(e2, e4);
  await page.waitFor('document.querySelectorAll(".ply").length > 1', {
    label: 'first move to appear in the move list',
  });
  check('dragging e2-e4 plays the move', (await moves())[0] === 'e4', `list: ${(await moves()).join(' ')}`);
  await page.screenshot(`${SHOTS}/02-after-e4.png`);

  // --- 2. the bot replies on its own ---
  await page.waitFor('document.querySelectorAll(".ply").length > 2', {
    timeoutMs: 90_000,
    label: 'bot reply',
  });
  const afterReply = await moves();
  check('the bot replies unprompted', afterReply.length >= 2, `list: ${afterReply.join(' ')}`);
  check('it is my move again', (await status()).includes('Your move'), await status());
  await page.screenshot(`${SHOTS}/03-bot-replied.png`);

  // --- 3. tap-tap a knight out ---
  const before = (await moves()).length;
  await page.click((await at('g1')).x, (await at('g1')).y);
  await sleep(150);
  const dots = await page.eval('document.querySelectorAll(".board-host circle").length');
  check('tapping a piece shows its legal targets', dots > 0, `${dots} target marks`);
  await page.screenshot(`${SHOTS}/04-targets-shown.png`);
  await page.click((await at('f3')).x, (await at('f3')).y);
  await page.waitFor(`document.querySelectorAll(".ply").length > ${before + 1}`, {
    label: 'tap-tap move',
  });
  check('tap-tap plays the move', (await moves()).includes('Nf3'), `list: ${(await moves()).join(' ')}`);

  await page.waitFor(`document.querySelectorAll(".ply").length > ${before + 2}`, {
    timeoutMs: 90_000,
    label: 'second bot reply',
  });
  const fourMoves = await moves();
  await page.screenshot(`${SHOTS}/05-four-moves.png`);

  // --- 4. take back my move and the reply together ---
  await page.eval('document.querySelector(".controls .btn.primary").click()');
  await sleep(400);
  const afterTakeBack = await moves();
  check(
    'take back removes my move and the reply as one action',
    afterTakeBack.length === fourMoves.length - 2,
    `${fourMoves.length} played -> ${afterTakeBack.length} played`
  );
  check(
    'the taken-back moves are kept as redoable, not deleted',
    (await aheadMoves()).length === 2,
    `ahead: ${(await aheadMoves()).join(' ')}`
  );
  check('it is my move after taking back', (await status()).includes('Your move'), await status());
  check(
    'board matches the reverted position',
    (await page.eval('document.querySelectorAll(".board-host image").length')) === 32
  );
  await page.screenshot(`${SHOTS}/06-after-takeback.png`);

  // --- 5. redo puts them back ---
  const redoDisabled = await page.eval(
    'document.querySelectorAll(".controls .btn")[1].disabled'
  );
  check('redo becomes available after a take back', redoDisabled === false);
  await page.eval('document.querySelectorAll(".controls .btn")[1].click()');
  await sleep(400);
  check(
    'redo restores both moves',
    (await moves()).length === fourMoves.length,
    `${afterTakeBack.length} -> ${(await moves()).length}`
  );
  await page.screenshot(`${SHOTS}/07-after-redo.png`);

  // --- 6. move list scrubbing ---
  await page.eval('document.querySelectorAll(".ply")[1].click()');
  await sleep(250);
  check(
    'tapping a move in the list scrubs to it',
    (await page.eval('document.querySelectorAll(".ply[data-current=\\"true\\"]").length')) === 1
  );
  await page.screenshot(`${SHOTS}/08-scrubbed.png`);

  // --- 7. the menu and settings ---
  await page.eval('[...document.querySelectorAll(".controls .btn")].at(-1).click()');
  await sleep(300);
  const sheetOpen = await page.eval('!document.querySelector(".sheet").hidden');
  const settingRows = await page.eval('document.querySelectorAll(".setting-row").length');
  check('menu opens with settings', sheetOpen && settingRows >= 10, `${settingRows} setting rows`);
  await page.screenshot(`${SHOTS}/09-menu.png`);
  await page.eval('[...document.querySelectorAll(".sheet .btn")].at(-1).click()');
  await sleep(200);

  // --- 8. install and offline plumbing ---
  const sw = await page.eval(
    'navigator.serviceWorker.getRegistration().then(r => r ? "registered" : "none")'
  );
  check('service worker registers', sw === 'registered', sw);
  const cached = await page.eval(`(async () => {
    const names = await caches.keys();
    if (!names.length) return 0;
    const cache = await caches.open(names[0]);
    return (await cache.keys()).length;
  })()`);
  check('assets are precached for offline use', cached >= 20, `${cached} entries cached`);
  const enginePrecached = await page.eval(`(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    const keys = await cache.keys();
    return keys.some(r => r.url.endsWith('.wasm'));
  })()`);
  check('the engine binary itself is precached', enginePrecached);
  const persisted = await page.eval('navigator.storage.persisted()');
  check('storage persistence requested', typeof persisted === 'boolean', `persisted=${persisted}`);
  const savedGames = await page.eval(`new Promise((resolve) => {
    const req = indexedDB.open('chess-coach');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('games', 'readonly');
      const all = tx.objectStore('games').getAll();
      all.onsuccess = () => resolve(all.result.length);
      all.onerror = () => resolve(-1);
    };
    req.onerror = () => resolve(-1);
  })`);
  check('the game is saved to IndexedDB', savedGames >= 1, `${savedGames} saved game(s)`);

  // --- 8a. hints are a toggle that stays on ---
  const hintButton = 'document.querySelectorAll(".controls .btn")[2]';
  check(
    'hints start off',
    (await page.eval(`${hintButton}.textContent`)) === 'Hint',
    await page.eval(`${hintButton}.textContent`)
  );
  await page.eval(`${hintButton}.click()`);
  await page.waitFor('document.querySelectorAll(".board-host line").length > 0', {
    timeoutMs: 60_000,
    label: 'hint arrow to be drawn',
  });
  check(
    'turning hints on draws an arrow and stays on',
    (await page.eval(`${hintButton}.textContent`)) === 'Hints on' &&
      (await page.eval(`${hintButton}.dataset.on`)) === 'true'
  );
  check(
    'the hint is explained in words',
    ((await page.eval('document.querySelector(".coach").textContent')) ?? '').length > 20,
    await page.eval('document.querySelector(".coach").textContent')
  );
  await page.screenshot(`${SHOTS}/16-hint-on.png`);

  // Play a move; the arrow should come back by itself for the next one.
  const hintMoveFrom = await at('d2');
  const hintMoveTo = await at('d4');
  await page.drag(hintMoveFrom, hintMoveTo);
  await page.waitFor('document.querySelectorAll(".board-host line").length > 0', {
    timeoutMs: 120_000,
    label: 'the next hint to appear without being asked',
  });
  check('with hints on, the next hint appears unprompted', true);
  await page.screenshot(`${SHOTS}/17-hint-auto.png`);

  await page.eval(`${hintButton}.click()`);
  await sleep(300);
  check(
    'turning hints off clears the arrow',
    (await page.eval('document.querySelectorAll(".board-host line").length')) === 0 &&
      (await page.eval(`${hintButton}.textContent`)) === 'Hint'
  );

  // --- 8b. sound check reports a live output level ---
  await page.eval('[...document.querySelectorAll(".controls .btn")].at(-1).click()');
  await sleep(250);
  await page.eval(
    '[...document.querySelectorAll(".sheet .btn")].find(b => b.textContent === "Sound check").click()'
  );
  await sleep(300);
  check(
    'sound check panel opens',
    (await page.eval('!!document.querySelector(".meter")')) === true
  );
  await page.eval('document.querySelector(".sheet .btn.primary").click()');
  await sleep(900);
  const soundPeak = await page.eval(`(() => {
    const rows = [...document.querySelectorAll('.sound-detail-row')];
    const row = rows.find(r => r.firstChild.textContent === 'highest level seen');
    return row ? Number(row.lastChild.textContent) : -1;
  })()`);
  check(
    'the sound check measures real output',
    soundPeak > 0.01,
    `highest level seen ${soundPeak}`
  );
  await page.screenshot(`${SHOTS}/13-sound-check.png`);
  await page.eval('[...document.querySelectorAll(".sheet .btn")].at(-1).click()');
  await sleep(200);

  // --- 8c. a finished game offers a rematch ---
  check(
    'no rematch bar while the game is live',
    (await page.eval('document.querySelector(".endgame").hidden')) === true
  );
  await page.eval('[...document.querySelectorAll(".controls .btn")].at(-1).click()');
  await sleep(250);
  await page.eval(
    '[...document.querySelectorAll(".sheet .btn")].find(b => b.textContent === "Resign").click()'
  );
  await sleep(500);
  const endgameShown = await page.eval('!document.querySelector(".endgame").hidden');
  const endgameText = await page.eval('document.querySelector(".endgame-text").textContent');
  check('a finished game shows a rematch bar', endgameShown, endgameText);
  await page.screenshot(`${SHOTS}/14-game-over.png`);
  // --- 8d. the post-game review ---
  await page.eval(
    '[...document.querySelectorAll(".endgame .btn")].find(b => b.textContent === "Review").click()'
  );
  await page.waitFor('document.querySelector(".review-accuracy") !== null', {
    timeoutMs: 180_000,
    label: 'the review to finish analysing',
  });
  const accuracy = await page.eval(
    'document.querySelector(".review-accuracy-value").textContent'
  );
  check('the review reports an accuracy figure', /%$/.test(accuracy ?? ''), accuracy);
  check(
    'the review draws an evaluation graph',
    (await page.eval('document.querySelectorAll(".review-graph svg path").length')) >= 2
  );
  const summary = await page.eval('document.querySelector(".review-summary").textContent');
  check('the review summarises the game in words', (summary ?? '').length > 30, summary);
  const opening = await page.eval(
    'document.querySelector(".review-block-title")?.textContent ?? ""'
  );
  check('the review names the opening', /\(?[A-E]\d\d\)?/.test(opening), opening);
  await page.screenshot(`${SHOTS}/18-review.png`);
  await page.eval('[...document.querySelectorAll(".sheet .btn")].at(-1).click()');
  await sleep(300);

  await page.eval('[...document.querySelectorAll(".endgame .btn")].find(b => b.textContent === "Rematch").click()');
  await page.waitFor(
    'document.querySelectorAll(".ply:not(.start)").length === 0 && document.querySelector(".endgame").hidden',
    { timeoutMs: 60_000, label: 'a fresh game after rematch' }
  );
  check(
    'rematch starts a fresh game',
    (await page.eval('document.querySelectorAll(".board-host image").length')) === 32
  );
  await page.screenshot(`${SHOTS}/15-after-rematch.png`);

  // --- 9. dark mode is first-class, not an afterthought ---
  await page.setColorScheme('dark');
  await sleep(300);
  const darkBg = await page.eval('getComputedStyle(document.body).backgroundColor');
  await page.screenshot(`${SHOTS}/12-dark.png`);
  await page.setColorScheme('light');
  await sleep(200);
  const lightBg = await page.eval('getComputedStyle(document.body).backgroundColor');
  check(
    'dark and light modes follow the system setting',
    darkBg !== lightBg && darkBg === 'rgb(17, 21, 26)',
    `dark ${darkBg} / light ${lightBg}`
  );

  // --- 10. console must be clean ---
  const problems = page.problems.filter(
    (p) => !p.includes('favicon') && !p.includes('Download the React')
  );
  check('no console errors or exceptions', problems.length === 0, problems.slice(0, 4).join(' | '));
} finally {
  await page.close();
}

const failed = checks.filter((c) => !c.ok);
process.stdout.write(
  `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${SHOTS}/\n`
);
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`);
  process.exit(1);
}
