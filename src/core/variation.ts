import { Position } from './position.js';
import type { MoveInfo, MoveRequest } from './types.js';

/**
 * One position in the game tree. `move` is the move that reached it, so the
 * root's move is null. `children[0]` is the main continuation; later children
 * are alternatives, which is what explore mode branches into.
 */
export interface TreeNode {
  readonly id: number;
  readonly parent: TreeNode | null;
  readonly move: MoveInfo | null;
  /** Position after `move` — the root holds the starting position. */
  readonly fen: string;
  /** Half-move count from the root. */
  readonly ply: number;
  readonly children: TreeNode[];
  comment?: string;
}

/**
 * A branching move tree with a cursor.
 *
 * Take back is deliberately non-destructive: it moves the cursor, it does not
 * remove nodes. That makes redo free and keeps the engine's view of the game
 * recoverable, which is the thing that usually breaks in undo implementations.
 */
export class GameTree {
  readonly root: TreeNode;
  private cursor: TreeNode;
  private nextId = 1;
  private readonly startFen: string;

  constructor(startFen: string = Position.START_FEN) {
    if (!Position.isValidFen(startFen)) throw new Error(`invalid FEN: ${startFen}`);
    this.startFen = startFen;
    this.root = { id: 0, parent: null, move: null, fen: startFen, ply: 0, children: [] };
    this.cursor = this.root;
  }

  /** The node the cursor sits on. */
  current(): TreeNode {
    return this.cursor;
  }

  /** A fresh Position for the current node — callers may mutate it freely. */
  position(node: TreeNode = this.cursor): Position {
    return new Position(node.fen);
  }

  /**
   * Play a move from the current node and move the cursor onto it. If that move
   * already exists as a child (because it was played, taken back, and played
   * again) the existing branch is reused rather than duplicated.
   *
   * Returns null and leaves the cursor alone if the move is illegal.
   */
  play(move: MoveRequest | string): TreeNode | null {
    const pos = new Position(this.cursor.fen);
    const made = pos.play(move);
    if (!made) return null;

    const existing = this.cursor.children.find((c) => c.move?.uci === made.uci);
    if (existing) {
      this.cursor = existing;
      return existing;
    }

    const node: TreeNode = {
      id: this.nextId++,
      parent: this.cursor,
      move: made,
      fen: pos.fen(),
      ply: this.cursor.ply + 1,
      children: [],
    };
    this.cursor.children.push(node);
    this.cursor = node;
    return node;
  }

  /** Step back one half-move. Returns false at the root. */
  back(): boolean {
    if (!this.cursor.parent) return false;
    this.cursor = this.cursor.parent;
    return true;
  }

  /**
   * Step forward along the main continuation, or into `preferChild` if given.
   * Returns false when there is nothing ahead.
   */
  forward(preferChild?: TreeNode): boolean {
    const next = preferChild ?? this.cursor.children[0];
    if (!next || next.parent !== this.cursor) return false;
    this.cursor = next;
    return true;
  }

  /**
   * Take back `plies` half-moves as one action — two for "undo my move and the
   * bot's reply". Stops at the root and reports how many it actually undid, so
   * the caller never assumes more happened than did.
   */
  takeBack(plies = 2): number {
    let undone = 0;
    while (undone < plies && this.back()) undone++;
    return undone;
  }

  /**
   * Replay `plies` half-moves along the line the cursor was last on. Because
   * take back does not delete, this is exactly the inverse.
   */
  redo(plies = 2): number {
    let done = 0;
    while (done < plies && this.forward()) done++;
    return done;
  }

  goTo(node: TreeNode): void {
    if (this.findRoot(node) !== this.root) throw new Error('node is not in this tree');
    this.cursor = node;
  }

  goToStart(): void {
    this.cursor = this.root;
  }

  /** Follow the main continuation to its end. */
  goToEnd(): void {
    while (this.forward());
  }

  /** Root to the end of the main line, root first. */
  mainline(): TreeNode[] {
    const out: TreeNode[] = [];
    let n: TreeNode | undefined = this.root;
    while (n) {
      out.push(n);
      n = n.children[0];
    }
    return out;
  }

  /** Root to `node`, root first — the moves that actually reached it. */
  pathTo(node: TreeNode): TreeNode[] {
    const out: TreeNode[] = [];
    let n: TreeNode | null = node;
    while (n) {
      out.unshift(n);
      n = n.parent;
    }
    return out;
  }

  isOnMainline(node: TreeNode): boolean {
    let n: TreeNode | null = node;
    while (n?.parent) {
      if (n.parent.children[0] !== n) return false;
      n = n.parent;
    }
    return true;
  }

  /** Make `node`'s line the main continuation at each branch above it. */
  promoteToMainline(node: TreeNode): void {
    let n: TreeNode | null = node;
    while (n?.parent) {
      const siblings = n.parent.children;
      const i = siblings.indexOf(n);
      if (i > 0) {
        siblings.splice(i, 1);
        siblings.unshift(n);
      }
      n = n.parent;
    }
  }

  /**
   * Remove a node and everything after it. If the cursor was inside the removed
   * branch it retreats to the parent, so the cursor is never left dangling.
   */
  remove(node: TreeNode): void {
    if (!node.parent) throw new Error('cannot remove the root');
    const siblings = node.parent.children;
    const i = siblings.indexOf(node);
    if (i < 0) throw new Error('node is not a child of its parent');
    siblings.splice(i, 1);
    if (this.pathTo(this.cursor).includes(node)) this.cursor = node.parent;
  }

  /** Discard everything after the cursor, keeping the moves that led to it. */
  truncateHere(): void {
    this.cursor.children.length = 0;
  }

  fenAtStart(): string {
    return this.startFen;
  }

  /** Total nodes, for tests and diagnostics. */
  size(): number {
    let n = 0;
    const walk = (node: TreeNode): void => {
      n++;
      for (const c of node.children) walk(c);
    };
    walk(this.root);
    return n;
  }

  private findRoot(node: TreeNode): TreeNode {
    let n = node;
    while (n.parent) n = n.parent;
    return n;
  }
}
