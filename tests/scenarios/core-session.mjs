// Session + accessibility on ?demo=core: pause/resume on visibilityState (curtain, frozen audience, beat clock
// stops), "Hold it!" while the palming hand is untracked (the palm survives), Retry + Recenter plaques (poked),
// Assist (the rabbit does the reaching: pinch anywhere; reveals become look + pinch) and Easy Audience
// (gadget windows last until the move is done).
//   node tests/shot.mjs --url="http://127.0.0.1:8091/?demo=core" --xr --head=0,1.2,0 --look=0,0.9,-0.45 \
//        --scenario=tests/scenarios/core-session.mjs --out=tests/out/core-session.png
import { makeHelpers } from './core-lib.mjs';

export default async function session(page, api) {
  const h = makeHelpers(page, api);
  const { note, waitFor, check, look, turnTo, reach, pinch, poke, where, state, events, add, failures, timeline } = h;
  const visibility = (v) => page.evaluate((x) => window.IWER_DEVICE.updateVisibilityState(x), v);
  const setHand = (connected) => page.evaluate((c) => (window.IWER_DEVICE.hands.right.connected = c), connected);
  const pokePlaque = async (action) => {
    const p = await where(`plaque-${action}`);
    if (!p) throw new Error(`plaque-${action} missing`);
    await poke(add(p, [0, 0.07, 0.07]), p, 0.9);
  };
  try {
    await waitFor((s) => s.calibrated && s.started, 30000, 'show started');
    await page.evaluate(() => window.__app.skipTo(1, 2));
    await waitFor((s) => s.beatKind === 'steal' && s.phase === 'active', 5000, 'steal beat');

    // ------------------------------------------------------------------ pause / resume
    // blurred (system menu over the app): frames keep rendering → the curtain drops, the audience freezes
    await visibility('visible-blurred');
    await waitFor((x) => x.paused, 2000, 'visible-blurred → paused');
    await page.waitForTimeout(1300);
    await api.shot('core-session-blurred');
    await visibility('visible');
    await waitFor((x) => !x.paused && x.running, 2000, 'visible → resumed');
    await page.waitForTimeout(1000);
    // hidden: no frames at all
    await visibility('hidden');
    let s = await waitFor((x) => x.paused, 2000, 'hidden → paused');
    const t1 = s.beatTime;
    check(!s.running, 'trick runner stopped while paused');
    await page.waitForTimeout(1200);
    s = await state();
    check(s.beatTime === t1, 'the beat clock does not advance while paused', { before: t1, after: s.beatTime });
    await visibility('visible');
    s = await waitFor((x) => !x.paused && x.running, 2000, 'visible → resumed on the same beat');
    check(s.beatKind === 'steal', 'same beat after resume', { kind: s.beatKind });
    const vis = (await events()).filter((e) => e.type === 'session:visibility').map((e) => e.data.state);
    check(vis.includes('blurred') && vis.includes('hidden') && vis.includes('visible'), "'session:visibility' events", { vis });

    // ------------------------------------------------------------------ Hold it!: palm, then lose the hand
    const coin = await where('coin');
    const grab = add(coin, [0, 0.012, 0]);
    const box = await where('musicBox-focus');
    await turnTo([0, 0.9, -0.45], box, 0.4);
    await waitFor((x) => x.gadgets.musicBox.active, 4000, 'music box fires');
    await page.waitForTimeout(1300);
    await reach(add(grab, [0.06, 0.1, 0.12]), grab, 0.6, 0);
    await pinch(1, 0.3);
    await waitFor((x) => x.palmed === 'coin', 2000, 'coin palmed');
    await pinch(0, 0.2);
    await setHand(false);
    s = await waitFor((x) => x.holdIt, 2000, 'palming hand lost → "Hold it!"');
    check(s.palmed === 'coin' && !s.running, 'palm survives tracking loss; the show holds', { palmed: s.palmed, running: s.running });
    await api.shot('core-session-holdit');
    await setHand(true);
    s = await waitFor((x) => !x.holdIt && x.running, 3000, 'hand back → show resumes');
    check(s.palmed === 'coin', 'still palmed after the hand returns');

    // ------------------------------------------------------------------ Retry plaque: back to the checkpoint
    await turnTo(box, [0, 0.9, -0.42], 0.4);
    await reach(grab, add(grab, [0.1, 0.08, 0.15]), 0.4, 0);
    await pokePlaque('retry');
    s = await waitFor((x) => x.beatKind === 'steal' && x.phase === 'active' && x.palmed === null, 4000, 'Retry → steal checkpoint, coin back');
    check(s.caught === 0, 'Retry is not a catch', { caught: s.caught });

    // ------------------------------------------------------------------ Recenter plaque
    const before = s.calibrations;
    await pokePlaque('recenter');
    s = await waitFor((x) => x.calibrations > before, 3000, 'Recenter recalibrates the stage');

    // ------------------------------------------------------------------ Assist: the rabbit does the reaching
    await page.evaluate(() => window.__app.setSettings({ assist: true }));
    s = await waitFor((x) => x.assistRabbit, 2000, 'assist on → the rabbit appears');
    await turnTo([0, 0.9, -0.42], box, 0.4);
    await page.waitForTimeout(1600); // the music box was used: re-armed after a retry
    s = await state();
    if (!s.gadgets.musicBox.active) await waitFor((x) => x.gadgets.musicBox.active, 4000, 'music box fires (assist)');
    await page.waitForTimeout(1300);
    await reach([0.25, 0.95, -0.15], [0.26, 0.96, -0.14], 0.3, 0); // nowhere near the coin
    await pinch(1, 0.3);
    s = await waitFor((x) => x.beatKind === 'lookBack' && x.palmedBy === 'rabbit', 2000, 'pinch anywhere → the rabbit palms the coin');
    await api.shot('core-session-assist');
    await pinch(0, 0.2);
    await turnTo(box, add(coin, [0, 0.003, 0]), 0.4);
    await waitFor((x) => x.beatKind === 'reveal' && x.phase === 'ready', 8000, 'look back → reveal ready');
    const ear = await where('kit3-ear');
    await turnTo(add(coin, [0, 0.003, 0]), ear, 0.3);
    await waitFor((x) => x.gazeTarget === 'kit3-ear', 2000, 'gaze on the volunteer ear');
    await pinch(1, 0.3);
    const ev = await events();
    check(ev.some((e) => e.type === 'revealed'), 'assist reveal = look + pinch');
    await pinch(0, 0.2);
    await page.evaluate(() => window.__app.setSettings({ assist: false }));

    // ------------------------------------------------------------------ Easy Audience: windows last until used
    await page.evaluate(() => window.__app.setSettings({ easyAudience: true }));
    await page.evaluate(() => window.__app.skipTo(2, 2));
    await waitFor((x) => x.act === 2 && x.beatKind === 'steal' && x.phase === 'active', 5000, 'Act II steal (easy)');
    const candle = await where('candle-focus');
    await turnTo([0, 0.9, -0.42], candle, 0.4);
    await waitFor((x) => x.gadgets.candle.active, 4000, 'candle flares');
    await page.waitForTimeout(6500); // longer than the 5 s flare
    s = await state();
    check(s.gadgets.candle.active, 'Easy Audience: the flare outlasts its 5 s window', { candle: s.gadgets.candle });
    const ball = await where('ball');
    const bgrab = add(ball, [0, 0.015, 0]);
    await reach(add(bgrab, [0.06, 0.1, 0.12]), bgrab, 0.5, 0);
    await pinch(1, 0.3);
    await waitFor((x) => x.beatKind === 'load', 2000, 'ball palmed (easy)');
    await pinch(0, 0.2);
    const cupR = await where('cupRight');
    await reach(bgrab, add(cupR, [0, 0.06, 0]), 0.5, 0);
    await pinch(1, 0.3);
    await waitFor((x) => x.beatKind === 'lookBack', 2000, 'ball loaded (easy)');
    await pinch(0, 0.2);
    s = await waitFor((x) => !x.gadgets.candle.active, 2000, 'the window closes once the move is done');
    check(s.caught === 0, 'no catches in Easy Audience', { caught: s.caught });
    await page.evaluate(() => window.__app.setSettings({ easyAudience: false }));
  } catch (e) {
    if (!failures.includes(String(e?.message ?? e))) failures.push(String(e?.message ?? e));
  }
  note(failures.length ? `FAILED (${failures.length})` : 'PASSED');
  return { pass: failures.length === 0, failures, timeline };
}
