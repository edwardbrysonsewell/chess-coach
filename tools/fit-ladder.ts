/**
 * Fit the sampled-rung strength model from measured match results, and print the
 * temperature each target rating needs.
 *
 * Model:  Elo = a + b * sqrt(temperature) + c * blunderRate
 *
 * sqrt(temperature) is used because it fits the measured anchor sweep almost
 * linearly, where raw temperature and log(temperature) do not. The blunder term
 * captures the extra strength given up for human-looking mistakes.
 *
 * Usage:
 *   node --import ./tools/register-ts.mjs tools/fit-ladder.ts <dir> [<dir>...]
 *
 * Directories hold the JSON written by tools/calibrate.ts. Player B's rating
 * must be derivable — either the 1320 anchor or a rung already solved — so the
 * chain is walked before fitting.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface MatchResult {
  eloA: number;
  eloB: number;
  games: number;
  scoreA: number;
  configA: {
    mode: string;
    temperatureCp: number;
    blunderRate: number;
    nodes: number;
    multiPv: number;
  };
}

const dirs = process.argv.slice(2);
if (!dirs.length) {
  process.stderr.write('usage: fit-ladder.ts <results-dir> [<results-dir>...]\n');
  process.exit(1);
}

const matches: MatchResult[] = dirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as MatchResult)
);

const ANCHOR_RUNG = 1320;
const ANCHOR_ELO = 1320;

function eloDelta(score: number, games: number): number {
  // Clamp a 0% or 100% result to half a game so the logit stays finite. The
  // result is a bound, not a measurement, and is flagged where it is used.
  const p = Math.min(Math.max(score, 0.5 / games), 1 - 0.5 / games);
  return -400 * Math.log10(1 / p - 1);
}

function eloStdErr(score: number, games: number): number {
  const p = Math.min(Math.max(score, 0.5 / games), 1 - 0.5 / games);
  const seScore = Math.sqrt((p * (1 - p)) / games);
  return (400 / Math.LN10) * (seScore / (p * (1 - p)));
}

/** Solve the rung ratings by walking out from the anchor. */
const rating = new Map<number, number>([[ANCHOR_RUNG, ANCHOR_ELO]]);
const clampedRungs = new Set<number>();
for (let pass = 0; pass < 20; pass++) {
  for (const m of matches) {
    if (rating.has(m.eloB) && !rating.has(m.eloA)) {
      rating.set(m.eloA, (rating.get(m.eloB) as number) + eloDelta(m.scoreA, m.games));
      if (m.scoreA <= 0 || m.scoreA >= 1) clampedRungs.add(m.eloA);
    }
  }
}

interface Row {
  label: number;
  temp: number;
  blunder: number;
  elo: number;
  se: number;
  clamped: boolean;
}

const rows: Row[] = [];
for (const m of matches) {
  if (m.configA.mode !== 'sampled') continue;
  const base = rating.get(m.eloB);
  if (base === undefined) continue;
  rows.push({
    label: m.eloA,
    temp: m.configA.temperatureCp,
    blunder: m.configA.blunderRate,
    elo: base + eloDelta(m.scoreA, m.games),
    se: eloStdErr(m.scoreA, m.games),
    clamped: m.scoreA <= 0 || m.scoreA >= 1,
  });
}

process.stdout.write('\nOBSERVATIONS (sampled configurations, rating derived from opponent)\n');
process.stdout.write(
  'label'.padEnd(8) + 'temp'.padStart(7) + 'blunder'.padStart(9) +
  'measured'.padStart(11) + 'se'.padStart(7) + '  note\n'
);
for (const r of rows.sort((a, b) => a.temp - b.temp)) {
  process.stdout.write(
    String(r.label).padEnd(8) +
      String(r.temp).padStart(7) +
      r.blunder.toFixed(3).padStart(9) +
      r.elo.toFixed(0).padStart(11) +
      r.se.toFixed(0).padStart(7) +
      (r.clamped ? '  BOUND ONLY (score hit 0 or 100%)\n' : '\n')
  );
}

