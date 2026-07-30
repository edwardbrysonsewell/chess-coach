import { Position } from './position.js';
import { GameTree, type TreeNode } from './variation.js';

/** A parsed PGN: its tags, its move tree, and its result token. */
export interface PgnGame {
  readonly headers: Record<string, string>;
  readonly tree: GameTree;
  readonly result: string;
}

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

/**
 * Write a game as PGN, including variations as parenthesised sub-lines and
 * comments in braces. A non-standard starting position emits the FEN and SetUp
 * tags, without which the file would silently mean a different game.
 */
export function writePgn(
  tree: GameTree,
  headers: Record<string, string> = {},
  result = '*'
): string {
  const start = tree.fenAtStart();
  const tags: Record<string, string> = { ...headers };
  if (start !== Position.START_FEN) {
    tags['SetUp'] = '1';
    tags['FEN'] = start;
  }
  tags['Result'] = result;

  const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'SetUp', 'FEN'];
  const keys = [
    ...order.filter((k) => k in tags),
    ...Object.keys(tags).filter((k) => !order.includes(k)),
  ];
  const headerText = keys.map((k) => `[${k} "${tags[k] ?? ''}"]`).join('\n');

  const { number: startNumber, whiteToMove } = startCounters(start);
  const tokens = renderChildren(tree.root, startNumber, whiteToMove, true);
  tokens.push(result);

  return `${headerText}\n\n${wrap(tokens, 80)}\n`;
}

/**
 * Parse a PGN into a game tree. Handles tags, comments, NAGs, nested
 * variations, and a SetUp/FEN starting position. Throws on a move that is not
 * legal in the position it appears in, because silently dropping moves would
 * turn a corrupt file into a plausible wrong game.
 */
export function readPgn(text: string): PgnGame {
  const headers: Record<string, string> = {};
  const tagRe = /\[\s*(\w+)\s*"([^"]*)"\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) headers[m[1] as string] = m[2] as string;

  const bodyStart = text.lastIndexOf(']') + 1;
  const body = bodyStart > 0 ? text.slice(bodyStart) : text;

  const startFen = headers['FEN'] ?? Position.START_FEN;
  const tree = new GameTree(startFen);

  let result = headers['Result'] ?? '*';
  // Each stack entry is the node to return to when a variation closes.
  const stack: TreeNode[] = [];
  let lastPlayed: TreeNode | null = null;

  for (const token of tokenise(body)) {
    if (token.kind === 'comment') {
      const target = tree.current();
      target.comment = target.comment ? `${target.comment} ${token.text}` : token.text;
      continue;
    }
    if (token.kind === 'open') {
      // A variation is an alternative to the move just played, so step back.
      if (!lastPlayed) throw new Error('variation opened before any move');
      stack.push(lastPlayed);
      tree.goTo(lastPlayed.parent ?? tree.root);
      continue;
    }
    if (token.kind === 'close') {
      const back = stack.pop();
      if (!back) throw new Error('unbalanced ) in PGN');
      tree.goTo(back);
      lastPlayed = back;
      continue;
    }
    if (token.kind === 'result') {
      result = token.text;
      continue;
    }
    // token.kind === 'move'
    const node = tree.play(token.text);
    if (!node) {
      throw new Error(
        `illegal move "${token.text}" in PGN at ply ${tree.current().ply + 1} ` +
          `(position ${tree.current().fen})`
      );
    }
    lastPlayed = node;
  }

  if (stack.length) throw new Error('unbalanced ( in PGN');
  tree.goToStart();
  return { headers, tree, result };
}

type Token =
  | { kind: 'move'; text: string }
  | { kind: 'comment'; text: string }
  | { kind: 'result'; text: string }
  | { kind: 'open' }
  | { kind: 'close' };

function* tokenise(body: string): Generator<Token> {
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '{') {
      const end = body.indexOf('}', i);
      const stop = end === -1 ? body.length : end;
      yield { kind: 'comment', text: body.slice(i + 1, stop).trim() };
      i = stop + 1;
      continue;
    }
    if (ch === ';') {
      // Rest-of-line comment.
      const end = body.indexOf('\n', i);
      const stop = end === -1 ? body.length : end;
      yield { kind: 'comment', text: body.slice(i + 1, stop).trim() };
      i = stop + 1;
      continue;
    }
    if (ch === '(') {
      yield { kind: 'open' };
      i++;
      continue;
    }
    if (ch === ')') {
      yield { kind: 'close' };
      i++;
      continue;
    }
    const word = /^[^\s(){};]+/.exec(body.slice(i))?.[0] ?? '';
    i += word.length || 1;
    if (!word) continue;
    if (RESULTS.has(word)) {
      yield { kind: 'result', text: word };
      continue;
    }
    if (word.startsWith('$')) continue; // NAG; kept out of the tree for now.
    // Move numbers: "12." "12..." and the digits-only form when spaced apart.
    const stripped = word.replace(/^\d+\.*/, '');
    if (stripped === '') continue;
    yield { kind: 'move', text: stripped };
  }
}

function renderChildren(
  node: TreeNode,
  moveNumber: number,
  whiteToMove: boolean,
  forceNumber: boolean
): string[] {
  const out: string[] = [];
  const main = node.children[0];
  if (!main?.move) return out;

  if (whiteToMove) out.push(`${moveNumber}.`);
  else if (forceNumber) out.push(`${moveNumber}...`);
  out.push(main.move.san);
  if (main.comment) out.push(`{${main.comment}}`);

  let needsNumber = Boolean(main.comment);
  for (const alt of node.children.slice(1)) {
    out.push(
      '(' +
        renderChildren(
          { ...node, children: [alt] },
          moveNumber,
          whiteToMove,
          true
        ).join(' ') +
        ')'
    );
    needsNumber = true;
  }

  out.push(
    ...renderChildren(
      main,
      whiteToMove ? moveNumber : moveNumber + 1,
      !whiteToMove,
      needsNumber
    )
  );
  return out;
}

function startCounters(fen: string): { number: number; whiteToMove: boolean } {
  const parts = fen.split(/\s+/);
  return {
    number: Number(parts[5] ?? '1') || 1,
    whiteToMove: (parts[1] ?? 'w') === 'w',
  };
}

/** Wrap tokens to a line width, as PGN readers expect. */
function wrap(tokens: string[], width: number): string {
  const lines: string[] = [];
  let line = '';
  for (const t of tokens) {
    if (line === '') line = t;
    else if (line.length + 1 + t.length <= width) line += ` ${t}`;
    else {
      lines.push(line);
      line = t;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
