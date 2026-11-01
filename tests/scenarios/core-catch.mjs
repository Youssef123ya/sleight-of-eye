// Catch path on ?demo=core: in Act I's steal beat, LOOK at the coin while pinching it → the kits (who follow
// your gaze) see it → "I SAW THAT!" → giggles → rewind smear → back to the steal beat, coin home, no palm.
// Then do it properly (music box, blind pinch) and finish the act: 1 star (done, but caught once).
//   node tests/shot.mjs --url="http://127.0.0.1:8091/?demo=core" --xr --head=0,1.2,0 --look=0,0.9,-0.45 \
//        --scenario=tests/scenarios/core-catch.mjs --out=tests/out/core-catch.png
import { makeHelpers } from './core-lib.mjs';

export default async function catchPath(page, api) {
  const h = makeHelpers(page, api);
  const { note, waitFor, check, look, turnTo, reach, pinch, poke, where, state, events, add, failures, timeline } = h;
  try {
    await waitFor((s) => s.calibrated && s.act === 1 && s.started, 30000, 'show started');
    await page.evaluate(() => window.__app.skipTo(1, 2));
    await waitFor((s) => s.act === 1 && s.beatKind === 'steal' && s.phase === 'active', 5000, 'skipTo(1, 2) → steal beat');
    let s = await state();
    check(s.conesVisible === true, 'sight cones are shown during the steal', { cones: s.conesVisible });

    // ------------------------------------------------------------------ the mistake: watch your own hands
    const coin = await where('coin');
    const grab = add(coin, [0, 0.012, 0]);
    await look(add(coin, [0, 0.01, 0]));
    await page.waitForTimeout(1400);
    s = await state();
    check(s.watchers === 3, 'all three kits watch the coin you are looking at', { watchers: s.watchers });
    await reach(add(grab, [0.05, 0.12, 0.14]), grab, 0.9, 0);
    await pinch(1, 0.35);
    s = await waitFor((x) => x.phase === 'caught', 2000, 'pinching in plain sight is caught');
    const ev = await events();
    const caught = ev.find((e) => e.type === 'caught');
    check(!!caught && /^kit[123]$/.test(caught.data.by) && caught.data.prop === 'coin', "'caught' event names a kit and the coin", caught?.data);
    check(s.alarm === caught?.data.by, "the catcher's sight cone flashes (alarm)", { alarm: s.alarm });
    check(s.palmed === null && s.caught === 1, 'nothing palmed; one catch counted', { palmed: s.palmed, caught: s.caught });
    check(s.said.includes('fox: I SAW THAT!'), 'the catcher shouts "I SAW THAT!" (capitals: the animalese shout)', { said: s.said });
    await page.waitForTimeout(300);
    await api.shot('core-catch-caught');
    await pinch(0, 0.25);

    // ------------------------------------------------------------------ rewind: same beat, clean slate
    s = await waitFor((x) => x.phase === 'active' && x.beatKind === 'steal', 4000, 'rewind smear → back to the steal checkpoint');
    check(s.propModes.coin === 'home' && !s.gadgets.musicBox.used && s.alarm === null, 'coin home, gadgets re-armed, alarm cleared', {
      coin: s.propModes.coin,
      musicBox: s.gadgets.musicBox,
      alarm: s.alarm,
    });
    const steals = (await events()).filter((e) => e.type === 'beat:start' && e.data.kind === 'steal').length;
    check(steals >= 2, 'the steal beat restarted', { steals });

    // ------------------------------------------------------------------ do it right this time
    await reach(grab, add(grab, [0.06, 0.1, 0.12]), 0.4, 0);
    const box = await where('musicBox-focus');
    await turnTo(coin, box, 0.5);
    await waitFor((x) => x.gadgets.musicBox.active, 4000, 'music box fires');
    await page.waitForTimeout(1500);
    await reach(add(grab, [0.06, 0.1, 0.12]), grab, 0.7, 0);
    await pinch(1, 0.35);
    await waitFor((x) => x.beatKind === 'lookBack' && x.palmed === 'coin', 3000, 'blind pinch palms the coin');
    await pinch(0, 0.25);
    await reach(grab, add(grab, [0.08, 0.06, 0.16]), 0.4, 0);
    await turnTo(box, add(coin, [0, 0.003, 0]), 0.5);
    await waitFor((x) => x.beatKind === 'reveal' && x.phase === 'ready', 9000, 'look back → volunteer ready');
    const ear = await where((await state()).revealTarget);
    await poke(add(ear, [0.01, 0.01, 0.11]), ear, 1.2);
    s = await waitFor((x) => x.stars[0] >= 1, 8000, 'Act I complete');
    check(s.stars[0] === 1, 'a caught act earns exactly 1 star', { stars: s.stars });
  } catch (e) {
    if (!failures.includes(String(e?.message ?? e))) failures.push(String(e?.message ?? e));
  }
  note(failures.length ? `FAILED (${failures.length})` : 'PASSED');
  return { pass: failures.length === 0, failures, timeline };
}
