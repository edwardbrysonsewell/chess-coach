import './style.css';
import { Position } from '../core/position.js';
import { UciEngine } from '../engine/engine.js';
import { createVendoredEngineTransport } from '../engine/transport-worker.js';
import { Bot } from '../engine/bot.js';
import { makeRng } from '../engine/strength.js';
import { GameController, type GameSnapshot } from './game.js';
import { BoardView, THEMES, type BoardTheme } from './board.js';
import { SoundBoard } from './sound.js';
import {
  clockFor,
  loadSettings,
  prefersReducedMotion,
  saveSettings,
  type Settings,
} from './settings.js';
import { putGame, requestPersistence, type SavedGame } from './storage.js';
import {
  askPromotion,
  buildSettingsPanel,
  buildShell,
  renderClocks,
  renderMoveList,
  renderStatus,
  showSheet,
} from './ui.js';
import type { Color, Square } from '../core/types.js';

/**
 * Bootstrap. Owns the long-lived pieces — engine, sound, settings — and rebuilds
 * a GameController whenever a new game starts.
 */

let settings = loadSettings();
let sound = new SoundBoard({
  enabled: settings.soundEnabled,
  intensity: settings.soundIntensity,
});
let engine: UciEngine | null = null;
let bot: Bot | null = null;
let game: GameController | null = null;
let board: BoardView | null = null;
let currentGameId: number | null = null;
let lastSnapshot: GameSnapshot | null = null;

const root = document.getElementById('app');
if (!root) throw new Error('#app missing from the document');
const shell = buildShell(root);

function theme(): BoardTheme {
  return THEMES[settings.theme] as BoardTheme;
}

/** Boot the engine lazily: the first game start pays the 7 MB load, not page load. */
async function ensureEngine(): Promise<Bot> {
  if (bot) return bot;
  shell.status.textContent = 'Loading engine…';
  engine = new UciEngine(createVendoredEngineTransport());
  await engine.init();
  bot = new Bot(engine, settings.elo, makeRng(Date.now() & 0xffff));
  return bot;
}

function pickColor(): Color {
  if (settings.playAs === 'random') return Math.random() < 0.5 ? 'w' : 'b';
  return settings.playAs;
}

async function newGame(startFen?: string): Promise<void> {
  game?.dispose();
  board = null;
  shell.boardHost.replaceChildren();
  currentGameId = null;

  const activeBot = await ensureEngine();
  await activeBot.setElo(settings.elo);

  const humanColor = pickColor();
  const reduceMotion = prefersReducedMotion(settings);

  const controller = new GameController(
    activeBot,
    { humanColor, clock: clockFor(settings.clock), botElo: settings.elo },
    {
      onChange: (snapshot) => {
        lastSnapshot = snapshot;
        board?.setPosition(new Position(snapshot.fen), snapshot.lastMove);
        renderStatus(shell.status, snapshot);
        renderClocks(shell.clocks, snapshot);
        renderMoveList(shell.moveList, snapshot.moves, snapshot.cursor, (ply) => {
          const path = controller.tree.mainline();
          const node = path[ply + 1];
          if (node) controller.goTo(node);
        });
        shell.buttons.takeBack.disabled = !snapshot.canTakeBack || snapshot.thinking;
        shell.buttons.redo.disabled = !snapshot.canRedo || snapshot.thinking;
        shell.buttons.hint.hidden = !settings.suggestionsEnabled;
      },
      onCue: (cue) => sound.play(cue),
      onPersist: () => void persist(controller, humanColor),
    },
    startFen
  );
  game = controller;

  board = new BoardView(
    shell.boardHost,
    {
      legalMoves: (from: Square) =>
        settings.showTargets ? controller.position().legalMoves(from) : [],
      canPickUp: (square: Square) => {
        if (controller.result() || controller.turn() !== humanColor) return false;
        return controller.position().pieceAt(square)?.color === humanColor;
      },
      requestMove: async (from: Square, to: Square) => {
        let promotion;
        if (controller.needsPromotion(from, to)) {
          const chosen = await askPromotion(shell.sheet, humanColor, theme());
          if (!chosen) return false;
          promotion = chosen;
        }
        const outcome = await controller.humanMove(from, to, promotion);
        return outcome === 'ok';
      },
      onLift: () => sound.play('lift'),
    },
    {
      orientation: humanColor,
      showCoordinates: settings.showCoordinates,
      theme: theme(),
      reduceMotion,
    }
  );

  await controller.start();
}

