import { BoardView, THEMES, type BoardCallbacks, type BoardTheme } from './board.js';
import { CLOCK_PRESETS, type Settings } from './settings.js';
import type { GameSnapshot } from './game.js';
import type { Color, MoveInfo, PieceSymbol } from '../core/types.js';
import { LADDER } from '../engine/strength.js';

/**
 * The screen.
 *
 * Layout rule for a phone held in one hand: the board takes the full width and
 * sits high, every control the game needs lives in a row below it within thumb
 * reach, and nothing important is at the top of the screen. Landscape is not
 * designed for, but must not break, so the layout simply centres and caps the
 * board height there.
 */
export interface ShellElements {
  root: HTMLElement;
  boardHost: HTMLElement;
  status: HTMLElement;
  clocks: { host: HTMLElement; w: HTMLElement; b: HTMLElement };
  moveList: HTMLElement;
  buttons: {
    takeBack: HTMLButtonElement;
    redo: HTMLButtonElement;
    hint: HTMLButtonElement;
    flip: HTMLButtonElement;
    menu: HTMLButtonElement;
  };
  coach: HTMLElement;
  sheet: HTMLElement;
  /** Appears only when the game is over. */
  endgame: { host: HTMLElement; text: HTMLElement; rematch: HTMLButtonElement };
}

