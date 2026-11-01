// Act III + the bow on ?demo=core: Sir Brock watches your HANDS (not your gaze); holding his eyes for 1 s
// flusters him into his notebook. Brock lends his watch, you lift it, light the firework fuse by looking at
// it, and when it BANGs every free head looks up — palm the watch and load it into the cupcake box, look
// back, poke the cupcake: the watch rises, standing ovation, then the bow with the review.
//   node tests/shot.mjs --url="http://127.0.0.1:8091/?demo=core" --xr --head=0,1.2,0 --look=0,0.9,-0.45 \
//        --scenario=tests/scenarios/core-act3.mjs --out=tests/out/core-act3.png
import { makeHelpers } from './core-lib.mjs';

export default async function act3(page, api) {
  const h = makeHelpers(page, api);
  const { note, waitFor, check, look, turnTo, reach, pinch, poke, where, state, events, add, failures, timeline } = h;
  const angleTo = async (id, pt) => {
    const s = await state();
    const m = s.spectators.find((x) => x.id === id);
    const eye = await where(`${id}-eyes`);
    if (!m?.look || !eye) return 180;
    const d = [pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]];
    const len = Math.hypot(...d) || 1;
    const dot = (d[0] * m.look[0] + d[1] * m.look[1] + d[2] * m.look[2]) / len;
    return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  };
  try {
    await waitFor((s) => s.calibrated && s.started, 30000, 'show started');
    await page.evaluate(() => window.__app.skipTo(3, 0));
    await waitFor((s) => s.act === 3 && s.beatKind === 'demo' && s.phase === 'active', 5000, 'Act III rule demo');

    // Brock watches the hand, wherever you look
    const handAt = [0.2, 0.98, -0.32];
    await reach([0.25, 0.95, -0.2], handAt, 0.6, 0);
    await turnTo([0, 0.9, -0.45], [-0.3, 0.92, -0.5], 0.4);
    await page.waitForTimeout(1200);
    const offHand = await angleTo('brock', handAt);
    check(offHand < 15, 'Brock watches the hand, not the gaze', { degreesOff: Math.round(offHand) });
    await api.shot('core-act3-hands');

    // hold his eyes → flustered (notebook), the demo ends
    const eyes = await where('brock-eyes');
    await turnTo([-0.3, 0.92, -0.5], eyes, 0.4);
    let s = await waitFor((x) => x.spectators.find((y) => y.id === 'brock')?.flustered, 3000, 'eye contact ≥ 1 s flusters Brock');
    await page.waitForTimeout(400);
    await api.shot('core-act3-fluster');
    await waitFor((x) => x.beatName === 'lend-watch', 5000, 'demo → Brock lends his watch');
    await waitFor((x) => x.beatKind === 'show', 6000, 'the watch is on the mat → show');
    const watch = await where('watch');
    const grab = add(watch, [0, 0.01, 0]);
    await look(grab);
    await reach(add(grab, [0.05, 0.12, 0.14]), grab, 0.8, 0);
    await pinch(1, 0.35);
    await reach(grab, add(grab, [0, 0.07, 0.03]), 0.7, 1);
    await pinch(0, 0.3);
    await waitFor((x) => x.beatKind === 'steal', 6000, 'show → steal');

    // the firework: look at the fuse, wait for the BANG, then palm + load during the bang look
    await reach(add(grab, [0, 0.07, 0.03]), [0.25, 0.95, -0.2], 0.4, 0);
    const fw = await where('firework-focus');
    await turnTo(grab, fw, 0.5);
    await waitFor((x) => x.gadgets.firework.active, 4000, 'fuse lit by gaze dwell');
    await waitFor((x) => x.bangActive, 6000, 'BANG (fuse burnt down)');
    await page.waitForTimeout(900); // heads snap up to the burst
    const burst = await page.evaluate(() => {
      const w = window.__app.where('StageRig');
      return w ? [w[0], w[1] + 0.12, w[2] - 0.95] : null;
    });
    s = await state();
    const looks = await Promise.all(['kit1', 'brock', 'magpie'].map((id) => angleTo(id, burst)));
    check(looks.every((a) => a < 25), 'BANG: kits, magpie and Brock all look up at the burst', { degreesOff: looks.map(Math.round) });
    await api.shot('core-act3-bang');
    await reach([0.25, 0.95, -0.2], grab, 0.45, 0);
    await pinch(1, 0.3);
    s = await waitFor((x) => x.beatKind === 'load' && x.palmed === 'watch', 2000, 'watch palmed during the bang');
    await pinch(0, 0.2);
    const cake = await where('cupcake');
    const loadAt = add(cake, [0, 0.06, 0]);
    await reach(grab, loadAt, 0.45, 0);
    await pinch(1, 0.3);
    s = await waitFor((x) => x.beatKind === 'lookBack', 2000, 'watch loaded into the cupcake box');
    check(s.loaded === 'watch->cupcake' && s.caught === 0, 'loaded unseen', { loaded: s.loaded, caught: s.caught });
    await pinch(0, 0.2);
    await reach(loadAt, add(loadAt, [0.1, 0.05, 0.15]), 0.4, 0);

    // look back → poke the cupcake → the watch rises → ovation
    await turnTo(fw, add(watch, [0, 0.003, 0]), 0.5);
    await waitFor((x) => x.beatKind === 'reveal' && x.phase === 'ready', 6000, 'look back → reveal ready');
    await poke(add(cake, [0, 0.07, 0.12]), add(cake, [0, 0.055, 0]), 1.0);
    await page.waitForTimeout(1500);
    await api.shot('core-act3-reveal');
    s = await waitFor((x) => x.stars[2] >= 1, 8000, 'Act III complete');
    check(s.stars[2] >= 2, 'clean act → ≥ 2 stars', { stars: s.stars });

    // the bow
    s = await waitFor((x) => x.act === 4 && x.beatKind === 'bow' && x.phase === 'active', 15000, 'curtain call');
    await page.waitForTimeout(2200);
    s = await state();
    check(s.reviewShown, 'the newspaper review was handed to the UI', { reviewShown: s.reviewShown });
    const exitPlaque = await where('plaque-exit');
    const retryPlaque = await where('plaque-retry');
    check(!!exitPlaque && !!retryPlaque, 'Retry + Exit plaques at the bow');
    await api.shot('core-act3-bow');
  } catch (e) {
    if (!failures.includes(String(e?.message ?? e))) failures.push(String(e?.message ?? e));
  }
  note(failures.length ? `FAILED (${failures.length})` : 'PASSED');
  return { pass: failures.length === 0, failures, timeline };
}
