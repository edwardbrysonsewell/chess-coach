import { Position } from '../core/position.js';
import type { Color, MoveInfo, PieceSymbol } from '../core/types.js';
import type { UciEngine } from '../engine/engine.js';
import { scoreToCp, winProbability } from '../engine/uci.js';
import type { Score } from '../engine/types.js';
import { accuracyFromLosses, classifyMove, qualityLabel, type Judgement } from './classify.js';
import { identifyOpening } from './openings.js';
import { threatsAfter, type Motif } from './motifs.js';
import { describeMotif } from './language.js';
import { positionalNote } from './positional.js';

/**
 * Post-game review.
 *
 * Walks the game once with the engine, classifies every move, finds the moments
 * that actually decided it, and writes them up. The explanations come from the
 * same motif detector the live warnings use, so the review can say what was
 * missed rather than only that something was.
 */

export interface ReviewedMove {
  readonly ply: number;
  readonly san: string;
  readonly uci: string;
  readonly color: Color;
  /** Evaluation after the move, from White's point of view, for the graph. */
  readonly evalCp: number;
  readonly judgement: Judgement;
  /** The engine's preferred move instead, in SAN, when it differs. */
  readonly betterMove?: string;
  /** What the better move would have achieved, when nameable. */
  readonly explanation?: string;
}

export interface GameReview {
  readonly moves: readonly ReviewedMove[];
  readonly accuracy: { readonly you: number; readonly bot: number };
  readonly opening: { readonly eco: string; readonly name: string; readonly plan: string } | null;
  /** The three moments that changed the game most, worst first. */
  readonly turningPoints: readonly ReviewedMove[];
  readonly counts: Readonly<Record<string, number>>;
  /** One closing sentence in the coach's voice. */
  readonly summary: string;
}

export interface ReviewOptions {
  readonly humanColor: Color;
  readonly elo: number;
  /** Nodes per position. Kept modest: this runs on a phone. */
  readonly nodes?: number;
  readonly onProgress?: (done: number, total: number) => void;
}

