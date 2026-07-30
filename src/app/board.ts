import { Position } from '../core/position.js';
import type { Color, LegalMove, MoveInfo, PieceSymbol, Square } from '../core/types.js';

/**
 * The board: SVG, drawn by us, driven by a thumb.
 *
 * Both input styles are supported and share one selection model, because a thumb
 * uses both without thinking about it: drag a piece, or tap it and tap a target.
 * A drag that ends where it began falls back to being a tap, which is what makes
 * the two feel like one gesture rather than two modes.
 *
 * This class renders and reports intent. It never decides legality — every legal
 * target it draws comes from the rules layer.
 */

export interface BoardTheme {
  light: string;
  dark: string;
  /** Ring drawn around the piece under the finger. */
  selected: string;
  lastMove: string;
  check: string;
  target: string;
  coordinate: string;
}

export const THEMES: Record<'classic' | 'high-contrast', BoardTheme> = {
  // Muted blue-grey: high luminance separation for sunlight, no mud.
  classic: {
    light: '#eceff3',
    dark: '#7d92ab',
    selected: '#f5c451',
    lastMove: '#cfd86a',
    check: '#e2564b',
    target: '#2f3a46',
    coordinate: '#5b6672',
  },
  'high-contrast': {
    light: '#ffffff',
    dark: '#4a5a6b',
    selected: '#ffd400',
    lastMove: '#b8e986',
    check: '#ff3b30',
    target: '#101418',
    coordinate: '#2b3238',
  },
};

export interface BoardOptions {
  /** Which side is at the bottom. */
  orientation?: Color;
  showCoordinates?: boolean;
  theme?: BoardTheme;
  /** Honour the system reduce-motion preference. */
  reduceMotion?: boolean;
}

