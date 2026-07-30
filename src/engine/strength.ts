import { Position } from '../core/position.js';
import type { Color, PieceSymbol, Square } from '../core/types.js';
import { scoreToCp } from './uci.js';
import type { PvLine } from './types.js';

/**
 * The Elo dial.
 *
 * At 1320 and above, Stockfish's own UCI_LimitStrength/UCI_Elo does the work —
 * it is calibrated by the Stockfish project and there is no reason to
 * second-guess it.
 *
 * Below 1320 it bottoms out, so the handicap is ours. The design goal is a
 * *human beginner*, not a randomiser, and the difference lives in three places:
 *
 *  1. A wide MultiPV search gives us a score for most legal moves, so a weak
 *     move is chosen knowing how weak it is.
 *  2. Normal moves are sampled from a softmax over centipawn loss. A low rung
 *     has a high temperature, so it drifts into mediocre moves constantly, the
 *     way a beginner does — it does not alternate between perfect and insane.
 *  3. Real blunders are drawn from a loss *band* and weighted by how tempting
 *     the move looks to a human: captures, checks, promotions, moves that
 *     attack something. A beginner grabs a defended pawn, chases a queen into a
 *     fork, or misses that a piece was hanging. A beginner does not shuffle a
 *     rook to a random corner, and that exclusion is the whole quality bar.
 */
export interface RungConfig {
  readonly elo: number;
  /** How the handicap is produced. */
  readonly mode: 'sampled' | 'limitStrength';
  /** Search budget in nodes. Small budgets also shorten the horizon. */
  readonly nodes: number;
  /** How many candidate lines to ask for; capped by the legal move count. */
  readonly multiPv: number;
  /** Softmax temperature in centipawns for ordinary move choice. */
  readonly temperatureCp: number;
  /** Chance per move of deliberately choosing from the blunder band. */
  readonly blunderRate: number;
  /** Centipawn-loss window a blunder is drawn from, inclusive. */
  readonly blunderBandCp: readonly [number, number];
  /** Stockfish's own rating, for 1320 and above. */
  readonly uciElo?: number;
  /** Thinking-time envelope in ms, before position-complexity scaling. */
  readonly thinkMs: readonly [number, number];
}

/**
 * Fifteen rungs.
 *
 * The temperatures below 1320 are FITTED, not chosen. A first attempt used
 * plausible-looking numbers and measured catastrophically wrong: a nominal
 * 150-point step from 1000 to 1150 turned out to be 512 Elo, and the nominal
 * 1150 rung lost 30 games out of 30 to the 1320 anchor. A temperature sweep
 * against that anchor (40 games per point, blunders disabled to isolate the
 * variable) produced the curve these values come from:
 *
 *     temperature   score vs 1320   implied rating
 *          4 cp          26.3%           ~1141
 *          8 cp          15.0%           ~1019
 *         14 cp           8.8%            ~914
 *         22 cp           5.0%            ~808
 *         45 cp           1.3%            ~568
 *
 * A second round of 840 games then fitted both levers at once
 * (tools/fit-ladder.ts):
 *
 *     Elo = 1476 - 160.5 * sqrt(temperature) - 6115 * blunderRate
 *     residual RMS 83 Elo over 12 measured configurations
 *
 * The decisive finding is that BLUNDER RATE dominates: roughly 61 Elo per one
 * percent. That matches how beginners' ratings actually work - a weak player is
 * weak because of how often they throw a piece away, not because of small
 * inaccuracies - so blunder rate is the primary dial here and temperature is a
 * secondary fuzziness dial. The values below come from inverting that model.
 *
 * Two honest caveats. The intercept is a fitting constant, not a claim about an
 * unhandicapped engine; the model is only trustworthy inside the measured band
 * (temperature 3-105, blunder rate 0-0.20). And every absolute number inherits
 * whatever error sits in Stockfish's own UCI_Elo calibration, since rung 1320 is
 * the anchor the whole chain hangs from.
 *
 * Node counts are held near-uniform across the sampled band deliberately:
 * keeping few variables in charge is what makes the ladder calibratable at all.
 *
 * Anything below roughly 570 cannot be measured against the 1320 anchor - the
 * score floor is zero - so low rungs are measured against a calibrated middle
 * rung and chained. See tools/calibrate-report.ts.
 *
 * MEASURED RESULT of the values below, 1080 games, 120 per match, 2026-07-29:
 *
 *     labelled   measured   match it came from
 *         250        313    9.2% vs rung 700
 *         400        394    25.8% vs rung 550
 *         550        577    31.7% vs rung 700
 *         700        711    2.9% vs rung 1320
 *         850        873    34.2% vs rung 1000
 *        1000        987    37.1% vs rung 1150
 *        1150       1079    20.0% vs rung 1320
 *        1320       1320    anchor
 *
 * Every rung lands within 71 Elo of its label and most within 30, against
 * per-match standard errors of 33 to 55 Elo. One honest wrinkle: Elo is not
 * perfectly transitive over wide gaps, so rung 250 reads 313 measured directly
 * against 700 but 175 when chained up through 400 and 550. Treat it as roughly
 * 250 give or take 70 rather than a single figure.
 *
 * Rungs 1500 and above are Stockfish's own UCI_Elo used faithfully, and are NOT
 * independently verified here.
 */
