// Act II on ?demo=core: the magpie ignores your gaze and stares at the shiny ball. A steal while only the kits
// are distracted is caught BY THE MAGPIE; lighting the candle (gaze dwell) draws her too, then palm the ball
// and load it under the right cup before the flare dies, look back, poke the middle cup (empty) and the right
// cup (the ball).
//   node tests/shot.mjs --url="http://127.0.0.1:8091/?demo=core" --xr --head=0,1.2,0 --look=0,0.9,-0.45 \
//        --scenario=tests/scenarios/core-act2.mjs --out=tests/out/core-act2.png
import { makeHelpers } from './core-lib.mjs';

/** Act II from its rule demo to the Act III curtain (`skip`: jump there with skipTo first). Throws on a timeout. */
export async function playAct2(h, { skip = true } = {}) {
  const { page, api, waitFor, check, look, turnTo, reach, pinch, poke, where, state, events, add } = h;
  const magpieLooksAt = async (pt) => {
    const s = await state();
    const m = s.spectators.find((x) => x.id === 'magpie');
    const eye = await where('magpie-eyes');
    if (!m?.look || !eye) return 180;
    const d = [pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]];
    const len = Math.hypot(...d) || 1;
    const dot = (d[0] * m.look[0] + d[1] * m.look[1] + d[2] * m.look[2]) / len;
    return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  };
  {
    if (skip) {
      await waitFor((s) => s.calibrated && s.started, 30000, 'show started');
      await page.evaluate(() => window.__app.skipTo(2, 0));
    }
    await waitFor((s) => s.act === 2 && s.beatKind === 'demo' && s.phase === 'active', skip ? 5000 : 15000, 'Act II rule demo');
    const ball = await where('ball');
    // look far left: kits follow, the magpie keeps staring at the ball
    await turnTo([0, 0.9, -0.45], [-0.3, 0.92, -0.5], 0.5);
    await page.waitForTimeout(1500);
    const off = await magpieLooksAt(add(ball, [0, 0.015, 0]));
    check(off < 12, 'the magpie ignores the gaze and stares at the shiny ball', { degreesOff: Math.round(off) });
    await api.shot('core-act2-demo');
    await waitFor((s) => s.beatKind === 'show', 12000, 'demo → show');

    // show: lift the ball
    const grab = add(ball, [0, 0.015, 0]);
    await look(grab);
    await reach(add(grab, [0.05, 0.12, 0.14]), grab, 0.8, 0);
    await pinch(1, 0.35);
    await reach(grab, add(grab, [0, 0.07, 0.03]), 0.7, 1);
    await pinch(0, 0.3);
    await waitFor((s) => s.beatKind === 'steal', 6000, 'show → steal');

    // steal attempt 1: kits distracted by the music box, but the magpie still watches the ball → caught
    const box = await where('musicBox-focus');
    await reach(add(grab, [0, 0.07, 0.03]), add(grab, [0.06, 0.1, 0.12]), 0.3, 0);
    await turnTo(grab, box, 0.5);
    await waitFor((s) => s.gadgets.musicBox.active, 4000, 'music box fires (kits only)');
    await page.waitForTimeout(1300);
    await reach(add(grab, [0.06, 0.1, 0.12]), grab, 0.6, 0);
    await pinch(1, 0.3);
    let s = await waitFor((x) => x.phase === 'caught', 2000, 'the magpie catches the steal');
    check(s.lastCatch?.by === 'magpie', 'the catcher is the magpie', { lastCatch: s.lastCatch });
    await pinch(0, 0.2);
    await reach(grab, add(grab, [0.06, 0.1, 0.12]), 0.3, 0);
    await waitFor((x) => x.phase === 'active' && x.beatKind === 'steal', 4000, 'rewind to the steal');

    // steal attempt 2: the candle flare draws the magpie too; palm + load before it dies
    const candle = await where('candle-focus');
    await turnTo(box, candle, 0.4);
    await waitFor((x) => x.gadgets.candle.active, 4000, 'candle flares on gaze dwell');
    await page.waitForTimeout(900);
    const offFlare = await magpieLooksAt(candle);
    check(offFlare < 15, 'the magpie watches the flare', { degreesOff: Math.round(offFlare) });
    await api.shot('core-act2-flare');
    await reach(add(grab, [0.06, 0.1, 0.12]), grab, 0.5, 0);
    await pinch(1, 0.3);
    s = await waitFor((x) => x.beatKind === 'load' && x.palmed === 'ball', 2000, 'ball palmed during the flare');
    await pinch(0, 0.2);
    const cupR = await where('cupRight');
    const loadAt = add(cupR, [0, 0.06, 0]);
    await reach(grab, loadAt, 0.5, 0);
    await pinch(1, 0.3);
    s = await waitFor((x) => x.beatKind === 'lookBack', 2000, 'ball loaded under the right cup');
    check(s.loaded?.ball === 'cupRight' && s.caught === 1, 'loaded unseen', { loaded: s.loaded, caught: s.caught });
    await pinch(0, 0.2);
    await reach(loadAt, add(loadAt, [0.1, 0.05, 0.15]), 0.4, 0);

    // look back, then the two reveals
    await turnTo(candle, add(ball, [0, 0.003, 0]), 0.5);
    await waitFor((x) => x.beatKind === 'reveal' && x.phase === 'ready', 6000, 'look back → reveal ready');
    const cupM = await where('cupMid');
    await poke(add(cupM, [0, 0.06, 0.12]), add(cupM, [0, 0.055, 0]), 1.0);
    await waitFor((x) => x.beatName === 'cup-ball' && x.phase === 'ready', 5000, 'middle cup: empty → next reveal');
    await poke(add(cupR, [0, 0.06, 0.12]), add(cupR, [0, 0.055, 0]), 1.0);
    await page.waitForTimeout(900);
    await api.shot('core-act2-reveal');
    s = await waitFor((x) => x.stars[1] >= 1, 6000, 'Act II complete');
    check(s.stars[1] === 1, 'one catch → 1 star', { stars: s.stars });
    const kinds = (await events()).filter((e) => e.type === 'beat:start' && e.data.act === 2).map((e) => e.data.kind);
    check(
      JSON.stringify(kinds) === JSON.stringify(['demo', 'show', 'steal', 'steal', 'load', 'lookBack', 'reveal', 'reveal']),
      'Act II beat sequence (with one rewind)',
      { kinds },
    );
    await waitFor((x) => x.act === 3, 12000, 'curtain → Act III');
  }
}

export default async function act2(page, api) {
  const h = makeHelpers(page, api);
  const { note, failures, timeline } = h;
  try {
    await playAct2(h, { skip: true });
  } catch (e) {
    if (!failures.includes(String(e?.message ?? e))) failures.push(String(e?.message ?? e));
  }
  note(failures.length ? `FAILED (${failures.length})` : 'PASSED');
  return { pass: failures.length === 0, failures, timeline };
}