export interface BoardCallbacks {
  /** Legal targets for a square; the board never works this out itself. */
  legalMoves(from: Square): LegalMove[];
  /** True if this square holds a piece the human is allowed to pick up. */
  canPickUp(square: Square): boolean;
  /** A move was requested. Return false to reject it (the board will buzz). */
  requestMove(from: Square, to: Square): boolean | Promise<boolean>;
  /** A piece was lifted, for the sound cue. */
  onLift?(square: Square): void;
  /** A drag or tap was abandoned. */
  onCancel?(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

export class BoardView {
  private readonly root: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly layers: {
    squares: SVGGElement;
    highlights: SVGGElement;
    pieces: SVGGElement;
    targets: SVGGElement;
    arrows: SVGGElement;
    drag: SVGGElement;
  };
  private readonly callbacks: BoardCallbacks;
  private options: Required<BoardOptions>;

  private position = new Position();
  private selected: Square | null = null;
  private legalTargets: LegalMove[] = [];
  private lastMove: { from: Square; to: Square } | null = null;
  private checkSquare: Square | null = null;
  private dragging: {
    from: Square;
    pointerId: number;
    node: SVGGElement;
    moved: boolean;
  } | null = null;

  constructor(root: HTMLElement, callbacks: BoardCallbacks, options: BoardOptions = {}) {
    this.root = root;
    this.callbacks = callbacks;
    this.options = {
      orientation: options.orientation ?? 'w',
      showCoordinates: options.showCoordinates ?? true,
      theme: options.theme ?? (THEMES.classic as BoardTheme),
      reduceMotion: options.reduceMotion ?? false,
    };

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.svg.setAttribute('role', 'grid');
    this.svg.setAttribute('aria-label', 'chess board');
    this.svg.style.width = '100%';
    this.svg.style.height = 'auto';
    this.svg.style.display = 'block';
    this.svg.style.touchAction = 'none'; // we handle the gestures
    this.svg.style.userSelect = 'none';
    (this.svg.style as unknown as { webkitTapHighlightColor: string }).webkitTapHighlightColor =
      'transparent';

    this.layers = {
      squares: this.group(),
      highlights: this.group(),
      targets: this.group(),
      pieces: this.group(),
      arrows: this.group(),
      drag: this.group(),
    };
    // Order matters: squares, then highlights, then targets under the pieces,
    // then arrows and the dragged piece on top.
    for (const layer of [
      this.layers.squares,
      this.layers.highlights,
      this.layers.targets,
      this.layers.pieces,
      this.layers.arrows,
      this.layers.drag,
    ]) {
      this.svg.append(layer);
    }

    this.root.append(this.svg);
    this.drawSquares();
    this.attachPointerHandlers();
  }

  setOptions(options: BoardOptions): void {
    this.options = { ...this.options, ...options };
    this.drawSquares();
    this.render();
  }

  orientation(): Color {
    return this.options.orientation;
  }

  flip(): void {
    this.setOptions({ orientation: this.options.orientation === 'w' ? 'b' : 'w' });
  }

  /** Show a position. `lastMove` drives the highlight; pass null to clear it. */
  setPosition(
    position: Position,
    lastMove: { from: Square; to: Square } | null = null
  ): void {
    this.position = position;
    this.lastMove = lastMove;
    this.checkSquare = position.isCheck() ? this.findKing(position.turn()) : null;
    this.clearSelection();
    this.render();
  }

  /** Draw an arrow, for hints and explore mode. */
  drawArrow(from: Square, to: Square, colour = '#3d8bfd'): void {
    const a = this.centre(from);
    const b = this.centre(to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Stop short of the centre so the target piece stays readable.
    const shrink = 0.32;
    const ex = b.x - (dx / len) * shrink;
    const ey = b.y - (dy / len) * shrink;

    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(ex));
    line.setAttribute('y2', String(ey));
    line.setAttribute('stroke', colour);
    line.setAttribute('stroke-width', '0.14');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('opacity', '0.85');

    const head = document.createElementNS(SVG_NS, 'polygon');
    const ux = dx / len;
    const uy = dy / len;
    const size = 0.26;
    const tipX = b.x - ux * 0.12;
    const tipY = b.y - uy * 0.12;
    head.setAttribute(
      'points',
      [
        `${tipX},${tipY}`,
        `${tipX - ux * size - uy * size * 0.6},${tipY - uy * size + ux * size * 0.6}`,
        `${tipX - ux * size + uy * size * 0.6},${tipY - uy * size - ux * size * 0.6}`,
      ].join(' ')
    );
    head.setAttribute('fill', colour);
    head.setAttribute('opacity', '0.85');

    this.layers.arrows.append(line, head);
  }

  clearArrows(): void {
    this.layers.arrows.replaceChildren();
  }

  /** Flash a square, e.g. to name the piece a danger warning is about. */
  pulse(square: Square, colour = '#e2564b'): void {
    const { x, y } = this.topLeft(square);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', '1');
    rect.setAttribute('height', '1');
    rect.setAttribute('fill', colour);
    rect.setAttribute('opacity', '0');
    this.layers.highlights.append(rect);

    if (this.options.reduceMotion) {
      rect.setAttribute('opacity', '0.45');
      setTimeout(() => rect.remove(), 700);
      return;
    }
    const animation = rect.animate(
      [{ opacity: 0 }, { opacity: 0.55 }, { opacity: 0 }],
      { duration: 620, iterations: 2 }
    );
    animation.finished.then(() => rect.remove()).catch(() => rect.remove());
  }

  private drawSquares(): void {
    const { theme, showCoordinates, coordinateColour } = {
      ...this.options,
      coordinateColour: this.options.theme.coordinate,
    };
    this.layers.squares.replaceChildren();
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(file));
        rect.setAttribute('y', String(rank));
        rect.setAttribute('width', '1');
        rect.setAttribute('height', '1');
        rect.setAttribute('fill', (file + rank) % 2 === 0 ? theme.light : theme.dark);
        this.layers.squares.append(rect);
      }
    }
    if (!showCoordinates) return;