export const LADDER: readonly RungConfig[] = [
  { elo: 250,  mode: 'sampled', nodes: 50_000, multiPv: 24, temperatureCp: 15, blunderRate: 0.099, blunderBandCp: [200, 1200], thinkMs: [350, 900] },
  { elo: 400,  mode: 'sampled', nodes: 50_000, multiPv: 20, temperatureCp: 13, blunderRate: 0.081, blunderBandCp: [180, 900],  thinkMs: [400, 1000] },
  { elo: 550,  mode: 'sampled', nodes: 50_000, multiPv: 18, temperatureCp: 11, blunderRate: 0.064, blunderBandCp: [160, 700],  thinkMs: [450, 1100] },
  { elo: 700,  mode: 'sampled', nodes: 50_000, multiPv: 16, temperatureCp: 9,  blunderRate: 0.048, blunderBandCp: [150, 550],  thinkMs: [500, 1200] },
  { elo: 850,  mode: 'sampled', nodes: 50_000, multiPv: 14, temperatureCp: 7,  blunderRate: 0.033, blunderBandCp: [140, 450],  thinkMs: [550, 1300] },
  { elo: 1000, mode: 'sampled', nodes: 50_000, multiPv: 12, temperatureCp: 5,  blunderRate: 0.019, blunderBandCp: [130, 350],  thinkMs: [600, 1500] },
  { elo: 1150, mode: 'sampled', nodes: 60_000, multiPv: 12, temperatureCp: 3,  blunderRate: 0.008, blunderBandCp: [120, 300],  thinkMs: [700, 1700] },
  { elo: 1320, mode: 'limitStrength', uciElo: 1320, nodes: 90_000,  multiPv: 1, temperatureCp: 0, blunderRate: 0, blunderBandCp: [0, 0], thinkMs: [700, 1800] },
  { elo: 1500, mode: 'limitStrength', uciElo: 1500, nodes: 120_000, multiPv: 1, temperatureCp: 0, blunderRate: 0, blunderBandCp: [0, 0], thinkMs: [800, 1900] },
  { elo: 1700, mode: 'limitStrength', uciElo: 1700, nodes: 160_000, multiPv: 1, temperatureCp: 0, blunderRate: 0, blunderBandCp: [0, 0], thinkMs: [900, 2100] },
  { elo: 1900, mode: 'limitStrength', uciElo: 1900, nodes: 220_000, multiPv: 1, temperatureCp: 0, blunderRate: 0, blunderBandCp: [0, 0], thinkMs: [1000, 2300] },
  { elo: 2100, mode: 'limitStrength', uciElo: 2100, nodes: 320_000, multiPv: 1, temperatureCp: 0, blunderRate: 0, blunderBandCp: [0, 0], thinkMs: [1100, 2600] },
  { elo: 2300, mode: 'limitStrength', uciElo: 2300, nodes: 500_000, multiPv: 1, temperatureCp: 0, blunderRate: 0, blunderBandCp: [0, 0], thinkMs: [1300, 3000] },
  { elo: 2500, mode: 'limitStrength', uciElo: 2500, nodes: 800_000, multiPv: 1, temperatureCp: 0, blunderRate: 0, blunderBandCp: [0, 0], thinkMs: [1500, 3500] },
  { elo: 2800, mode: 'limitStrength', uciElo: 2800, nodes: 1_500_000, multiPv: 1, temperatureCp: 0, blunderRate: 0, blunderBandCp: [0, 0], thinkMs: [1800, 4200] },
];

