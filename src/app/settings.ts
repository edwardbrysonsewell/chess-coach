import type { Color } from '../core/types.js';

/** Everything that persists between sessions in localStorage. */
export interface Settings {
  /** Bot rating; one of the ladder rungs. */
  elo: number;
  /** Which colour the human plays. 'random' picks per game. */
  playAs: Color | 'random';
  soundEnabled: boolean;
  soundIntensity: number;
  showCoordinates: boolean;
  /** Legal-target dots under the selected piece. */
  showTargets: boolean;
  /** Whether the hint control is available at all. */
  suggestionsEnabled: boolean;
  /**
   * When on, the hint arrow is drawn automatically for every one of your moves
   * rather than only when asked. Bryson asked for this on 2026-07-30, replacing
   * the original "never auto-shows" rule.
   */
  hintsAlwaysOn: boolean;
  dangerWarnings: boolean;
  coachEnabled: boolean;
  theme: 'classic' | 'high-contrast';
  /** Clock preset in "minutes+increment" form, or 'off'. */
  clock: string;
  /** Overrides the system preference when set. */
  reduceMotion: boolean | null;
}

export const CLOCK_PRESETS: ReadonlyArray<{ id: string; label: string; minutes: number; increment: number }> = [
  { id: 'off', label: 'No clock', minutes: 0, increment: 0 },
  { id: '1+0', label: 'Bullet 1+0', minutes: 1, increment: 0 },
  { id: '3+2', label: 'Blitz 3+2', minutes: 3, increment: 2 },
  { id: '5+0', label: 'Blitz 5+0', minutes: 5, increment: 0 },
  { id: '10+5', label: 'Rapid 10+5', minutes: 10, increment: 5 },
  { id: '15+10', label: 'Rapid 15+10', minutes: 15, increment: 10 },
  { id: '30+0', label: 'Classical 30+0', minutes: 30, increment: 0 },
];

export const DEFAULTS: Settings = {
  elo: 850,
  playAs: 'w',
  soundEnabled: true,
  soundIntensity: 0.7,
  showCoordinates: true,
  showTargets: true,
  suggestionsEnabled: true,
  hintsAlwaysOn: false,
  dangerWarnings: true,
  coachEnabled: true,
  theme: 'classic',
  clock: 'off',
  reduceMotion: null,
};

const KEY = 'chess-coach.settings.v1';

/**
 * Settings are small and read constantly, so they live in localStorage rather
 * than IndexedDB. Unknown keys are dropped and missing ones filled from the
 * defaults, so an older stored blob can never leave the app in a broken state.
 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as Array<keyof Settings>) {
      const value = parsed[key];
      if (value !== undefined && typeof value === typeof DEFAULTS[key]) {
        (merged[key] as unknown) = value;
      } else if (key === 'reduceMotion' && (value === null || typeof value === 'boolean')) {
        merged.reduceMotion = value;
      }
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // A full or disabled store must not break play.
  }
}

export function clockFor(id: string): { minutes: number; increment: number } | null {
  const preset = CLOCK_PRESETS.find((p) => p.id === id);
  if (!preset || preset.id === 'off') return null;
  return { minutes: preset.minutes, increment: preset.increment };
}

/** Does the user want motion reduced? Explicit setting wins over the system. */
export function prefersReducedMotion(settings: Settings): boolean {
  if (settings.reduceMotion !== null) return settings.reduceMotion;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
