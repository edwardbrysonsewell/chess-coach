/**
 * IndexedDB for anything that grows: saved games and, later, puzzle progress.
 *
 * Deliberately a thin promise wrapper over raw IndexedDB rather than a library —
 * the schema is two stores, and a dependency here would be more code than this
 * file. Every call resolves rather than throwing on a missing database, so a
 * private-mode browser degrades to "cannot save" instead of "cannot play".
 */

export interface SavedGame {
  /** Assigned by the store. */
  id?: number;
  /** ISO timestamp, passed in by the caller so this file stays testable. */
  savedAt: string;
  /** PGN including variations — the whole tree, not just the mainline. */
  pgn: string;
  /** Position when saved, so a game can resume mid-move. */
  fen: string;
  botElo: number;
  humanColor: 'w' | 'b';
  result: string;
  /** Half-moves played, for the list view. */
  plies: number;
  /** True once the game is over, so the list can separate finished from in-play. */
  finished: boolean;
}

export interface PuzzleProgress {
  /** Position the blunder happened in. */
  fen: string;
  solvedAt: string | null
  attempts: number;
  /** The move that was missed, in UCI. */
  bestMove: string;
  fromGameId?: number;
}

const DB_NAME = 'chess-coach';
const DB_VERSION = 1;
const GAMES = 'games';
const PUZZLES = 'puzzles';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!('indexedDB' in globalThis)) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GAMES)) {
        const store = db.createObjectStore(GAMES, { keyPath: 'id', autoIncrement: true });
        store.createIndex('savedAt', 'savedAt');
        store.createIndex('finished', 'finished');
      }
      if (!db.objectStoreNames.contains(PUZZLES)) {
        db.createObjectStore(PUZZLES, { keyPath: 'fen' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const transaction = db.transaction(store, mode);
          const request = run(transaction.objectStore(store));
          request.onsuccess = () => resolve(request.result as T);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      })
  );
}

/** Save a new game, or update it in place when it already has an id. */
export async function putGame(game: SavedGame): Promise<number | null> {
  const key = await tx<IDBValidKey>(GAMES, 'readwrite', (s) => s.put(game));
  return typeof key === 'number' ? key : null;
}

export async function getGame(id: number): Promise<SavedGame | null> {
  return tx<SavedGame>(GAMES, 'readonly', (s) => s.get(id));
}

/** Newest first. */
export async function listGames(limit = 50): Promise<SavedGame[]> {
  const all = await tx<SavedGame[]>(GAMES, 'readonly', (s) => s.getAll());
  if (!all) return [];
  return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, limit);
}

export async function deleteGame(id: number): Promise<void> {
  await tx(GAMES, 'readwrite', (s) => s.delete(id));
}

export async function putPuzzle(puzzle: PuzzleProgress): Promise<void> {
  await tx(PUZZLES, 'readwrite', (s) => s.put(puzzle));
}

export async function listPuzzles(): Promise<PuzzleProgress[]> {
  return (await tx<PuzzleProgress[]>(PUZZLES, 'readonly', (s) => s.getAll())) ?? [];
}

/**
 * Ask iOS not to evict the database. Safari clears unpersisted storage for sites
 * it considers unused, which would silently lose saved games; a Home Screen app
 * usually gets this granted without a prompt.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
