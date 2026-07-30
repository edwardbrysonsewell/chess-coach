/**
 * Independent perft ground truth, computed by the vendored Stockfish 18 build
 * via its own `go perft` command. Stockfish's move generator is the most
 * heavily tested one in existence, so its counts are the oracle the chess.js
 * suite in tests/perft.test.ts is measured against.
 *
 * Usage: node tools/perft-stockfish.cjs
 */
const initEngine = require("stockfish");

const POSITIONS = [
  {
    id: "startpos",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    depths: [1, 2, 3, 4, 5],
  },
  {
    id: "kiwipete",
    fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    depths: [1, 2, 3, 4],
  },
  {
    // CPW position 3: rook/pawn endgame, dense en-passant and check interaction.
    id: "pos3-ep",
    fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    depths: [1, 2, 3, 4, 5],
  },
  {
    // CPW position 4: promotions, including promotion with check.
    id: "pos4-promo",
    fen: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    depths: [1, 2, 3, 4],
  },
  {
    // CPW position 5: known to catch castling and en-passant legality bugs.
    id: "pos5",
    fen: "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    depths: [1, 2, 3, 4],
  },
  {
    // CPW position 6: quiet middlegame, broad coverage.
    id: "pos6",
    fen: "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    depths: [1, 2, 3, 4],
  },
];

initEngine("lite-single").then((engine) => {
  let onLine = () => {};
  const handle = (l) => onLine(String(l).trim());
  if (typeof engine.addMessageListener === "function") engine.addMessageListener(handle);
  else { engine.listener = handle; engine.print = handle; engine.printErr = handle; }

  const send = (c) => engine.sendCommand(c);
  const waitFor = (pred, label, ms = 600000) =>
    new Promise((resolve, reject) => {
      const lines = [];
      const timer = setTimeout(() => reject(new Error("timeout: " + label)), ms);
      onLine = (line) => {
        lines.push(line);
        if (pred(line)) { clearTimeout(timer); onLine = () => {}; resolve(lines); }
      };
    });

  const out = {};
  send("uci");
  return waitFor((l) => l === "uciok", "uciok")
    .then(() => { send("isready"); return waitFor((l) => l === "readyok", "readyok"); })
    .then(() =>
      POSITIONS.reduce(
        (chain, pos) =>
          chain.then(() =>
            pos.depths.reduce(
              (c2, d) =>
                c2.then(() => {
                  send("position fen " + pos.fen);
                  send("go perft " + d);
                  return waitFor(
                    (l) => /^Nodes searched:/.test(l),
                    `perft ${pos.id} d${d}`
                  ).then((lines) => {
                    const line = lines.find((l) => /^Nodes searched:/.test(l));
                    const n = Number(/(\d+)/.exec(line)[1]);
                    (out[pos.id] = out[pos.id] || {})[d] = n;
                    console.log(`${pos.id.padEnd(11)} depth ${d}: ${n.toLocaleString()}`);
                  });
                }),
              Promise.resolve()
            )
          ),
        Promise.resolve()
      )
    )
    .then(() => {
      console.log("\n--- JSON ---");
      console.log(JSON.stringify(
        POSITIONS.map((p) => ({ id: p.id, fen: p.fen, nodes: out[p.id] })),
        null, 2
      ));
      send("quit");
      process.exit(0);
    });
}).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
