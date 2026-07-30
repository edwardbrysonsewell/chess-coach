/**
 * Spike 2 baseline: boot the vendored lite single-threaded Stockfish 18 build
 * in Node, run `uci` / `isready`, then search two positions and report the
 * engine's own reported nodes-per-second. Desktop baseline only; the iPhone
 * number has to be measured in mobile Safari.
 *
 * Usage: node tools/bench-node.cjs [lite-single|single|lite]
 */
const initEngine = require("stockfish");

const FLAVOR = process.argv[2] || "lite-single";
const POSITIONS = [
  { name: "startpos", cmd: "position startpos" },
  {
    name: "kiwipete",
    cmd: "position fen r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  },
];
const DEPTH = 16;

function run() {
  return initEngine(FLAVOR).then((engine) => {
    let onLine = () => {};
    const handle = (line) => onLine(String(line).trim());
    if (typeof engine.addMessageListener === "function") {
      engine.addMessageListener(handle);
    } else {
      engine.listener = handle;
      engine.print = handle;
      engine.printErr = handle;
    }

    const send = (cmd) => engine.sendCommand(cmd);
    const waitFor = (predicate, label, timeoutMs = 120000) =>
      new Promise((resolve, reject) => {
        const lines = [];
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for ${label}`)),
          timeoutMs
        );
        onLine = (line) => {
          lines.push(line);
          if (predicate(line)) {
            clearTimeout(timer);
            onLine = () => {};
            resolve(lines);
          }
        };
      });

    const results = [];
    send("uci");
    return waitFor((l) => l === "uciok", "uciok", 60000)
      .then((lines) => {
        const id = lines.find((l) => l.startsWith("id name"));
        console.log(`engine: ${id || "(no id line)"}`);
        send("isready");
        return waitFor((l) => l === "readyok", "readyok");
      })
      .then(() => {
        console.log("readyok received");
        return POSITIONS.reduce(
          (chain, pos) =>
            chain.then(() => {
              send(pos.cmd);
              const t0 = process.hrtime.bigint();
              send(`go depth ${DEPTH}`);
              return waitFor(
                (l) => l.startsWith("bestmove"),
                `bestmove for ${pos.name}`
              ).then((lines) => {
                const ms = Number(process.hrtime.bigint() - t0) / 1e6;
                const last = lines.filter((l) => l.startsWith("info depth")).pop() || "";
                const nps = /\bnps (\d+)/.exec(last);
                const nodes = /\bnodes (\d+)/.exec(last);
                const best = lines.find((l) => l.startsWith("bestmove"));
                results.push({
                  pos: pos.name,
                  depth: DEPTH,
                  ms: Math.round(ms),
                  nodes: nodes ? Number(nodes[1]) : null,
                  nps: nps ? Number(nps[1]) : null,
                  best,
                });
              });
            }),
          Promise.resolve()
        );
      })
      .then(() => {
        console.log(`\nflavor: ${FLAVOR}`);
        for (const r of results) {
          console.log(
            `${r.pos.padEnd(9)} depth ${r.depth}  ${String(r.ms).padStart(6)} ms  ` +
              `nodes ${String(r.nodes).padStart(10)}  nps ${String(r.nps).padStart(9)}  ${r.best}`
          );
        }
        send("quit");
        process.exit(0);
      });
  });
}

run().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