export function buildShell(root: HTMLElement): ShellElements {
  root.replaceChildren();
  root.className = 'app';

  const status = el('div', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const clockW = el('span', 'clock-time');
  const clockB = el('span', 'clock-time');
  const clocks = el('div', 'clocks');
  clocks.hidden = true;
  const clockBWrap = el('div', 'clock clock-black');
  clockBWrap.append(labelled('Bot', clockB));
  const clockWWrap = el('div', 'clock clock-white');
  clockWWrap.append(labelled('You', clockW));
  clocks.append(clockBWrap, clockWWrap);

  const boardHost = el('div', 'board-host');
  const coach = el('div', 'coach');
  coach.hidden = true;

  const moveList = el('div', 'move-list');
  moveList.setAttribute('aria-label', 'moves');

  const takeBack = button('Take back', 'primary');
  const redo = button('Redo');
  const hint = button('Hint');
  const flip = button('Flip');
  const menu = button('Menu');
  const controls = el('div', 'controls');
  controls.append(takeBack, redo, hint, flip, menu);

  const sheet = el('div', 'sheet');
  sheet.hidden = true;

  // Shown only when a game ends, right above the controls so the obvious next
  // action is under the thumb that just finished the game.
  const endgameHost = el('div', 'endgame');
  endgameHost.hidden = true;
  const endgameText = el('span', 'endgame-text');
  const rematch = button('Rematch', 'primary');
  endgameHost.append(endgameText, rematch);

  root.append(status, clocks, boardHost, coach, moveList, endgameHost, controls, sheet);

  return {
    root,
    boardHost,
    status,
    clocks: { host: clocks, w: clockW, b: clockB },
    moveList,
    buttons: { takeBack, redo, hint, flip, menu },
    coach,
    sheet,
    endgame: { host: endgameHost, text: endgameText, rematch },
  };
}

/** Show or hide the end-of-game bar. */
export function renderEndgame(
  elements: ShellElements['endgame'],
  snapshot: GameSnapshot
): void {
  if (!snapshot.result) {
    elements.host.hidden = true;
    return;
  }
  elements.host.hidden = false;
  // Capitalise the reason so it reads as a headline, not a fragment.
  const reason = snapshot.result.reason;
  elements.text.textContent = reason.charAt(0).toUpperCase() + reason.slice(1);
}

/** Render the status line: whose move, what happened, or the result. */
export function renderStatus(el: HTMLElement, snapshot: GameSnapshot): void {
  if (snapshot.result) {
    el.textContent = `${snapshot.result.reason} (${snapshot.result.text})`;
    el.dataset['tone'] = 'result';
    return;
  }
  if (snapshot.thinking) {
    el.textContent = 'The bot is thinking…';
    el.dataset['tone'] = 'thinking';
    return;
  }
  const yours = snapshot.turn === snapshot.humanColor;
  el.textContent = yours ? 'Your move' : "Bot's move";
  el.dataset['tone'] = yours ? 'yours' : 'theirs';
}

export function renderClocks(
  elements: ShellElements['clocks'],
  snapshot: GameSnapshot
): void {
  if (!snapshot.clock) {
    elements.host.hidden = true;
    return;
  }
  elements.host.hidden = false;
  const human = snapshot.humanColor;
  const bot: Color = human === 'w' ? 'b' : 'w';
  elements.w.textContent = formatClock(snapshot.clock[human]);
  elements.b.textContent = formatClock(snapshot.clock[bot]);
  elements.w.dataset['running'] = String(snapshot.clock.running === human);
  elements.b.dataset['running'] = String(snapshot.clock.running === bot);
  elements.w.dataset['low'] = String(snapshot.clock[human] < 30_000);
  elements.b.dataset['low'] = String(snapshot.clock[bot] < 30_000);
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  // Under ten seconds, tenths matter.
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The move list, in standard notation, tappable to scrub. Rendered as pairs so a
 * scoresheet reads the way a scoresheet reads.
 *
 * Moves after the cursor are still in the tree — take back keeps them so redo can
 * work — but they have not been played from where you now stand, so they are
 * marked as "ahead" and shown faded. Showing them as ordinary played moves after
 * a take back reads as though the take back did nothing.
 */
export function renderMoveList(
  host: HTMLElement,
  moves: MoveInfo[],
  cursor: number,
  onSelect: (plyIndex: number) => void
): void {
  host.replaceChildren();
  const startButton = el('button', 'ply start');
  startButton.textContent = '⏮';
  startButton.setAttribute('aria-label', 'go to start');
  startButton.addEventListener('click', () => onSelect(-1));
  if (cursor === -1) startButton.dataset['current'] = 'true';
  host.append(startButton);

  for (let i = 0; i < moves.length; i += 2) {
    const row = el('span', 'move-pair');
    const number = el('span', 'move-number');
    number.textContent = `${i / 2 + 1}.`;
    row.append(number);
    for (const offset of [0, 1]) {
      const move = moves[i + offset];
      if (!move) continue;
      const ply = i + offset;
      const b = el('button', 'ply');
      b.textContent = move.san;
      if (cursor === ply) b.dataset['current'] = 'true';
      if (ply > cursor) {
        b.dataset['ahead'] = 'true';
        b.title = 'taken back — tap to go forward again';
      }
      b.addEventListener('click', () => onSelect(ply));
      row.append(b);
    }
    host.append(row);
  }
  const current = host.querySelector('[data-current="true"]');
  current?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

/** Bottom sheet used for promotion, the menu, and settings. */
export function showSheet(
  sheet: HTMLElement,
  title: string,
  build: (body: HTMLElement, close: () => void) => void
): void {
  sheet.replaceChildren();
  sheet.hidden = false;
  sheet.dataset['open'] = 'true';

  const panel = el('div', 'sheet-panel');
  const heading = el('h2', 'sheet-title');
  heading.textContent = title;
  const body = el('div', 'sheet-body');
  const close = (): void => {
    sheet.hidden = true;
    delete sheet.dataset['open'];
    sheet.replaceChildren();
  };
  const closeButton = button('Close');
  closeButton.addEventListener('click', close);

  panel.append(heading, body, closeButton);
  sheet.append(panel);
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) close();
  });
  build(body, close);
}

/** Promotion picker. Resolves with the chosen piece, or null if dismissed. */
export function askPromotion(
  sheet: HTMLElement,
  color: Color,
  theme: BoardTheme
): Promise<PieceSymbol | null> {
  return new Promise((resolve) => {
    let answered = false;
    showSheet(sheet, 'Promote to', (body, close) => {
      const row = el('div', 'promo-row');
      for (const piece of ['q', 'r', 'b', 'n'] as PieceSymbol[]) {
        const b = el('button', 'promo');
        b.style.background = theme.light;
        const img = document.createElement('img');
        img.src = `pieces/${color}${piece.toUpperCase()}.svg`;
        img.alt = pieceName(piece);
        img.width = 56;
        img.height = 56;
        b.append(img);
        b.setAttribute('aria-label', `promote to ${pieceName(piece)}`);
        b.addEventListener('click', () => {
          answered = true;
          close();
          resolve(piece);
        });
        row.append(b);
      }
      body.append(row);
      // Dismissing without choosing cancels the move rather than guessing queen.
      const observer = new MutationObserver(() => {
        if (sheet.hidden && !answered) {
          observer.disconnect();
          resolve(null);
        }
      });
      observer.observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
    });
  });
}

