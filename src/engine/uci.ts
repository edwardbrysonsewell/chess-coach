import type { BestMove, PvLine, Score } from './types.js';

/**
 * Parsers for the UCI lines we care about. Kept pure and separate from the
 * engine wrapper so they can be tested against real captured output without
 * booting a 7 MB wasm module.
 */

/** Parse an `info` line, or return null if it carries no principal variation. */
export function parseInfoLine(line: string): PvLine | null {
  if (!line.startsWith('info ')) return null;
  const tokens = line.split(/\s+/);

  let depth: number | undefined;
  let rank = 1;
  let score: Score | undefined;
  let nodes: number | undefined;
  let nps: number | undefined;
  let timeMs: number | undefined;
  let moves: string[] | undefined;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case 'depth':
        depth = num(tokens[++i]);
        break;
      case 'multipv':
        rank = num(tokens[++i]) ?? 1;
        break;
      case 'nodes':
        nodes = num(tokens[++i]);
        break;
      case 'nps':
        nps = num(tokens[++i]);
        break;
      case 'time':
        timeMs = num(tokens[++i]);
        break;
      case 'score': {
        const kind = tokens[++i];
        const value = num(tokens[++i]);
        if (value === undefined) break;
        if (kind === 'cp') score = { kind: 'cp', cp: value };
        else if (kind === 'mate') score = { kind: 'mate', moves: value };
        break;
      }
      case 'pv':
        // `pv` is always last; everything after it is the variation.
        moves = tokens.slice(i + 1).filter((m) => m.length >= 4);
        i = tokens.length;
        break;
      default:
        break;
    }
  }

  if (!moves?.length || !score || depth === undefined) return null;
  return {
    rank,
    depth,
    score,
    moves,
    ...(nodes !== undefined ? { nodes } : {}),
    ...(nps !== undefined ? { nps } : {}),
    ...(timeMs !== undefined ? { timeMs } : {}),
  };
}

/** Parse a `bestmove` line. Returns null for `bestmove (none)`. */
export function parseBestMove(line: string): BestMove | null {
  if (!line.startsWith('bestmove')) return null;
  const tokens = line.split(/\s+/);
  const uci = tokens[1];
  if (!uci || uci === '(none)') return null;
  const ponderIndex = tokens.indexOf('ponder');
  const ponder = ponderIndex > 0 ? tokens[ponderIndex + 1] : undefined;
  return { uci, ...(ponder ? { ponder } : {}) };
}

/**
 * Centipawn value for comparing candidate moves, from the moving side's point
 * of view. Mates become large finite numbers so that a faster mate outranks a
 * slower one and any mate outranks any material score.
 */
export function scoreToCp(score: Score): number {
  if (score.kind === 'cp') return score.cp;
  const magnitude = 100_000 - Math.abs(score.moves) * 100;
  return score.moves > 0 ? magnitude : -magnitude;
}

/**
 * Rough win probability for the moving side, used by the coach to classify
 * moves in a way that reflects how much a change actually matters. The 1/350
 * scale is the widely used logistic fit; the README documents it where the
 * accuracy figure is defined.
 */
export function winProbability(score: Score): number {
  const cp = score.kind === 'mate' ? (score.moves > 0 ? 10_000 : -10_000) : score.cp;
  return 1 / (1 + Math.exp(-cp / 350));
}

function num(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const n = Number(token);
  return Number.isFinite(n) ? n : undefined;
}