export async function reviewGame(
  engine: UciEngine,
  startFen: string,
  moves: readonly MoveInfo[],
  options: ReviewOptions
): Promise<GameReview> {
  const nodes = options.nodes ?? 120_000;
  const position = new Position(startFen);
  const reviewed: ReviewedMove[] = [];
  const humanLosses: number[] = [];
  const botLosses: number[] = [];

  for (let ply = 0; ply < moves.length; ply++) {
    const move = moves[ply] as MoveInfo;
    const mover = position.turn();

    // What was available before the move, and what the move actually gave.
    const beforeLines = await engine.evaluate(position.fen(), { multiPv: 1, nodes });
    const beforeScore = beforeLines[0]?.score ?? ({ kind: 'cp', cp: 0 } as Score);
    const engineBest = beforeLines[0]?.moves[0];

    const played = position.play({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
    if (!played) break; // the move list disagrees with the rules; stop rather than guess

    const afterLines = await engine.evaluate(position.fen(), { multiPv: 1, nodes });
    const afterFromOpponent = afterLines[0]?.score ?? ({ kind: 'cp', cp: 0 } as Score);
    const afterScore = flip(afterFromOpponent);

    const judgement = classifyMove({
      before: beforeScore,
      after: afterScore,
      wasBestMove: engineBest === played.uci,
      elo: options.elo,
      sacrificedMaterial: played.isCapture === false && wasSacrifice(position, played),
    });

    const evalCp = mover === 'w' ? scoreToCp(afterScore) : -scoreToCp(afterScore);

    let betterMove: string | undefined;
    let explanation: string | undefined;
    if (engineBest && engineBest !== played.uci && judgement.quality !== 'good') {
      const before = new Position(played.before);
      const probe = before.clone();
      const bestPlayed = probe.play({
        from: engineBest.slice(0, 2),
        to: engineBest.slice(2, 4),
        ...(engineBest.length > 4 ? { promotion: engineBest[4] as PieceSymbol } : {}),
      });
      if (bestPlayed) {
        betterMove = bestPlayed.san;
        const motifs: Motif[] = threatsAfter(before, engineBest, mover);
        const motif = motifs[0];
        if (motif) {
          const clause = describeMotif(probe, motif, 'their');
          if (clause) explanation = `${bestPlayed.san} would ${clause}.`;
        }
      }
    }

    reviewed.push({
      ply,
      san: played.san,
      uci: played.uci,
      color: mover,
      evalCp: Math.max(-1500, Math.min(1500, evalCp)),
      judgement,
      ...(betterMove ? { betterMove } : {}),
      ...(explanation ? { explanation } : {}),
    });

    if (mover === options.humanColor) humanLosses.push(judgement.winProbabilityLoss);
    else botLosses.push(judgement.winProbabilityLoss);

    options.onProgress?.(ply + 1, moves.length);
  }

  const opening = identifyOpening(moves.map((m) => m.san));
  const counts: Record<string, number> = {};
  for (const move of reviewed) {
    if (move.color !== options.humanColor) continue;
    counts[move.judgement.quality] = (counts[move.judgement.quality] ?? 0) + 1;
  }

  const turningPoints = [...reviewed]
    .filter((m) => m.color === options.humanColor)
    .filter((m) => m.judgement.quality === 'blunder' || m.judgement.quality === 'mistake')
    .sort((a, b) => b.judgement.winProbabilityLoss - a.judgement.winProbabilityLoss)
    .slice(0, 3)
    .sort((a, b) => a.ply - b.ply);

  const accuracy = {
    you: accuracyFromLosses(humanLosses),
    bot: accuracyFromLosses(botLosses),
  };

  return {
    moves: reviewed,
    accuracy,
    opening: opening
      ? { eco: opening.entry.eco, name: opening.entry.name, plan: opening.entry.plan }
      : null,
    turningPoints,
    counts,
    summary: summarise(accuracy.you, counts, opening?.entry.name ?? null, reviewed, options),
  };
}

/** Move number as a player writes it, e.g. "12..." for Black's twelfth. */
export function moveLabel(ply: number, color: Color): string {
  const number = Math.floor(ply / 2) + 1;
  return color === 'w' ? `${number}.` : `${number}...`;
}

/** A closing sentence: warm, specific, and never congratulatory about nothing. */
function summarise(
  accuracy: number,
  counts: Readonly<Record<string, number>>,
  openingName: string | null,
  reviewed: readonly ReviewedMove[],
  options: ReviewOptions
): string {
  const blunders = counts['blunder'] ?? 0;
  const mistakes = counts['mistake'] ?? 0;
  const best = (counts['best'] ?? 0) + (counts['brilliant'] ?? 0) + (counts['great'] ?? 0);
  const opening = openingName ? `You played the ${openingName}. ` : '';

  // The most useful thing to say is usually about the biggest recurring problem.
  const lastPosition = reviewed.length
    ? null
    : null;
  void lastPosition;
  void options;

  if (blunders === 0 && mistakes === 0) {
    return `${opening}No blunders and no mistakes — ${accuracy}% accuracy. That is a clean game.`;
  }
  if (blunders === 0) {
    return (
      `${opening}No outright blunders, ${mistakes} ${plural(mistakes, 'mistake')}, ` +
      `and ${best} ${plural(best, 'move')} the engine would have chosen itself. ` +
      `${accuracy}% accuracy — the shape of the game was right.`
    );
  }
  return (
    `${opening}${accuracy}% accuracy, with ${blunders} ${plural(blunders, 'blunder')} ` +
    `${mistakes > 0 ? `and ${mistakes} ${plural(mistakes, 'mistake')} ` : ''}` +
    `to look at below. Those are the moves worth ten minutes each.`
  );
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function flip(score: Score): Score {
  return score.kind === 'cp'
    ? { kind: 'cp', cp: -score.cp }
    : { kind: 'mate', moves: -score.moves };
}

/**
 * Did the move give up material the engine nonetheless likes? Used only to
 * reserve the word "brilliant" for a genuine sacrifice.
 */
function wasSacrifice(after: Position, move: MoveInfo): boolean {
  const attackers = after.attackersOf(move.to, after.turn());
  if (!attackers.length) return false;
  const defenders = after.attackersOf(move.to, move.color);
  return defenders.length === 0;
}

/** Win probability from White's point of view, for the evaluation graph. */
export function graphPoint(evalCp: number): number {
  return winProbability({ kind: 'cp', cp: evalCp });
}

export { qualityLabel };