    for (let i = 0; i < 8; i++) {
      const fileLabel = this.options.orientation === 'w' ? FILES[i] : FILES[7 - i];
      const rankLabel = this.options.orientation === 'w' ? 8 - i : i + 1;
      this.layers.squares.append(
        this.text(String(fileLabel), i + 0.86, 7.94, coordinateColour),
        this.text(String(rankLabel), 0.06, i + 0.22, coordinateColour)
      );
    }
  }

  private render(): void {
    this.layers.highlights.replaceChildren();
    this.layers.targets.replaceChildren();
    this.layers.pieces.replaceChildren();

    const theme = this.options.theme;
    if (this.lastMove) {
      for (const sq of [this.lastMove.from, this.lastMove.to]) {
        this.layers.highlights.append(this.square(sq, theme.lastMove, 0.42));
      }
    }
    if (this.checkSquare) {
      this.layers.highlights.append(this.square(this.checkSquare, theme.check, 0.5));
    }
    if (this.selected) {
      this.layers.highlights.append(this.square(this.selected, theme.selected, 0.55));
      for (const move of this.legalTargets) {
        this.layers.targets.append(this.targetMark(move));
      }
    }

    for (const { square, piece } of this.position.occupied()) {
      if (this.dragging?.from === square) continue; // it is in the drag layer
      this.layers.pieces.append(this.pieceNode(square, piece.color, piece.type));
    }
  }

  private attachPointerHandlers(): void {
    this.svg.addEventListener('pointerdown', (event: PointerEvent) => {
      const square = this.squareAt(event);
      if (!square) return;
      this.svg.setPointerCapture(event.pointerId);

      // Tapping a legal target completes a tap-tap move.
      if (this.selected && this.legalTargets.some((m) => m.to === square)) {
        const from = this.selected;
        this.clearSelection();
        void this.commit(from, square);
        return;
      }

      if (!this.callbacks.canPickUp(square)) {
        // Tapping empty space or an enemy piece clears any selection.
        if (this.selected) {
          this.clearSelection();
          this.callbacks.onCancel?.();
          this.render();
        }
        return;
      }

      this.selected = square;
      this.legalTargets = this.callbacks.legalMoves(square);
      this.callbacks.onLift?.(square);
      this.render();

      const piece = this.position.pieceAt(square);
      if (!piece) return;
      const node = this.pieceNode(square, piece.color, piece.type);
      node.style.pointerEvents = 'none';
      this.layers.drag.append(node);
      this.dragging = { from: square, pointerId: event.pointerId, node, moved: false };
      this.moveDragNode(event);
      this.render();
    });

    this.svg.addEventListener('pointermove', (event: PointerEvent) => {
      if (!this.dragging || this.dragging.pointerId !== event.pointerId) return;
      this.dragging.moved = true;
      this.moveDragNode(event);
    });

    const finish = (event: PointerEvent): void => {
      const drag = this.dragging;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.dragging = null;
      drag.node.remove();

      const target = this.squareAt(event);
      // A drag that never moved, or ended where it started, is a tap: keep the
      // selection so the second tap can finish the move.
      if (!drag.moved || !target || target === drag.from) {
        this.render();
        return;
      }
      const legal = this.legalTargets.some((m) => m.to === target);
      this.clearSelection();
      if (legal) void this.commit(drag.from, target);
      else {
        this.callbacks.onCancel?.();
        void this.callbacks.requestMove(drag.from, target); // let the app buzz
        this.render();
      }
    };
    this.svg.addEventListener('pointerup', finish);
    this.svg.addEventListener('pointercancel', finish);
  }

  private async commit(from: Square, to: Square): Promise<void> {
    const accepted = await this.callbacks.requestMove(from, to);
    if (!accepted) this.render();
  }

  private moveDragNode(event: PointerEvent): void {
    const drag = this.dragging;
    if (!drag) return;
    const point = this.boardPoint(event);
    // Lift the piece slightly above the finger so it is not hidden by it.
    drag.node.setAttribute(
      'transform',
      `translate(${point.x - 0.5} ${point.y - 0.68}) scale(1.12)`
    );
  }

  private clearSelection(): void {
    this.selected = null;
    this.legalTargets = [];
  }

  private squareAt(event: PointerEvent): Square | null {
    const { x, y } = this.boardPoint(event);
    if (x < 0 || x >= 8 || y < 0 || y >= 8) return null;
    const file = Math.floor(x);
    const rank = Math.floor(y);
    return this.toSquare(file, rank);
  }

  private boardPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 8,
      y: ((event.clientY - rect.top) / rect.height) * 8,
    };
  }

  /** Board coordinates (0..8) of a square's top-left corner. */
  private topLeft(square: Square): { x: number; y: number } {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    return this.options.orientation === 'w'
      ? { x: file, y: 7 - rank }
      : { x: 7 - file, y: rank };
  }

  private centre(square: Square): { x: number; y: number } {
    const { x, y } = this.topLeft(square);
    return { x: x + 0.5, y: y + 0.5 };
  }

  private toSquare(x: number, y: number): Square {
    const file = this.options.orientation === 'w' ? x : 7 - x;
    const rank = this.options.orientation === 'w' ? 7 - y : y;
    return `${FILES[file] as string}${rank + 1}`;
  }

  private findKing(color: Color): Square | null {
    for (const { square, piece } of this.position.occupied()) {
      if (piece.type === 'k' && piece.color === color) return square;
    }
    return null;
  }

  private group(): SVGGElement {
    return document.createElementNS(SVG_NS, 'g');
  }

  private square(sq: Square, fill: string, opacity: number): SVGRectElement {
    const { x, y } = this.topLeft(sq);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', '1');
    rect.setAttribute('height', '1');
    rect.setAttribute('fill', fill);
    rect.setAttribute('opacity', String(opacity));
    return rect;
  }

  /** A dot for a quiet target, a ring for a capture — legible at a glance. */
  private targetMark(move: LegalMove): SVGElement {
    const { x, y } = this.centre(move.to);
    const colour = this.options.theme.target;
    if (move.isCapture) {
      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('cx', String(x));
      ring.setAttribute('cy', String(y));
      ring.setAttribute('r', '0.44');
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', colour);
      ring.setAttribute('stroke-width', '0.09');
      ring.setAttribute('opacity', '0.5');
      return ring;
    }
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(y));
    dot.setAttribute('r', '0.15');
    dot.setAttribute('fill', colour);
    dot.setAttribute('opacity', '0.38');
    return dot;
  }

  private pieceNode(square: Square, color: Color, type: PieceSymbol): SVGGElement {
    const g = this.group();
    const { x, y } = this.topLeft(square);
    g.setAttribute('transform', `translate(${x} ${y})`);
    const img = document.createElementNS(SVG_NS, 'image');
    const name = `${color === 'w' ? 'w' : 'b'}${type.toUpperCase()}`;
    img.setAttribute('href', `pieces/${name}.svg`);
    img.setAttribute('width', '1');
    img.setAttribute('height', '1');
    img.setAttribute('draggable', 'false');
    g.append(img);
    g.dataset['square'] = square;
    return g;
  }

  private text(content: string, x: number, y: number, fill: string): SVGTextElement {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(y));
    t.setAttribute('font-size', '0.2');
    t.setAttribute('font-family', '-apple-system, system-ui, sans-serif');
    t.setAttribute('fill', fill);
    t.setAttribute('opacity', '0.85');
    t.textContent = content;
    return t;
  }

  /** Animate a piece sliding, unless reduce-motion is set. */
  async animateMove(move: MoveInfo): Promise<void> {
    if (this.options.reduceMotion) return;
    const node = this.layers.pieces.querySelector<SVGGElement>(
      `[data-square="${move.to}"]`
    );
    if (!node) return;
    const from = this.topLeft(move.from);
    const to = this.topLeft(move.to);
    const animation = node.animate(
      [
        { transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)` },
        { transform: 'translate(0px, 0px)' },
      ],
      { duration: 140, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' }
    );
    await animation.finished.catch(() => undefined);
  }
}
