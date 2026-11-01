// Act I end to end on ?demo=core (stub services), hands only, in IWER:
// intro (heads follow the gaze) → show (pinch-lift the coin) → steal (look at the music box, pinch the coin
// WITHOUT looking) → look back (gasp) → reveal (poke the volunteer kit's ear) → act complete → Act II.
//   node tests/shot.mjs --url="http://127.0.0.1:8081/?demo=core" --xr --head=0,1.2,0 --look=0,0.9,-0.45 \
//        --scenario=tests/scenarios/core-act1.mjs --out=tests/out/core-act1.png
import { makeHelpers } from './core-lib.mjs';

export default async function act1(page, api) {
  const h = makeHelpers(page, api);
  const { note, waitFor, check, look, turnTo, reach, pinch, poke, where, state, events, add, failures, timeline } = h;
  try {
    await waitFor((s) => s.calibrated && s.act === 1 && s.beatKind === 'intro' && s.phase === 'active', 30000, 'Act I intro running');

    // ------------------------------------------------------------------ intro: they look where you look
    const left = [-0.28, 0.905, -0.48];
    const right = [0.28, 0.905, -0.48];
    await turnTo([0, 0.9, -0.45], left, 0.6);
    await page.waitForTimeout(1300);
    let s = await state();
    const lookLeft = s.spectators.map((x) => x.look?.[0] ?? 0);
    check(lookLeft.every((x) => x < -0.05), 'kits follow the gaze to the left', { lookX: lookLeft });
    await turnTo(left, right, 0.9);
    await page.waitForTimeout(1300);
    s = await state();
    const lookRight = s.spectators.map((x) => x.look?.[0] ?? 0);
    check(lookRight.every((x) => x > 0.05), 'kits follow the gaze to the right', { lookX: lookRight });
    // eye contact: hold kit2's eyes → it looks back at your face
    const kit2 = await where('kit2-eyes');
    await turnTo(right, kit2, 0.4);
    await waitFor((x) => x.spectators.find((k) => k.id === 'kit2')?.eyeContact, 2500, 'eye contact ≥ 0.6 s: kit2 looks back');
    await page.waitForTimeout(800); // springy head turn
    s = await state();
    const k2 = s.spectators.find((k) => k.id === 'kit2');
    check(k2.look[2] > 0.5, 'kit2 faces the player (+Z)', { look: k2.look });
    await turnTo(kit2, [0, 0.9, -0.42], 0.6);
    s = await waitFor((x) => x.beatKind === 'show', 12000, 'intro → show');
    s = await waitFor((x) => x.hint === 'pinch', 1500, 'first pinch: the ghost-hand hint shows immediately');

    // ------------------------------------------------------------------ show: pinch-lift the coin
    const coin = await where('coin');
    check(!!coin, 'coin object is named "coin"', { coin });
    const grab = add(coin, [0, 0.012, 0]);
    await look(add(coin, [0, 0.01, 0]));
    await reach(add(grab, [0.05, 0.12, 0.14]), grab, 0.9, 0);
    await pinch(1, 0.4);
    s = await state();
    check(s.lifted === 'coin', 'pinch near the coin lifts it', { lifted: s.lifted, pinch: s.hands.right.pinch, coin });
    await reach(grab, add(grab, [0, 0.07, 0.03]), 0.8, 1);
    await page.waitForTimeout(400);
    s = await state();
    check(s.watchers >= 2, 'kits watch the lifted coin', { watchers: s.watchers });
    await pinch(0, 0.3);
    await waitFor((x) => x.beatKind === 'steal', 6000, 'release → coin glides home → steal');
    s = await state();
    check(s.propModes.coin === 'home', 'coin is back on its mark', { mode: s.propModes.coin });

    // ------------------------------------------------------------------ steal: look away, pinch blind
    s = await waitFor((x) => x.hint === 'gaze', 1500, 'first gaze trail: drifts to the music box immediately');
    await reach(add(grab, [0, 0.07, 0.03]), add(grab, [0.06, 0.1, 0.12]), 0.4, 0);
    const box = await where('musicBox-focus');
    check(!!box, 'gadget focus is named "musicBox-focus"', { box });
    await turnTo([0, 0.9, -0.42], box, 0.5);
    await waitFor((x) => x.gadgets.musicBox.active, 4000, 'music box fires on a 0.6 s gaze dwell');
    await page.waitForTimeout(1500);
    s = await state();
    check(s.watchers === 0, 'nobody watches the mat while the music box plays', { watchers: s.watchers, looks: s.spectators.map((x) => x.look) });
    await api.shot('core-act1-steal');
    await reach(add(grab, [0.06, 0.1, 0.12]), grab, 0.7, 0);
    await pinch(1, 0.35);
    s = await waitFor((x) => x.beatKind === 'lookBack', 3000, 'blind pinch palms the coin');
    check(s.palmed === 'coin' && s.caught === 0, 'coin palmed, not caught', { palmed: s.palmed, caught: s.caught });
    await pinch(0, 0.3);
    await reach(grab, add(grab, [0.08, 0.06, 0.16]), 0.5, 0);
    s = await state();
    check(s.palmed === 'coin', 'the palm is sticky across pinch release', { palmed: s.palmed });

    // ------------------------------------------------------------------ look back: the gasp
    const matSpot = add(coin, [0, 0.003, 0]);
    await turnTo(box, matSpot, 0.5);
    await waitFor((x) => x.beatKind === 'reveal', 5000, 'look back → gasp → reveal');
    await waitFor((x) => x.phase === 'ready', 6000, 'volunteer kit hops onto the mat');
    await api.shot('core-act1-volunteer');

    // ------------------------------------------------------------------ reveal: poke the volunteer's ear
    const ear = await where('kit3-ear');
    check(!!ear, 'volunteer ear anchor is named "kit3-ear"', { ear });
    await poke(add(ear, [0.01, 0.01, 0.11]), ear, 1.2);
    const ev = await events();
    check(ev.some((e) => e.type === 'poke' && e.data.targetId === 'kit3-ear'), 'fingertip poke registered on the ear');
    check(ev.some((e) => e.type === 'revealed'), 'poke reveals the coin');
    await page.waitForTimeout(700);
    await api.shot('core-act1-reveal');
    s = await waitFor((x) => x.stars[0] >= 1, 8000, 'Act I complete with stars');
    check(s.stars[0] >= 2, 'clean act earns ≥ 2 stars', { stars: s.stars, quick: s.quickReveal });
    const ev2 = await events();
    const kinds = ev2.filter((e) => e.type === 'beat:start' && e.data.act === 1).map((e) => e.data.kind);
    check(JSON.stringify(kinds) === JSON.stringify(['intro', 'show', 'steal', 'lookBack', 'reveal']), 'Act I beat sequence', { kinds });
    check(ev2.some((e) => e.type === 'act:complete' && e.data.act === 1), "'act:complete' emitted");
    await waitFor((x) => x.act === 2 && x.beatKind === 'demo', 15000, 'curtain → Act II demo');
  } catch (e) {
    if (!failures.includes(String(e?.message ?? e))) failures.push(String(e?.message ?? e));
  }
  note(failures.length ? `FAILED (${failures.length})` : 'PASSED');
  return { pass: failures.length === 0, failures, timeline };
}
