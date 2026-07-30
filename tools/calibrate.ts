/**
 * Elo calibration harness. Headless Node, no browser.
 *
 * Plays one match between two rungs of the ladder and writes the result as
 * JSON. Openings are paired: every opening is played twice, once with each side
 * as white, which removes most of the variance that a first-move advantage
 * would otherwise inject into a few hundred games.
 *
 * Usage:
 *   node --import ./tools/register-ts.mjs tools/calibrate.ts \
 *        --pair 400:550 --games 150 --seed 1 --out results/400-550.json
 *
 * Run several pairs concurrently (one process each) and aggregate with
 * tools/calibrate-report.ts.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Position } from '../src/core/position.js';
import { UciEngine } from '../src/engine/engine.js';
import { createNodeTransport } from '../src/engine/transport-node.js';
import { Bot, type EngineOptionState } from '../src/engine/bot.js';
import { makeRng, rungFor, type Rng, type RungConfig } from '../src/engine/strength.js';
import type { PieceSymbol } from '../src/core/types.js';

interface Args {
  pair: [number, number];
  games: number;
  seed: number;
  out: string;
  maxPlies: number;
  openingPlies: number;
  /**
   * Optional overrides applied to player A's rung, so arbitrary settings can be
   * measured against a known anchor without editing the ladder. This is how the
   * ladder's parameters were fitted rather than guessed.
   */
  overrideA: Partial<
    Pick<RungConfig, 'temperatureCp' | 'blunderRate' | 'nodes' | 'multiPv'>
  > & { band?: [number, number] };
}

const args = parseArgs(process.argv.slice(2));

const PIECE_VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** Adjudicate as a win once one side is this many pawns up and stays up. */
const RESIGN_MARGIN = 10;
const RESIGN_PLIES = 6;

type GameResult = 'a' | 'b' | 'draw';

interface MatchResult {
  eloA: number;
  eloB: number;
  games: number;
  aWins: number;
  bWins: number;
  draws: number;
  /** A's score share, draws counting a half. */
  scoreA: number;
  terminations: Record<string, number>;
  meanPlies: number;
  elapsedMs: number;
  /** Exactly what player A was configured with, so a result is reproducible. */
  configA: {
    mode: string;
    temperatureCp: number;
    blunderRate: number;
    nodes: number;
    multiPv: number;
    blunderBandCp: readonly [number, number];
  };
}