/** The rung at or nearest below `elo`. */
export function rungFor(elo: number): RungConfig {
  let chosen = LADDER[0] as RungConfig;
  for (const rung of LADDER) if (rung.elo <= elo) chosen = rung;
  return chosen;
}

/** Deterministic random source, so calibration runs and tests are repeatable. */
export type Rng = () => number;

/** Mulberry32 — small, fast, good enough, and seedable. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Candidate {
  readonly uci: string;
  /** Centipawns from the mover's point of view. */
  readonly cp: number;
  /** Centipawns worse than the best available move. Always >= 0. */
  readonly lossCp: number;
}

/** Turn MultiPV output into candidates ranked by loss against the best line. */
export function toCandidates(lines: readonly PvLine[]): Candidate[] {
  const scored = lines
    .filter((l) => l.moves.length > 0)
    .map((l) => ({ uci: l.moves[0] as string, cp: scoreToCp(l.score) }));
  if (!scored.length) return [];
  const bestCp = Math.max(...scored.map((s) => s.cp));
  return scored
    .map((s) => ({ ...s, lossCp: bestCp - s.cp }))
    .sort((a, b) => a.lossCp - b.lossCp);
}

const PIECE_VALUE: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

/**
 * How tempting a move looks to a beginner, independent of whether it is good.
 * Higher is more tempting. This is what stops a "blunder" from being a move no
 * human would ever consider.
 */
export function temptation(position: Position, uci: string): number {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? (uci[4] as PieceSymbol) : undefined;

  const mover = position.turn();
  const moved = position.pieceAt(from);
  if (!moved) return 0;

  const probe = position.clone();
  const made = probe.play({ from, to, ...(promotion ? { promotion } : {}) });
  if (!made) return 0;

  let score = 0;

  // Taking things is the single strongest pull, and the bigger the better.
  if (made.isCapture) score += 1.5 + 0.6 * PIECE_VALUE[made.captured ?? 'p'];
  // Checks feel forcing even when they achieve nothing.
  if (made.isCheck) score += 1.6;
  if (made.isCheckmate) score += 6;
  if (made.isPromotion) score += 2.2;
  if (made.isCastle) score += 0.6;

  // Attacking a bigger piece looks like a plan.
  const enemy: Color = mover === 'w' ? 'b' : 'w';
  let bestThreat = 0;
  for (const { square, piece } of probe.occupied()) {
    if (piece.color !== enemy) continue;
    if (probe.attackersOf(square, mover).includes(to as Square)) {
      bestThreat = Math.max(bestThreat, PIECE_VALUE[piece.type]);
    }
  }
  if (bestThreat > PIECE_VALUE[moved.type]) score += 1.2;
  else if (bestThreat > 0) score += 0.5;

  // Marching forward feels active; retreating feels like nothing is happening.
  const rankProgress =
    (Number(to[1]) - Number(from[1])) * (mover === 'w' ? 1 : -1);
  score += rankProgress > 0 ? 0.3 * Math.min(rankProgress, 2) : 0.35 * rankProgress;

  // Central squares attract beginners; the rim does not.
  const file = (to.charCodeAt(0) - 97) as number;
  const rank = Number(to[1]) - 1;
  const centrality = 2 - (Math.abs(3.5 - file) + Math.abs(3.5 - rank)) / 2;
  score += 0.18 * centrality;

  // Walking a piece onto a square a pawn can take is the one thing even a
  // beginner usually notices, so make it less tempting - but not impossible,
  // because missing exactly this is how beginners lose pieces.
  const pawnAttackers = probe
    .attackersOf(to, enemy)
    .filter((sq) => probe.pieceAt(sq)?.type === 'p');
  if (pawnAttackers.length && PIECE_VALUE[moved.type] > 1) score -= 0.8;

  return score;
}

