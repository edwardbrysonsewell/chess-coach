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
  renderEndgame,
  renderMoveList,
  renderStatus,
  showSheet,
} from './ui.js';
import type { Color, PieceSymbol, Square } from '../core/types.js';
import { assessMove } from '../coach/danger.js';
import { reviewGame } from '../coach/review.js';
import { buildReview } from './review-ui.js';
import { threatsAfter } from '../coach/motifs.js';
import { hintSentence } from '../coach/language.js';

/**
 * Bootstrap. Owns the long-lived pieces — engine, sound, settings — and rebuilds
 * a GameController whenever a new game starts.
 */

declare const __BUILD_ID__: string;
/** Build stamp, shown in the sound check so "am I running the new version?" is answerable. */
const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

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
/**
 * Moves already warned about, keyed by position and move. Bryson's rule: warn
 * once, let him override, never block the move — so a move he has been warned
 * about goes straight through the second time.
 */
const warned = new Set<string>();
/** FEN a hint search is currently running for, so auto-hints do not stack up. */
let hintInFlight: string | null = null;

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
        renderEndgame(shell.endgame, snapshot);
        renderMoveList(shell.moveList, snapshot.moves, snapshot.cursor, (ply) => {
          const path = controller.tree.mainline();
          const node = path[ply + 1];
          if (node) controller.goTo(node);
        });
        shell.buttons.takeBack.disabled = !snapshot.canTakeBack || snapshot.thinking;
        shell.buttons.redo.disabled = !snapshot.canRedo || snapshot.thinking;
        shell.buttons.hint.hidden = !settings.suggestionsEnabled;
        shell.buttons.hint.dataset['on'] = String(settings.hintsAlwaysOn);
        shell.buttons.hint.textContent = settings.hintsAlwaysOn ? 'Hints on' : 'Hint';
        // With hints left on, draw the arrow for every move without being asked.
        if (
          settings.hintsAlwaysOn &&
          settings.suggestionsEnabled &&
          !snapshot.thinking &&
          !snapshot.result &&
          snapshot.turn === snapshot.humanColor
        ) {
          void showHint({ automatic: true });
        }
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
        let promotion: PieceSymbol | undefined;
        if (controller.needsPromotion(from, to)) {
          const chosen = await askPromotion(shell.sheet, humanColor, theme());
          if (!chosen) return false;
          promotion = chosen;
        }
        if (!(await passesDangerCheck(controller, from, to, promotion))) return false;
        board?.clearArrows();
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

// Rematch: same settings, fresh game. Sits under the thumb that just lost.
shell.endgame.rematch.addEventListener('click', () => void newGame());
shell.endgame.review.addEventListener('click', () => void showReview());

/*
 * The hint control is a toggle (Bryson, 2026-07-30). Tapping it turns hints on
 * and they stay on, drawing the arrow for every move until turned off again.
 */