export function pieceName(piece: PieceSymbol): string {
  return { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[piece];
}

/** Settings panel. Calls `onChange` with a patch whenever something is toggled. */
export function buildSettingsPanel(
  body: HTMLElement,
  settings: Settings,
  onChange: (patch: Partial<Settings>) => void
): void {
  body.append(
    selectRow(
      'Bot rating',
      LADDER.map((r) => ({ value: String(r.elo), label: String(r.elo) })),
      String(settings.elo),
      (v) => onChange({ elo: Number(v) })
    ),
    selectRow(
      'Play as',
      [
        { value: 'w', label: 'White' },
        { value: 'b', label: 'Black' },
        { value: 'random', label: 'Random' },
      ],
      settings.playAs,
      (v) => onChange({ playAs: v as Settings['playAs'] })
    ),
    selectRow(
      'Clock',
      CLOCK_PRESETS.map((p) => ({ value: p.id, label: p.label })),
      settings.clock,
      (v) => onChange({ clock: v })
    ),
    selectRow(
      'Board',
      [
        { value: 'classic', label: 'Classic' },
        { value: 'high-contrast', label: 'High contrast' },
      ],
      settings.theme,
      (v) => onChange({ theme: v as Settings['theme'] })
    ),
    toggleRow('Sound', settings.soundEnabled, (v) => onChange({ soundEnabled: v })),
    rangeRow('Sound level', settings.soundIntensity, (v) => onChange({ soundIntensity: v })),
    toggleRow('Coordinates', settings.showCoordinates, (v) =>
      onChange({ showCoordinates: v })
    ),
    toggleRow('Legal move dots', settings.showTargets, (v) => onChange({ showTargets: v })),
    toggleRow('Move suggestions', settings.suggestionsEnabled, (v) =>
      onChange({ suggestionsEnabled: v })
    ),
    toggleRow('Danger warnings', settings.dangerWarnings, (v) =>
      onChange({ dangerWarnings: v })
    ),
    toggleRow('Coach', settings.coachEnabled, (v) => onChange({ coachEnabled: v }))
  );
}

export function makeBoard(
  host: HTMLElement,
  settings: Settings,
  humanColor: Color,
  reduceMotion: boolean,
  callbacks: BoardCallbacks
): BoardView {
  return new BoardView(host, callbacks, {
    orientation: humanColor,
    showCoordinates: settings.showCoordinates,
    theme: THEMES[settings.theme] as BoardTheme,
    reduceMotion,
  });
}

// --- small DOM helpers ---

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(label: string, variant?: string): HTMLButtonElement {
  const b = el('button', variant ? `btn ${variant}` : 'btn');
  b.type = 'button';
  b.textContent = label;
  return b;
}

function labelled(label: string, value: HTMLElement): DocumentFragment {
  const frag = document.createDocumentFragment();
  const l = el('span', 'clock-label');
  l.textContent = label;
  frag.append(l, value);
  return frag;
}

function row(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', 'setting-row');
  const text = el('span', 'setting-label');
  text.textContent = label;
  wrap.append(text, control);
  return wrap;
}

function toggleRow(
  label: string,
  value: boolean,
  onChange: (value: boolean) => void
): HTMLElement {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = value;
  input.className = 'toggle';
  input.addEventListener('change', () => onChange(input.checked));
  return row(label, input);
}

function rangeRow(
  label: string,
  value: number,
  onChange: (value: number) => void
): HTMLElement {
  const input = el('input');
  input.type = 'range';
  input.min = '0';
  input.max = '1';
  input.step = '0.05';
  input.value = String(value);
  input.addEventListener('input', () => onChange(Number(input.value)));
  return row(label, input);
}

function selectRow(
  label: string,
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void
): HTMLElement {
  const select = el('select', 'select');
  for (const option of options) {
    const o = document.createElement('option');
    o.value = option.value;
    o.textContent = option.label;
    if (option.value === value) o.selected = true;
    select.append(o);
  }
  select.addEventListener('change', () => onChange(select.value));
  return row(label, select);
}
