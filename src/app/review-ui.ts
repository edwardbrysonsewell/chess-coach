import type { GameReview, ReviewedMove } from '../coach/review.js';
import { moveLabel } from '../coach/review.js';
import { qualityColour, qualityLabel } from '../coach/classify.js';
import { graphPoint } from '../coach/review.js';
import type { Color } from '../core/types.js';

/**
 * The post-game review screen.
 *
 * Order is deliberate: the number first, then the shape of the game, then the
 * two or three moments that actually decided it. A wall of every move's label is
 * data, not teaching — the turning points are the lesson, so they get the space.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function buildReview(
  body: HTMLElement,
  review: GameReview,
  humanColor: Color,
  onJumpToPly: (ply: number) => void
): void {
  body.append(
    accuracyRow(review),
    evaluationGraph(review, humanColor),
    ...(review.opening ? [openingBlock(review)] : []),
    summaryBlock(review),
    ...turningPointBlocks(review, onJumpToPly),
    breakdown(review)
  );
}

function accuracyRow(review: GameReview): HTMLElement {
  const row = document.createElement('div');
  row.className = 'review-accuracy';
  for (const [label, value] of [
    ['You', review.accuracy.you],
    ['Bot', review.accuracy.bot],
  ] as const) {
    const card = document.createElement('div');
    card.className = 'review-accuracy-card';
    const name = document.createElement('span');
    name.className = 'review-accuracy-label';
    name.textContent = label;
    const figure = document.createElement('span');
    figure.className = 'review-accuracy-value';
    figure.textContent = `${value}%`;
    card.append(name, figure);
    row.append(card);
  }
  return row;
}

/**
 * Evaluation across the game, from White's point of view, drawn as a filled
 * area. Blunders are marked, so the graph is a map to the turning points rather
 * than decoration.
 */
function evaluationGraph(review: GameReview, humanColor: Color): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'review-graph';

  const width = 100;
  const height = 34;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `Evaluation graph across ${review.moves.length} moves, from White's point of view`
  );

  const points = review.moves.map((move, i) => {
    const x = review.moves.length <= 1 ? 0 : (i / (review.moves.length - 1)) * width;
    // graphPoint is White's win probability; y is inverted for screen space.
    const y = height - graphPoint(move.evalCp) * height;
    return { x, y, move };
  });

  // Midline at equality, so "who is better" is readable at a glance.
  const mid = document.createElementNS(SVG_NS, 'line');
  mid.setAttribute('x1', '0');
  mid.setAttribute('x2', String(width));
  mid.setAttribute('y1', String(height / 2));
  mid.setAttribute('y2', String(height / 2));
  mid.setAttribute('stroke', 'currentColor');
  mid.setAttribute('stroke-width', '0.3');
  mid.setAttribute('opacity', '0.35');

  const area = document.createElementNS(SVG_NS, 'path');
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  area.setAttribute('d', `${line} L${width},${height} L0,${height} Z`);
  area.setAttribute('fill', 'currentColor');
  area.setAttribute('opacity', '0.16');

  const stroke = document.createElementNS(SVG_NS, 'path');
  stroke.setAttribute('d', line);
  stroke.setAttribute('fill', 'none');
  stroke.setAttribute('stroke', 'currentColor');
  stroke.setAttribute('stroke-width', '0.7');

  svg.append(mid, area, stroke);

  for (const { x, y, move } of points) {
    if (move.color !== humanColor) continue;
    if (move.judgement.quality !== 'blunder' && move.judgement.quality !== 'mistake') continue;
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(y));
    dot.setAttribute('r', '1.1');
    dot.setAttribute('fill', qualityColour(move.judgement.quality));
    svg.append(dot);
  }

  const caption = document.createElement('p');
  caption.className = 'review-caption';
  caption.textContent = 'Higher is better for White. Marked dots are your mistakes and blunders.';

  wrap.append(svg, caption);
  return wrap;
}

function openingBlock(review: GameReview): HTMLElement {
  const block = document.createElement('div');
  block.className = 'review-block';
  const title = document.createElement('h3');
  title.className = 'review-block-title';
  title.textContent = `${review.opening?.name} (${review.opening?.eco})`;
  const plan = document.createElement('p');
  plan.className = 'review-text';
  plan.textContent = review.opening?.plan ?? '';
  block.append(title, plan);
  return block;
}

function summaryBlock(review: GameReview): HTMLElement {
  const block = document.createElement('p');
  block.className = 'review-summary';
  block.textContent = review.summary;
  return block;
}

function turningPointBlocks(
  review: GameReview,
  onJumpToPly: (ply: number) => void
): HTMLElement[] {
  if (!review.turningPoints.length) return [];
  const heading = document.createElement('h3');
  heading.className = 'review-block-title';
  heading.textContent =
    review.turningPoints.length === 1 ? 'The turning point' : 'The turning points';

  const blocks = review.turningPoints.map((move) => turningPoint(move, onJumpToPly));
  return [heading, ...blocks];
}

function turningPoint(move: ReviewedMove, onJumpToPly: (ply: number) => void): HTMLElement {
  const block = document.createElement('button');
  block.className = 'review-turning';
  block.type = 'button';
  block.style.borderLeftColor = qualityColour(move.judgement.quality);

  const header = document.createElement('div');
  header.className = 'review-turning-header';
  const label = document.createElement('span');
  label.className = 'review-turning-move';
  label.textContent = `${moveLabel(move.ply, move.color)} ${move.san}`;
  const tag = document.createElement('span');
  tag.className = 'review-turning-tag';
  tag.textContent = qualityLabel(move.judgement.quality);
  tag.style.color = qualityColour(move.judgement.quality);
  header.append(label, tag);

  const text = document.createElement('p');
  text.className = 'review-text';
  const swing = Math.round(move.judgement.winProbabilityLoss * 100);
  if (move.betterMove && move.explanation) {
    text.textContent = `${move.betterMove} was the move — ${move.explanation.replace(/^[^ ]+ would /, 'it would ')} Instead this handed over about ${swing}% of the game.`;
  } else if (move.betterMove) {
    text.textContent = `${move.betterMove} would have held things together; this gave up about ${swing}% of the game.`;
  } else {
    text.textContent = `This swung the position by about ${swing}%.`;
  }

  block.append(header, text);
  block.addEventListener('click', () => onJumpToPly(move.ply));
  return block;
}

function breakdown(review: GameReview): HTMLElement {
  const block = document.createElement('div');
  block.className = 'review-breakdown';
  const order = ['brilliant', 'great', 'best', 'good', 'inaccuracy', 'mistake', 'blunder'] as const;
  for (const quality of order) {
    const count = review.counts[quality] ?? 0;
    if (!count) continue;
    const row = document.createElement('div');
    row.className = 'review-breakdown-row';
    const dot = document.createElement('span');
    dot.className = 'review-dot';
    dot.style.background = qualityColour(quality);
    const name = document.createElement('span');
    name.textContent = qualityLabel(quality);
    const value = document.createElement('span');
    value.className = 'review-breakdown-count';
    value.textContent = String(count);
    row.append(dot, name, value);
    block.append(row);
  }
  return block;
}