/**
 * Pick the move the bot plays.
 *
 * `limitStrength` rungs just take the engine's move — Stockfish already did the
 * handicapping. `sampled` rungs do the work described at the top of this file.
 */
export function chooseMove(
  position: Position,
  lines: readonly PvLine[],
  rung: RungConfig,
  rng: Rng
): string | null {
  const candidates = toCandidates(lines);
  if (!candidates.length) return null;
  const best = candidates[0] as Candidate;
  if (rung.mode === 'limitStrength') return best.uci;

  // A mate available now is taken; beginners do spot mate in one when it is the
  // move they were already looking at, and throwing away a won game here would
  // read as broken rather than weak.
  const mateNow = candidates.find((c) => c.cp >= 90_000);
  if (mateNow && rng() < 0.75) return mateNow.uci;

  if (rng() < rung.blunderRate) {
    const [lo, hi] = rung.blunderBandCp;
    const band = candidates.filter((c) => c.lossCp >= lo && c.lossCp <= hi);
    const tempting = band
      .map((c) => ({ c, weight: Math.exp(temptation(position, c.uci)) }))
      .filter((x) => x.weight > 0);
    // If the position offers no tempting way to go wrong, play normally rather
    // than inventing a nonsense move.
    const picked = weightedPick(tempting, rng);
    if (picked) return picked.c.uci;
  }

  const weighted = candidates.map((c) => ({
    c,
    weight: Math.exp(-c.lossCp / Math.max(rung.temperatureCp, 1)),
  }));
  return weightedPick(weighted, rng)?.c.uci ?? best.uci;
}

/** Thinking time for a move: rung envelope, stretched by how busy the position is. */
export function thinkTimeMs(position: Position, rung: RungConfig, rng: Rng): number {
  const [lo, hi] = rung.thinkMs;
  const base = lo + rng() * (hi - lo);
  const moves = position.legalMoves();
  const forcing = moves.filter((m) => m.isCapture).length;
  // Busy positions get up to ~45% longer, so the bot appears to notice tactics.
  const busyness = Math.min(1, (moves.length / 40) * 0.6 + (forcing / 10) * 0.4);
  return Math.round(base * (0.85 + 0.45 * busyness));
}

/** Engine options a rung needs applied before searching. */
export function optionsFor(rung: RungConfig): Array<[string, string | number | boolean]> {
  if (rung.mode === 'limitStrength') {
    return [
      ['UCI_LimitStrength', true],
      ['UCI_Elo', rung.uciElo ?? rung.elo],
    ];
  }
  // Sampled rungs must see the engine's honest evaluation, otherwise the loss
  // numbers the sampler reasons about are themselves noise.
  return [['UCI_LimitStrength', false]];
}

function weightedPick<T>(
  items: ReadonlyArray<{ c: T; weight: number }>,
  rng: Rng
): { c: T; weight: number } | null {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (!(total > 0)) return null;
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1] ?? null;
}