// Least squares on the unclamped rows only; a bound is not a measurement.
const usable = rows.filter((r) => !r.clamped);
if (usable.length < 3) {
  process.stderr.write(`\nneed at least 3 unclamped observations, have ${usable.length}\n`);
  process.exit(1);
}

// Design matrix columns: 1, sqrt(temp), blunderRate. Weight by 1/se^2.
const X = usable.map((r) => [1, Math.sqrt(r.temp), r.blunder]);
const y = usable.map((r) => r.elo);
const w = usable.map((r) => 1 / Math.max(r.se, 1) ** 2);

const XtWX: number[][] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];
const XtWy = [0, 0, 0];
for (let i = 0; i < X.length; i++) {
  const xi = X[i] as number[];
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      (XtWX[a] as number[])[b] =
        ((XtWX[a] as number[])[b] as number) +
        (w[i] as number) * (xi[a] as number) * (xi[b] as number);
    }
    XtWy[a] = (XtWy[a] as number) + (w[i] as number) * (xi[a] as number) * (y[i] as number);
  }
}
const beta = solve3(XtWX, XtWy);
if (!beta) {
  process.stderr.write('\nfit failed: singular normal equations\n');
  process.exit(1);
}
const [a, b, c] = beta as [number, number, number];

process.stdout.write(
  `\nFIT  Elo = ${a.toFixed(0)} ${b >= 0 ? '+' : '-'} ${Math.abs(b).toFixed(1)} * sqrt(temp) ` +
    `${c >= 0 ? '+' : '-'} ${Math.abs(c).toFixed(0)} * blunderRate` +
    `   (${usable.length} observations)\n`
);
let ss = 0;
for (let i = 0; i < X.length; i++) {
  const xi = X[i] as number[];
  const pred = a + b * (xi[1] as number) + c * (xi[2] as number);
  ss += ((y[i] as number) - pred) ** 2;
}
process.stdout.write(`residual RMS: ${Math.sqrt(ss / X.length).toFixed(0)} Elo\n`);

// Invert for the ladder we want, with the blunder rates we intend to ship.
const TARGETS: Array<[elo: number, blunder: number]> = [
  [250, 0.2],
  [400, 0.13],
  [550, 0.085],
  [700, 0.055],
  [850, 0.035],
  [1000, 0.02],
  [1150, 0.01],
];
process.stdout.write('\nRECOMMENDED TEMPERATURES\n');
process.stdout.write('target'.padEnd(8) + 'blunder'.padStart(9) + 'temp'.padStart(8) + '\n');
for (const [target, blunder] of TARGETS) {
  const root = (target - a - c * blunder) / b;
  const temp = root <= 0 ? Number.NaN : root * root;
  process.stdout.write(
    String(target).padEnd(8) +
      blunder.toFixed(3).padStart(9) +
      (Number.isNaN(temp) ? 'n/a' : temp.toFixed(0)).padStart(8) +
      '\n'
  );
}

function solve3(m: number[][], v: number[]): number[] | null {
  // Gaussian elimination with partial pivoting on a 3x3 system.
  const A = m.map((row, i) => [...(row as number[]), v[i] as number]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs((A[r] as number[])[col] as number) > Math.abs((A[pivot] as number[])[col] as number)) {
        pivot = r;
      }
    }
    if (Math.abs((A[pivot] as number[])[col] as number) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot] as number[], A[col] as number[]];
    const pivotRow = A[col] as number[];
    const pv = pivotRow[col] as number;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const row = A[r] as number[];
      const factor = (row[col] as number) / pv;
      for (let k = col; k < 4; k++) {
        row[k] = (row[k] as number) - factor * (pivotRow[k] as number);
      }
    }
  }
  return [0, 1, 2].map((i) => ((A[i] as number[])[3] as number) / ((A[i] as number[])[i] as number));
}
