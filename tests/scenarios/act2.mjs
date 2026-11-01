// tests/scenarios/act2.mjs (owned by Q)
// Act 2 — Cups & Ball (+ magpie). Success: demo → show ball → look at the candle (flare holds the magpie and the kits), palm the ball, load it under the right cup without looking → look back → poke the middle cup (empty), then the right cup (ball) → act complete. Catch: palm the ball while the magpie stares at it → caught, rewind, then a candle-misdirected steal succeeds.
//
//   node tests/scenarios/act2.mjs [--url=http://127.0.0.1:8081/] [--demo=<name>] [--paths=success,catch]
//                            [--hand=right|left] [--easy] [--no-shots] [--require-app] [--timeout=240]
// Without window.__app (game not integrated yet) the run is reported as "skip" (exit 0) unless --require-app.
// Report: tests/out/scenarios/act2.md (+ .json), screenshots in tests/out/scenarios/act2-<path>/.
import { pathToFileURL } from 'node:url';
import { runAct, runActCli } from '../lib/acts.mjs';

export const act = 2;
export default (args = {}) => runAct(2, args);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runActCli(2);
