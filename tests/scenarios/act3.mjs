// tests/scenarios/act3.mjs (owned by Q)
// Act 3 — The Critic's Watch (+ Brock). Success: demo → show the watch → look at the firework fuse, hold Brock's eyes until he scribbles, BANG → palm the watch, load it into the cupcake box → look back → poke the cupcake → act complete. Catch: palm the watch while Brock watches your hands → caught, rewind, then the firework + fluster misdirection succeeds.
//
//   node tests/scenarios/act3.mjs [--url=http://127.0.0.1:8081/] [--demo=<name>] [--paths=success,catch]
//                            [--hand=right|left] [--easy] [--no-shots] [--require-app] [--timeout=240]
// Without window.__app (game not integrated yet) the run is reported as "skip" (exit 0) unless --require-app.
// Report: tests/out/scenarios/act3.md (+ .json), screenshots in tests/out/scenarios/act3-<path>/.
import { pathToFileURL } from 'node:url';
import { runAct, runActCli } from '../lib/acts.mjs';

export const act = 3;
export default (args = {}) => runAct(3, args);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runActCli(3);