shell.buttons.hint.addEventListener('click', () => {
  settings = { ...settings, hintsAlwaysOn: !settings.hintsAlwaysOn };
  saveSettings(settings);
  shell.buttons.hint.dataset['on'] = String(settings.hintsAlwaysOn);
  shell.buttons.hint.textContent = settings.hintsAlwaysOn ? 'Hints on' : 'Hint';
  if (settings.hintsAlwaysOn) {
    // "Show me the hint for my next move" only means anything at the live
    // position, so come back from any scrubbing first rather than silently
    // doing nothing.
    if (game && !game.isLive()) game.goToLive();
    void showHint({ automatic: false });
  } else {
    board?.clearArrows();
    shell.coach.hidden = true;
  }
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

    const soundCheckButton = document.createElement('button');
    soundCheckButton.className = 'btn wide';
    soundCheckButton.textContent = 'Sound check';
    soundCheckButton.addEventListener('click', () => {
      close();
      showSoundCheck();
    });

    const heading = document.createElement('h3');
    heading.className = 'sheet-subtitle';
    heading.textContent = 'Settings';

    body.append(newGameButton, resignButton, soundCheckButton, heading);
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

/**
 * The sound check. Its job is to answer one question on the device itself: is
 * the app producing audio, or is the phone not playing it?
 *
 * The live meter reads the signal leaving the master bus. If it moves while
 * nothing can be heard, the app is fine and the fault is the ring/silent switch
 * or the media volume — which is not something the code can fix, and is worth
 * saying plainly rather than shipping another speculative audio patch.
 */
function showSoundCheck(): void {
  showSheet(shell.sheet, 'Sound check', (body, close) => {
    const verdict = document.createElement('p');
    verdict.className = 'sound-verdict';
    verdict.textContent = 'Tap the button and watch the bar.';

    const meterWrap = document.createElement('div');
    meterWrap.className = 'meter';
    const meterFill = document.createElement('div');
    meterFill.className = 'meter-fill';
    meterWrap.append(meterFill);

    const play = document.createElement('button');
    play.className = 'btn primary wide';
    play.textContent = 'Play a test sound';

    const details = document.createElement('div');
    details.className = 'sound-details';

    let peakSeen = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = (): void => {
      const level = sound.meter();
      peakSeen = Math.max(peakSeen, level);
      meterFill.style.width = `${Math.min(100, level * 140)}%`;
      const rows = { ...sound.diagnostics(), 'highest level seen': peakSeen.toFixed(3), build: BUILD };
      details.replaceChildren(
        ...Object.entries(rows).map(([key, value]) => {
          const row = document.createElement('div');
          row.className = 'sound-detail-row';
          const k = document.createElement('span');
          k.textContent = key;
          const v = document.createElement('span');
          v.textContent = value;
          row.append(k, v);
          return row;
        })
      );
      if (peakSeen > 0.01) {
        verdict.textContent =
          'The app IS producing sound. If you cannot hear it, the phone is muting it: ' +
          'check the ring/silent switch on the left edge, then press volume-up WHILE the ' +
          'test sound is playing (the volume buttons only change media volume during playback).';
        verdict.dataset['tone'] = 'good';
      }
    };

    play.addEventListener('click', () => {
      void sound.unlock().then(() => {
        sound.testTone(3);
        sound.play('capture');
      });
      if (timer === null) timer = setInterval(refresh, 100);
    });

    body.append(verdict, meterWrap, play, details);
    refresh();

    // Stop polling when the sheet closes.
    const observer = new MutationObserver(() => {
      if (shell.sheet.hidden) {
        if (timer !== null) clearInterval(timer);
        observer.disconnect();
      }
    });
    observer.observe(shell.sheet, { attributes: true, attributeFilter: ['hidden'] });
    void close;
  });
}

/**
 * Draw the engine's preferred move as an arrow, and explain it in the coach
 * strip. `automatic` runs stay quiet about failure: with hints left on, a hint
 * that cannot be produced should simply not appear rather than nag.
 */
/**
 * Post-game review: walk the whole game with the engine, then show the result.
 *
 * The analysis is the slow part (a couple of hundred milliseconds per move on a
 * phone), so progress is reported while it runs rather than leaving a dead
 * screen.
 */
async function showReview(): Promise<void> {
  const controller = game;
  const activeEngine = engine;
  if (!controller || !activeEngine) return;
  const moves = controller.mainlineMoves();
  if (!moves.length) return;

  let cancelled = false;
  showSheet(shell.sheet, 'Game review', (body) => {
    const progress = document.createElement('p');
    progress.className = 'review-text';
    progress.textContent = `Analysing ${moves.length} moves…`;
    body.append(progress);
    const observer = new MutationObserver(() => {
      if (shell.sheet.hidden) {
        cancelled = true;
        observer.disconnect();
      }
    });
    observer.observe(shell.sheet, { attributes: true, attributeFilter: ['hidden'] });
    void (async () => {
      try {
        const review = await reviewGame(
          activeEngine,
          controller.tree.fenAtStart(),
          moves,
          {
            humanColor: controller.humanColor(),
            elo: settings.elo,
            onProgress: (done, total) => {
              progress.textContent = `Analysing move ${done} of ${total}…`;
            },
          }
        );
        if (cancelled || shell.sheet.hidden) return;
        body.replaceChildren();
        buildReview(body, review, controller.humanColor(), (ply) => {
          const node = controller.tree.mainline()[ply + 1];
          if (node) {
            controller.goTo(node);
            shell.sheet.hidden = true;
          }
        });
      } catch (error) {
        progress.textContent = `The review could not be completed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    })();
  });
}

async function showHint({ automatic }: { automatic: boolean }): Promise<void> {
  const controller = game;
  const activeEngine = engine;
  if (!controller || !activeEngine || controller.result()) return;
  if (controller.turn() !== controller.humanColor()) return;

  const fenAtRequest = controller.position().fen();
  if (hintInFlight === fenAtRequest) return; // already looking at this position
  hintInFlight = fenAtRequest;
  if (!automatic) shell.status.textContent = 'Looking…';

  let lines;
  try {
    lines = await activeEngine.evaluate(fenAtRequest, { multiPv: 1, depth: 12 });
  } finally {
    hintInFlight = null;
  }
  // The game may have moved on while the engine was thinking.
  if (!game || game !== controller || controller.position().fen() !== fenAtRequest) return;

  const best = lines[0]?.moves[0];
  if (!best) {
    if (lastSnapshot) renderStatus(shell.status, lastSnapshot);
    return;
  }
  board?.clearArrows();
  board?.drawArrow(best.slice(0, 2), best.slice(2, 4));

  // Explain it with the same detector the warnings use.
  const position = controller.position();
  const probe = position.clone();
  const played = probe.play({
    from: best.slice(0, 2),
    to: best.slice(2, 4),
    ...(best.length > 4 ? { promotion: best[4] as PieceSymbol } : {}),
  });
  if (played) {
    const motifs = threatsAfter(position, best, controller.humanColor());
    shell.coach.hidden = false;
    shell.coach.textContent = hintSentence(
      probe,
      played.san,
      motifs,
      played.isCapture,
      played.isCheck
    );
  }
  if (lastSnapshot) renderStatus(shell.status, lastSnapshot);
}

/**
 * Run the danger check before a move is committed.
 *
 * Returns true if the move should proceed. A warned-about move is remembered, so
 * playing it again goes straight through: warn once, allow the override, never
 * block the move.
 */
async function passesDangerCheck(
  controller: GameController,
  from: Square,
  to: Square,
  promotion: PieceSymbol | undefined
): Promise<boolean> {
  const activeEngine = engine;
  if (!settings.dangerWarnings || !activeEngine) return true;
  const position = controller.position();
  const key = `${position.fen()}|${from}${to}${promotion ?? ''}`;
  if (warned.has(key)) return true;

  let warning;
  try {
    warning = await assessMove(activeEngine, position, from, to, promotion, {
      elo: settings.elo,
    });
  } catch {
    return true; // a failing check must never stop a game
  }
  if (!warning) return true;

  warned.add(key);
  sound.play('danger');
  for (const square of warning.highlight) board?.pulse(square);
  const message = warning.message;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    showSheet(shell.sheet, 'Have another look', (body, close) => {
      const text = document.createElement('p');
      text.className = 'sound-verdict';
      text.dataset['tone'] = 'good';
      text.textContent = message;

      const pickAnother = document.createElement('button');
      pickAnother.className = 'btn primary wide';
      pickAnother.textContent = 'Let me pick another move';
      pickAnother.addEventListener('click', () => {
        settled = true;
        close();
        resolve(false);
      });

      const playAnyway = document.createElement('button');
      playAnyway.className = 'btn wide';
      playAnyway.textContent = 'Play it anyway';
      playAnyway.addEventListener('click', () => {
        settled = true;
        close();
        resolve(true);
      });

      body.append(text, pickAnother, playAnyway);

      // Dismissing the sheet counts as "let me think again".
      const observer = new MutationObserver(() => {
        if (shell.sheet.hidden) {
          observer.disconnect();
          if (!settled) resolve(false);
        }
      });
      observer.observe(shell.sheet, { attributes: true, attributeFilter: ['hidden'] });
    });
  });
}

/*
 * Audio needs a user gesture on iOS. Two details matter and both were wrong at
 * first:
 *
 *  - CAPTURE phase, so this runs before the board's own pointerdown handler.
 *    In the bubble phase the board had already played the lift cue into a
 *    still-suspended context, so the first move of a session was silent.
 *  - keep listening until the context is actually running, rather than
 *    unsubscribing after one attempt that may have failed.
 */
const unlock = (): void => {
  void sound.unlock().then(() => {
    if (sound.ready()) {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('touchend', unlock, true);
    }
  });
};
window.addEventListener('pointerdown', unlock, true);
window.addEventListener('touchend', unlock, true);

// Small diagnostic surface. Worth keeping: "is the sound actually armed?" is
// otherwise unanswerable from a phone, and silence has several innocent causes
// (the ring/silent switch being the usual one).
(window as unknown as { __soundState: () => string }).__soundState = () => sound.state();

// Follow the system colour scheme without a reload.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  board?.setOptions({ theme: theme() });
});

async function boot(): Promise<void> {
  await requestPersistence();
  // Only in a real build: sw.js is generated at build time, so in dev the
  // request falls through to index.html and Chrome logs a MIME-type error that
  // looks like a fault but is not one.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // Registration failing must never stop the app; it only costs offline use.
    navigator.serviceWorker.register('sw.js').catch(() => undefined);

    /*
     * A cache-first worker serves the OLD build until the new one takes over,
     * which normally means a fix needs two reloads to appear — and looks exactly
     * like the fix not working. The new worker calls skipWaiting, so when it
     * takes control we reload once, automatically.
     */
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
  await newGame();
}

void boot();
