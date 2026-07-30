/**
 * Measure the sound. Renders every cue into an OfflineAudioContext inside a real
 * browser and reports peak and RMS amplitude, then plays a live move and confirms
 * the audio context actually reaches "running".
 *
 * This exists because "the move makes no sound" is invisible to every other test:
 * the DOM updates, the console is clean, and nothing throws. Only measuring the
 * samples catches it.
 *
 * Usage: node tools/smoke-audio.mjs [url]
 */
import { launch, sleep } from './drive.mjs';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:4173/';

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const page = await launch({ width: 402, height: 874, port: 9366 });
try {
  await page.goto(URL_UNDER_TEST);
  await page.waitFor('document.querySelectorAll(".board-host image").length === 32', {
    timeoutMs: 120_000,
  });

  // Render each cue offline, using the very modules the app ships.
  const measured = await page.eval(`(async () => {
    const mod = await import('/src/app/sound.ts').catch(() => null);
    const src = mod ?? window.__sound;
    if (!src) return { error: 'sound module not reachable' };
    const { ALL_CUES, scheduleCue, makeNoiseBuffer, MAX_CUE_SECONDS } = src;
    const out = {};
    for (const cue of ALL_CUES) {
      const ctx = new OfflineAudioContext(1, Math.ceil(44100 * MAX_CUE_SECONDS), 44100);
      const noise = makeNoiseBuffer(ctx);
      scheduleCue(ctx, ctx.destination, cue, 0, noise);
      const buffer = await ctx.startRendering();
      const data = buffer.getChannelData(0);
      let peak = 0, sumSquares = 0, nonSilent = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
        if (v > 0.001) nonSilent++;
        sumSquares += data[i] * data[i];
      }
      out[cue] = {
        peak: Number(peak.toFixed(4)),
        rms: Number(Math.sqrt(sumSquares / data.length).toFixed(4)),
        ms: Number(((nonSilent / 44100) * 1000).toFixed(0)),
      };
    }
    return out;
  })()`);

  if (measured.error) {
    check('cues can be rendered', false, measured.error);
  } else {
    process.stdout.write('\ncue         peak     rms    audible ms\n');
    for (const [cue, m] of Object.entries(measured)) {
      process.stdout.write(
        `${cue.padEnd(11)} ${String(m.peak).padStart(6)} ${String(m.rms).padStart(7)} ${String(m.ms).padStart(9)}\n`
      );
    }
    process.stdout.write('\n');
    for (const [cue, m] of Object.entries(measured)) {
      check(`${cue} is audible`, m.peak > 0.02 && m.ms >= 20, `peak ${m.peak}, ${m.ms} ms`);
    }
    // A move and a capture must be clearly distinguishable, not just present.
    const place = measured.place;
    const capture = measured.capture;
    check(
      'capture is distinguishable from a plain move',
      capture.ms > place.ms * 1.3,
      `place ${place.ms} ms vs capture ${capture.ms} ms (capture is a two-beat knock)`
    );
  }

  // Live path: does a real tap actually arm the audio context?
  const stateBefore = await page.eval('window.__soundState ? window.__soundState() : "unknown"');
  await page.eval(`window.__sq = (sq) => {
    const svg = document.querySelector('.board-host svg');
    const r = svg.getBoundingClientRect();
    const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]) - 1;
    return { x: r.left + (file + 0.5) * r.width / 8, y: r.top + ((7 - rank) + 0.5) * r.height / 8 };
  }; true`);
  const from = await page.eval('__sq("e2")');
  const to = await page.eval('__sq("e4")');
  await page.drag(from, to);
  await sleep(600);
  const stateAfter = await page.eval('window.__soundState ? window.__soundState() : "unknown"');
  check(
    'a real move arms the audio context',
    stateAfter === 'running',
    `state before first tap: ${stateBefore}, after: ${stateAfter}`
  );

  const problems = page.problems.filter((p) => !p.includes('favicon'));
  check('no console errors', problems.length === 0, problems.slice(0, 3).join(' | '));
} finally {
  await page.close();
}

const failed = checks.filter((c) => !c.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} audio checks passed\n`);
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`);
  process.exit(1);
}
