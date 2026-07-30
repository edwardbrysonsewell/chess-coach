/**
 * A small embedded opening book: ECO code, name, and the idea behind it.
 *
 * Vendored rather than fetched — the app makes no network calls, ever. This is a
 * curated set of the openings a club player actually meets, not a complete ECO
 * database: a 3,000-line table would bloat the bundle to name lines nobody here
 * will play. Longest matching move sequence wins, so a game is named as
 * specifically as the book allows.
 *
 * Each entry carries a `plan` written in plain English, because "this is the
 * Sicilian Defence" teaches nothing on its own.
 */

export interface OpeningEntry {
  readonly eco: string;
  readonly name: string;
  /** SAN moves from the start position. */
  readonly moves: readonly string[];
  /** What the side that chose it is trying to do. */
  readonly plan: string;
}

export const OPENINGS: readonly OpeningEntry[] = [
  // --- 1. e4 ---
  { eco: 'B00', name: "King's Pawn Opening", moves: ['e4'], plan: 'Take the centre and open lines for the bishop and queen so you can castle quickly.' },
  { eco: 'C20', name: "King's Pawn Game", moves: ['e4', 'e5'], plan: 'Both sides stake a claim in the centre; the fight is over the d4 and f4 squares.' },
  { eco: 'C40', name: "King's Knight Opening", moves: ['e4', 'e5', 'Nf3'], plan: 'Develop with a threat: the knight attacks e5 and prepares to castle.' },
  { eco: 'C44', name: 'Scotch Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4'], plan: 'Open the centre immediately and get the pieces out fast.' },
  { eco: 'C50', name: 'Italian Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], plan: 'Aim the bishop at f7, the weakest square in the black camp, and castle early.' },
  { eco: 'C53', name: 'Giuoco Piano', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3'], plan: 'Build a big pawn centre with d4 while the bishops eye the kingside.' },
  { eco: 'C57', name: 'Two Knights Defence', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'], plan: 'Counterattack e4 rather than defend f7, accepting sharp play.' },
  { eco: 'C60', name: 'Ruy López', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], plan: 'Pressure the knight that defends e5, then build slowly with c3 and d4.' },
  { eco: 'C65', name: 'Ruy López, Berlin Defence', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6'], plan: 'Hit e4 at once and head for a solid, slightly dry position.' },
  { eco: 'C68', name: 'Ruy López, Exchange Variation', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6'], plan: 'Damage the pawn structure and aim for a good endgame.' },
  { eco: 'C41', name: 'Philidor Defence', moves: ['e4', 'e5', 'Nf3', 'd6'], plan: 'Hold the centre solidly, at the cost of a cramped position.' },
  { eco: 'C42', name: 'Petrov Defence', moves: ['e4', 'e5', 'Nf3', 'Nf6'], plan: 'Copy the attack on the centre pawn and steer towards symmetry.' },
  { eco: 'C46', name: 'Four Knights Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6'], plan: 'Sensible development on both sides; the game is decided later.' },
  { eco: 'C23', name: "Bishop's Opening", moves: ['e4', 'e5', 'Bc4'], plan: 'Target f7 before committing the knight.' },
  { eco: 'C30', name: "King's Gambit", moves: ['e4', 'e5', 'f4'], plan: 'Offer a pawn to rip open the f-file and attack fast.' },
  { eco: 'C21', name: 'Danish Gambit', moves: ['e4', 'e5', 'd4', 'exd4', 'c3'], plan: 'Give up pawns for two raking bishops and rapid development.' },
  { eco: 'B20', name: 'Sicilian Defence', moves: ['e4', 'c5'], plan: 'Fight for the centre asymmetrically and play for a win with the black pieces.' },
  { eco: 'B27', name: 'Sicilian Defence', moves: ['e4', 'c5', 'Nf3'], plan: 'Develop and prepare d4, opening the position where White is better developed.' },
  { eco: 'B50', name: 'Sicilian, Open', moves: ['e4', 'c5', 'Nf3', 'd6', 'd4'], plan: 'Trade the c-pawn for the d-pawn and play on the open lines.' },
  { eco: 'B90', name: 'Sicilian, Najdorf', moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'], plan: 'Control b5, prepare e5 or e6, and counterattack on the queenside.' },
  { eco: 'B70', name: 'Sicilian, Dragon', moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'], plan: 'Fianchetto the bishop onto the long diagonal and race on opposite wings.' },
  { eco: 'B22', name: 'Sicilian, Alapin', moves: ['e4', 'c5', 'c3'], plan: 'Prepare d4 with a pawn, aiming for a big centre instead of theory.' },
  { eco: 'B01', name: 'Scandinavian Defence', moves: ['e4', 'd5'], plan: 'Trade off the centre pawn immediately and develop with tempo on the queen.' },
  { eco: 'B02', name: 'Alekhine Defence', moves: ['e4', 'Nf6'], plan: 'Invite the pawns forward, then attack the over-extended centre.' },
  { eco: 'B10', name: 'Caro-Kann Defence', moves: ['e4', 'c6'], plan: 'Support d5 with a pawn so the light-squared bishop still gets out.' },
  { eco: 'C00', name: 'French Defence', moves: ['e4', 'e6'], plan: 'Challenge the centre with d5 and counterattack on the queenside.' },
  { eco: 'C02', name: 'French, Advance Variation', moves: ['e4', 'e6', 'd4', 'd5', 'e5'], plan: 'Gain space and cramp Black, who must undermine with c5 and f6.' },
  { eco: 'B07', name: 'Pirc Defence', moves: ['e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6'], plan: 'Let White build a centre, then strike at it from the flank.' },
  { eco: 'B06', name: 'Modern Defence', moves: ['e4', 'g6'], plan: 'Fianchetto first and decide on a central plan later.' },

  // --- 1. d4 ---
  { eco: 'A40', name: "Queen's Pawn Opening", moves: ['d4'], plan: 'Claim the centre with a pawn that is defended from the start.' },
  { eco: 'D00', name: "Queen's Pawn Game", moves: ['d4', 'd5'], plan: 'A slower, more strategic game than 1.e4 lines.' },
  { eco: 'D06', name: "Queen's Gambit", moves: ['d4', 'd5', 'c4'], plan: 'Offer the c-pawn to deflect the d5 pawn and dominate the centre.' },
  { eco: 'D20', name: "Queen's Gambit Accepted", moves: ['d4', 'd5', 'c4', 'dxc4'], plan: 'Take the pawn, then give it back for free development.' },
  { eco: 'D30', name: "Queen's Gambit Declined", moves: ['d4', 'd5', 'c4', 'e6'], plan: 'Hold the centre solidly; the light-squared bishop is the long-term problem.' },
  { eco: 'D10', name: 'Slav Defence', moves: ['d4', 'd5', 'c4', 'c6'], plan: 'Defend d5 with the c-pawn so the light-squared bishop stays free.' },
  { eco: 'E00', name: 'Indian Defence', moves: ['d4', 'Nf6'], plan: 'Control the centre with pieces before committing pawns.' },
  { eco: 'E60', name: "King's Indian Defence", moves: ['d4', 'Nf6', 'c4', 'g6'], plan: 'Give White the centre, castle, then break with e5 and attack the king.' },
  { eco: 'E20', name: 'Nimzo-Indian Defence', moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'], plan: 'Pin the knight to fight for e4 and damage the pawn structure.' },
  { eco: 'E12', name: 'Queen\'s Indian Defence', moves: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6'], plan: 'Fianchetto to fight for e4 from a distance.' },
  { eco: 'D80', name: 'Grünfeld Defence', moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'], plan: 'Let White build a big centre, then attack it with pieces and c5.' },
  { eco: 'A45', name: 'Trompowsky Attack', moves: ['d4', 'Nf6', 'Bg5'], plan: 'Pin the knight early and sidestep mainstream theory.' },
  { eco: 'A80', name: 'Dutch Defence', moves: ['d4', 'f5'], plan: 'Fight for e4 and aim at the kingside, accepting a loosened king.' },
  { eco: 'D02', name: 'London System', moves: ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4'], plan: 'A safe set-up you can play against almost anything: Bf4, e3, c3, Bd3.' },

  // --- flank ---
  { eco: 'A10', name: 'English Opening', moves: ['c4'], plan: 'Control d5 from the flank and keep options open.' },
  { eco: 'A04', name: 'Réti Opening', moves: ['Nf3'], plan: 'Develop first, and choose a central plan once Black commits.' },
  { eco: 'A00', name: 'Bird Opening', moves: ['f4'], plan: 'Fight for e5 immediately, at the cost of loosening the king.' },
];

export interface OpeningMatch {
  readonly entry: OpeningEntry;
  /** How many plies of the game the name covers. */
  readonly plies: number;
}

/**
 * Name the opening from the moves played, preferring the longest match so the
 * most specific name wins.
 */
export function identifyOpening(sanMoves: readonly string[]): OpeningMatch | null {
  let best: OpeningMatch | null = null;
  for (const entry of OPENINGS) {
    if (entry.moves.length > sanMoves.length) continue;
    const matches = entry.moves.every((move, i) => sanMoves[i] === move);
    if (!matches) continue;
    if (!best || entry.moves.length > best.plies) {
      best = { entry, plies: entry.moves.length };
    }
  }
  return best;
}

/** How many moves of book the game followed, for the review. */
export function bookDepth(sanMoves: readonly string[]): number {
  return identifyOpening(sanMoves)?.plies ?? 0;
}
