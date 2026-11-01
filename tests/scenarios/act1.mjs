// tests/scenarios/act1.mjs (owned by Q)
// Act 1 — Vanishing Coin (kits). Success: intro → show coin → look at the music box, palm the coin unseen → look back → poke the volunteer kit's ear → act complete with no catches. Catch: palm the coin while the kits watch the mat → "I SAW THAT!", the beat rewinds, then a misdirected steal succeeds.
//
//   node tests/scenarios/act1.mjs [--url=http://127.0.0.1:8081/] [--demo=<name>] [--paths=success,catch]
//                            [--hand=right|left] [--easy] [--no-shots] [--require-app] [--timeout=240]
// Without window.__app (game not integrated yet) the run is reported as "skip" (exit 0) unless --require-app.
// Report: tests/out/scenarios/act1.md (+ .json), screenshots in tests/out/scenarios/act1-<path>/.
import { pathToFileURL } from 'node:url';
import { runAct, runActCli } from '../lib/acts.mjs';

export const act = 1;
export default (args = {}) => runAct(1, args);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runActCli(1);