async function main(): Promise<void> {
  const [eloA, eloB] = args.pair;
  // One engine, both players. The vendored build's module factory is single-use,
  // so a second in-process instance throws; a shared option cache keeps the two
  // bots from believing stale options are still applied.
  const engine = new UciEngine(await createNodeTransport('lite-single'));
  await engine.init();
  const optionState: EngineOptionState = { appliedElo: null };

  const base = rungFor(eloA);
  const rungA: RungConfig = {
    ...base,
    ...(args.overrideA.temperatureCp !== undefined
      ? { temperatureCp: args.overrideA.temperatureCp }
      : {}),
    ...(args.overrideA.blunderRate !== undefined
      ? { blunderRate: args.overrideA.blunderRate }
      : {}),
    ...(args.overrideA.nodes !== undefined ? { nodes: args.overrideA.nodes } : {}),
    ...(args.overrideA.multiPv !== undefined ? { multiPv: args.overrideA.multiPv } : {}),
    ...(args.overrideA.band !== undefined ? { blunderBandCp: args.overrideA.band } : {}),
  };

  const terminations: Record<string, number> = {};
  let aWins = 0;
  let bWins = 0;
  let draws = 0;
  let plyTotal = 0;
  const started = Date.now();

  // Games come in colour-swapped pairs sharing one opening.
  const pairsToPlay = Math.ceil(args.games / 2);
  for (let i = 0; i < pairsToPlay; i++) {
    const openingSeed = args.seed * 100_003 + i;
    for (const aIsWhite of [true, false]) {
      const botA = new Bot(engine, eloA, makeRng(openingSeed * 7 + 11), optionState);
      const botB = new Bot(engine, eloB, makeRng(openingSeed * 13 + 17), optionState);
      botA.setRung(rungA);
      await engine.newGame();
      const { result, reason, plies } = await playGame(
        botA,
        botB,
        aIsWhite,
        makeRng(openingSeed)
      );
      terminations[reason] = (terminations[reason] ?? 0) + 1;
      plyTotal += plies;
      if (result === 'a') aWins++;
      else if (result === 'b') bWins++;
      else draws++;

      const done = aWins + bWins + draws;
      if (done % 10 === 0) {
        process.stderr.write(
          `${eloA} vs ${eloB}: ${done}/${pairsToPlay * 2} ` +
            `(+${aWins} =${draws} -${bWins})\n`
        );
      }
    }
  }

  const games = aWins + bWins + draws;
  const out: MatchResult = {
    eloA,
    eloB,
    games,
    aWins,
    bWins,
    draws,
    scoreA: (aWins + draws / 2) / games,
    terminations,
    meanPlies: plyTotal / games,
    elapsedMs: Date.now() - started,
    configA: {
      mode: rungA.mode,
      temperatureCp: rungA.temperatureCp,
      blunderRate: rungA.blunderRate,
      nodes: rungA.nodes,
      multiPv: rungA.multiPv,
      blunderBandCp: rungA.blunderBandCp,
    },
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(
    `DONE ${eloA} vs ${eloB}: score ${(out.scoreA * 100).toFixed(1)}% ` +
      `over ${games} games in ${(out.elapsedMs / 1000).toFixed(0)}s\n`
  );

  await engine.quit();
}

async function playGame(
  botA: Bot,
  botB: Bot,
  aIsWhite: boolean,
  openingRng: Rng
): Promise<{ result: GameResult; reason: string; plies: number }> {
  const position = new Position();

  // A short random opening so a few hundred games are not the same game.
  for (let i = 0; i < args.openingPlies; i++) {
    const moves = position.legalMoves();
    const pick = moves[Math.floor(openingRng() * moves.length)];
    if (!pick) break;
    position.play({
      from: pick.from,
      to: pick.to,
      ...(pick.promotion ? { promotion: pick.promotion } : {}),
    });
  }

  let leadPlies = 0;
  let leader: 'a' | 'b' | null = null;

  for (let ply = 0; ply < args.maxPlies; ply++) {
    const outcome = position.outcome();
    if (outcome.over) {
      if (outcome.reason === 'checkmate') {
        const winnerIsWhite = outcome.winner === 'w';
        return {
          result: winnerIsWhite === aIsWhite ? 'a' : 'b',
          reason: 'checkmate',
          plies: ply,
        };
      }
      return { result: 'draw', reason: outcome.reason, plies: ply };
    }

    const whiteToMove = position.turn() === 'w';
    const bot = whiteToMove === aIsWhite ? botA : botB;
    const move = await bot.move(position.fen());
    if (!move) return { result: 'draw', reason: 'no-move', plies: ply };

    const played = position.play({
      from: move.uci.slice(0, 2),
      to: move.uci.slice(2, 4),
      ...(move.uci.length > 4 ? { promotion: move.uci[4] as PieceSymbol } : {}),
    });
    if (!played) {
      throw new Error(`illegal move ${move.uci} from bot in ${position.fen()}`);
    }

    // Adjudicate hopeless games so a few hundred of them finish this decade.
    const balance = materialBalance(position); // + favours white
    const aheadIsA = balance > 0 === aIsWhite;
    if (Math.abs(balance) >= RESIGN_MARGIN) {
      const current: 'a' | 'b' = aheadIsA ? 'a' : 'b';
      leadPlies = leader === current ? leadPlies + 1 : 1;
      leader = current;
      if (leadPlies >= RESIGN_PLIES) {
        return { result: current, reason: 'adjudicated-material', plies: ply };
      }
    } else {
      leadPlies = 0;
      leader = null;
    }
  }

  return { result: 'draw', reason: 'ply-limit', plies: args.maxPlies };
}

/** Material balance in pawns, positive when white is ahead. */
function materialBalance(position: Position): number {
  let balance = 0;
  for (const { piece } of position.occupied()) {
    const v = PIECE_VALUE[piece.type];
    balance += piece.color === 'w' ? v : -v;
  }
  return balance;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key) map.set(key, argv[i + 1] ?? '');
  }
  const pairRaw = (map.get('pair') ?? '').split(':').map(Number);
  if (pairRaw.length !== 2 || pairRaw.some((n) => !Number.isFinite(n))) {
    throw new Error('--pair must look like 400:550');
  }
  const [a, b] = pairRaw as [number, number];
  if (rungFor(a).elo !== a || rungFor(b).elo !== b) {
    throw new Error(`--pair values must be ladder rungs; got ${a} and ${b}`);
  }
  const bandRaw = map.get('bandA');
  const band = bandRaw
    ? (bandRaw.split(':').map(Number) as [number, number])
    : undefined;
  return {
    pair: [a, b],
    games: Number(map.get('games') ?? 100),
    seed: Number(map.get('seed') ?? 1),
    out: map.get('out') ?? `results/${a}-${b}.json`,
    maxPlies: Number(map.get('maxPlies') ?? 200),
    openingPlies: Number(map.get('openingPlies') ?? 4),
    overrideA: {
      ...(map.has('tempA') ? { temperatureCp: Number(map.get('tempA')) } : {}),
      ...(map.has('blunderA') ? { blunderRate: Number(map.get('blunderA')) } : {}),
      ...(map.has('nodesA') ? { nodes: Number(map.get('nodesA')) } : {}),
      ...(map.has('multiPvA') ? { multiPv: Number(map.get('multiPvA')) } : {}),
      ...(band ? { band } : {}),
    },
  };
}

main().catch((e: unknown) => {
  process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