async function persist(controller: GameController, humanColor: Color): Promise<void> {
  const result = controller.result();
  const saved: SavedGame = {
    ...(currentGameId !== null ? { id: currentGameId } : {}),
    savedAt: new Date().toISOString(),
    pgn: controller.pgn(),
    fen: controller.position().fen(),
    botElo: controller.botElo(),
    humanColor,
    result: result?.text ?? '*',
    plies: controller.mainlineMoves().length,
    finished: result !== null,
  };
  const id = await putGame(saved);
  if (id !== null) currentGameId = id;
}

// --- controls ---

shell.buttons.takeBack.addEventListener('click', () => {
  const undone = game?.takeBack() ?? 0;
  if (undone === 0) sound.play('illegal');
});
shell.buttons.redo.addEventListener('click', () => void game?.redo());
shell.buttons.flip.addEventListener('click', () => board?.flip());

shell.buttons.hint.addEventListener('click', () => {
  void showHint();
});

shell.buttons.menu.addEventListener('click', () => {
  showSheet(shell.sheet, 'Chess Coach', (body, close) => {
    const newGameButton = document.createElement('button');
    newGameButton.className = 'btn primary wide';
    newGameButton.textContent = 'New game';
    newGameButton.addEventListener('click', () => {
      close();
      void newGame();
    });

    const resignButton = document.createElement('button');
    resignButton.className = 'btn wide';
    resignButton.textContent = 'Resign';
    resignButton.addEventListener('click', () => {
      close();
      game?.resign();
    });

    const heading = document.createElement('h3');
    heading.className = 'sheet-subtitle';
    heading.textContent = 'Settings';

    body.append(newGameButton, resignButton, heading);
    buildSettingsPanel(body, settings, (patch) => {
      const needsNewGame =
        ('elo' in patch && patch.elo !== settings.elo) ||
        ('clock' in patch && patch.clock !== settings.clock) ||
        ('playAs' in patch && patch.playAs !== settings.playAs);
      settings = { ...settings, ...patch };
      saveSettings(settings);
      sound.update({
        enabled: settings.soundEnabled,
        intensity: settings.soundIntensity,
      });
      board?.setOptions({
        showCoordinates: settings.showCoordinates,
        theme: theme(),
        reduceMotion: prefersReducedMotion(settings),
      });
      if (lastSnapshot) renderStatus(shell.status, lastSnapshot);
      if (needsNewGame) {
        // Rating, colour and clock only take effect from a fresh game; say so
        // rather than half-applying them.
        shell.status.textContent = 'Start a new game to apply that';
      }
    });
  });
});

async function showHint(): Promise<void> {
  const controller = game;
  const activeEngine = engine;
  if (!controller || !activeEngine || controller.result()) return;
  if (controller.turn() !== controller.humanColor()) return;

  board?.clearArrows();
  shell.status.textContent = 'Looking…';
  const lines = await activeEngine.evaluate(controller.position().fen(), {
    multiPv: 1,
    depth: 12,
  });
  const best = lines[0]?.moves[0];
  if (!best) {
    if (lastSnapshot) renderStatus(shell.status, lastSnapshot);
    return;
  }
  board?.drawArrow(best.slice(0, 2), best.slice(2, 4));
  if (lastSnapshot) renderStatus(shell.status, lastSnapshot);
}

// Audio needs a gesture on iOS; the first touch anywhere unlocks it.
const unlock = (): void => {
  void sound.unlock();
  window.removeEventListener('pointerdown', unlock);
};
window.addEventListener('pointerdown', unlock);

// Follow the system colour scheme without a reload.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  board?.setOptions({ theme: theme() });
});

async function boot(): Promise<void> {
  await requestPersistence();
  if ('serviceWorker' in navigator) {
    // Registration failing must never stop the app; it only costs offline use.
    navigator.serviceWorker.register('sw.js').catch(() => undefined);
  }
  await newGame();
}

void boot();
