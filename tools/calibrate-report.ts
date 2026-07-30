/**
 * Aggregate calibration match results into measured Elo per rung.
 *
 * Method: the 1320 rung is the anchor, because there Stockfish's own
 * UCI_LimitStrength/UCI_Elo is doing the work and is calibrated by the
 * Stockfish project. Every other rung's rating is derived from match scores
 * against a rung whose rating is already known, walking down from the anchor.
 *
 * A score of exactly 0 or 1 carries no finite Elo difference, so those are
 * reported as a bound rather than a number. Saying "worse than -570" honestly
 * beats printing a fabricated figure.
 *
 * Usage: node --import ./tools/register-ts.mjs tools/calibrate-report.ts <dir>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LADDER } from '../src/engine/strength.js';

interface MatchResult {
  eloA: number;
  eloB: number;
  games: number;
  aWins: number;
  bWins: number;
  draws: number;
  scoreA: number;
  terminations: Record<string, number>;
  meanPlies: number;
  elapsedMs: number;
}

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: calibrate-report.ts <results-dir>\n');
  process.exit(1);
}

const matches: MatchResult[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as MatchResult);

if (!matches.length) {
  process.stderr.write(`no .json results in ${dir}\n`);
  process.exit(1);
}

/** Elo difference implied by a score share, or a bound when the score is 0 or 1. */
function eloDelta(score: number, games: number): { delta: number | null; bound: string } {
  if (score <= 0) {
    // Treat as if one draw had happened, giving a conservative lower bound.
    const capped = 0.5 / games;
    return { delta: null, bound: `< ${Math.round(-400 * Math.log10(1 / capped - 1))}` };
  }
  if (score >= 1) {
    const capped = 1 - 0.5 / games;
    return { delta: null, bound: `> ${Math.round(-400 * Math.log10(1 / capped - 1))}` };
  }
  return { delta: -400 * Math.log10(1 / score - 1), bound: '' };
}

/** Standard error of the Elo difference, from the binomial error on the score. */
function eloStdErr(score: number, games: number): number | null {
  if (score <= 0 || score >= 1) return null;
  const seScore = Math.sqrt((score * (1 - score)) / games);
  // d(Elo)/d(score) for the logistic mapping.
  return (400 / Math.LN10) * (seScore / (score * (1 - score)));
}

const ANCHOR = 1320;
const measured = new Map<number, { elo: number; note: string }>([
  [ANCHOR, { elo: ANCHOR, note: "anchor - Stockfish's own UCI_Elo" }],
]);

// Walk down from the anchor through whatever chain of matches connects.
let progress = true;
while (progress) {
  progress = false;
  for (const m of matches) {
    const known = measured.get(m.eloB);
    const unknown = measured.has(m.eloA) ? null : m.eloA;
    if (known && unknown !== null) {
      const { delta, bound } = eloDelta(m.scoreA, m.games);
      if (delta === null) {
        measured.set(unknown, {
          elo: Number.NaN,
          note: `unmeasurable vs ${m.eloB}: scored ${(m.scoreA * 100).toFixed(1)}% ` +
            `over ${m.games} games (gap ${bound})`,
        });
      } else {
        measured.set(unknown, {
          elo: known.elo + delta,
          note: `from ${(m.scoreA * 100).toFixed(1)}% vs rung ${m.eloB} (${m.games} games)`,
        });
      }
      progress = true;
    }
  }
}

process.stdout.write('\nMATCH RESULTS\n');
process.stdout.write(
  'pair'.padEnd(14) + 'games'.padStart(6) + 'score'.padStart(9) +
  'W-D-L'.padStart(14) + 'Elo diff'.padStart(12) + '  mean plies\n'
);
for (const m of matches.sort((a, b) => a.eloA - b.eloA)) {
  const { delta, bound } = eloDelta(m.scoreA, m.games);
  const se = eloStdErr(m.scoreA, m.games);
  const diff =
    delta === null
      ? bound
      : `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}${se ? ` ±${se.toFixed(0)}` : ''}`;
  process.stdout.write(
    `${m.eloA} vs ${m.eloB}`.padEnd(14) +
      String(m.games).padStart(6) +
      `${(m.scoreA * 100).toFixed(1)}%`.padStart(9) +
      `${m.aWins}-${m.draws}-${m.bWins}`.padStart(14) +
      diff.padStart(12) +
      `  ${m.meanPlies.toFixed(0)}\n`
  );
}

process.stdout.write('\nMEASURED RATING PER RUNG\n');
process.stdout.write('labelled'.padEnd(10) + 'measured'.padStart(10) + '  basis\n');
for (const rung of LADDER) {
  const found = measured.get(rung.elo);
  if (!found) {
    process.stdout.write(
      `${rung.elo}`.padEnd(10) + '-'.padStart(10) + '  not measured in this run\n'
    );
    continue;
  }
  const shown = Number.isNaN(found.elo) ? '?' : found.elo.toFixed(0);
  process.stdout.write(`${rung.elo}`.padEnd(10) + shown.padStart(10) + `  ${found.note}\n`);
}

const totalGames = matches.reduce((s, m) => s + m.games, 0);
const totalMs = matches.reduce((s, m) => s + m.elapsedMs, 0);
process.stdout.write(
  `\n${totalGames} games across ${matches.length} matches, ` +
    `${(totalMs / 60000).toFixed(1)} engine-minutes\n`
);

const terminations: Record<string, number> = {};
for (const m of matches) {
  for (const [k, v] of Object.entries(m.terminations)) {
    terminations[k] = (terminations[k] ?? 0) + v;
  }
}
process.stdout.write(`terminations: ${JSON.stringify(terminations)}\n`);
