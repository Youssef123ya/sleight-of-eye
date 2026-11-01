// The calm 2D attract view behind the landing page, on the real game or ?demo=core. Run WITHOUT --xr (it checks
// the page before the first Enter, then enters XR itself through the landing's Enter button):
//   before Enter: no show running, Act I's kits idling on their seats, the coin alone on its mark, curtain open
//   → Enter → Act I steal: the music box plays (stop handle kept), a catch shouts "I SAW THAT!" in capitals and
//     cuts the tune → fire it again → Exit mid-beat: the attract view again, the tune stopped, nothing left over
//   → re-Enter: the show resumes at the autosaved checkpoint (Act I steal)
//   → the reveal's volunteer hops onto the mat → Exit: it hops home, attract view.
//   node tests/shot.mjs --url="http://127.0.0.1:8081/" --scenario=tests/scenarios/core-attract.mjs \
//        --out=tests/out/core-attract.png
import { enterXR } from '../lib/iwer.mjs';
import { HEAD, makeHelpers } from './core-lib.mjs';

export default async function attractView(page, api) {
  const h = makeHelpers(page, api);
  const { note, waitFor, check, look, turnTo, reach, pinch, where, state, stage, add, failures, timeline } = h;
  const { checkAttract, pokeExit, reenter } = h;
  const stubLog = () => page.evaluate(() => window.__audioStub?.log?.slice() ?? null);
  const exitAndSettle = async (label) => {
    await pokeExit();
    await waitFor((x) => !x.immersive, 6000, `${label}: Exit plaque → leaves XR`);
    await page.waitForTimeout(1800); // the curtain finishes opening (1.3 s)
  };
  try {
    // ------------------------------------------------------------------ before the first Enter
    await waitFor((s) => typeof s.attract === 'boolean', 20000, 'game API up (2D, before Enter)');
    await page.waitForTimeout(1500);
    await checkAttract('before Enter');
    await api.shot('core-attract-before-enter');

    // ------------------------------------------------------------------ Enter through the landing button
    await enterXR(page, { fov: 60, head: HEAD, look: [0, 0.9, -0.45] });
    let s = await waitFor((x) => x.immersive && x.calibrated && x.started && !x.attract, 30000, 'Enter → the show takes the stage');
    check(!s.audienceIdle, 'the attention rules drive the audience again', { idle: s.audienceIdle });
    await waitFor((x) => x.act === 1 && x.phase === 'active', 15000, 'Act I running');

    // ------------------------------------------------------------------ the music box tune, a catch, the shout
    await page.evaluate(() => window.__app.skipTo(1, 2));
    await waitFor((x) => x.act === 1 && x.beatKind === 'steal' && x.phase === 'active', 5000, 'Act I steal');
    const coin = await where('coin');
    const grab = add(coin, [0, 0.012, 0]);
    const box = await where('musicBox-focus');
    await turnTo([0, 0.9, -0.45], box, 0.4);
    s = await waitFor((x) => x.gadgets.musicBox.active, 4000, 'music box fires on a gaze dwell');
    check(s.musicBoxPlaying, 'its melody plays (the game holds the stop handle)', { playing: s.musicBoxPlaying });
    await look(add(coin, [0, 0.01, 0])); // watch your own hands …
    await page.waitForTimeout(1400);
    await reach(add(grab, [0.05, 0.12, 0.14]), grab, 0.7, 0);
    await pinch(1, 0.3);
    s = await waitFor((x) => x.phase === 'caught', 2500, '… and get caught');
    check(s.said.some((l) => /^fox: I SAW THAT!$/.test(l)), 'the catch is shouted in capitals ("I SAW THAT!")', { said: s.said });
    check(!s.musicBoxPlaying, 'the catch cuts the music box off', { playing: s.musicBoxPlaying });
    await pinch(0, 0.2);
    await reach(grab, add(grab, [0.06, 0.1, 0.12]), 0.3, 0);
    s = await waitFor((x) => x.phase === 'active' && x.beatKind === 'steal', 5000, 'rewind to the steal');
    check(!s.gadgets.musicBox.active && !s.gadgets.musicBox.used, 'the rewind re-arms the music box', { musicBox: s.gadgets.musicBox });
    await turnTo(add(coin, [0, 0.01, 0]), box, 0.4);
    s = await waitFor((x) => x.gadgets.musicBox.active && x.musicBoxPlaying, 4000, 'the music box plays again');
    let log = await stubLog();
    if (log) check(log.filter((l) => l === 'stop:musicBox').length >= 1, 'stub audio: the first tune was stopped', { log: log.slice(-12) });

    // ------------------------------------------------------------------ Exit mid-beat: the attract view
    await exitAndSettle('mid-steal');
    await checkAttract('after Exit mid-beat');
    log = await stubLog();
    if (log) {
      const lastStart = log.lastIndexOf(log.filter((l) => l.startsWith('musicBox:')).pop());
      check(lastStart >= 0 && log.indexOf('stop:musicBox', lastStart) > lastStart, 'stub audio: Exit stopped the playing tune', { log: log.slice(-12) });
    }
    const save = await page.evaluate(() => JSON.parse(localStorage.getItem('sleight-of-eye.save.v1') ?? 'null'));
    check(save?.act === 1 && save?.beat === 2, 'the autosave holds the steal checkpoint', { act: save?.act, beat: save?.beat });
    await api.shot('core-attract-after-exit');

    // ------------------------------------------------------------------ re-Enter: resume at the checkpoint
    await reenter();
    s = await waitFor((x) => x.immersive && x.calibrated && x.started && x.act === 1 && x.beatKind === 'steal' && x.phase === 'active', 20000, 're-Enter → Act I steal resumes');
    check(s.propModes.coin === 'home' && !s.gadgets.musicBox.used && s.palmed === null, 'a clean steal attempt', {
      coin: s.propModes.coin,
      musicBox: s.gadgets.musicBox,
    });

    // ------------------------------------------------------------------ the volunteer on the mat, then Exit
    await page.evaluate(() => window.__app.skipTo(1, 4));
    s = await waitFor((x) => x.act === 1 && x.beatKind === 'reveal' && x.phase === 'ready', 8000, 'the volunteer hops onto the mat');
    const st = await stage();
    const vol = st?.spectators.find((x) => `${x.id}-ear` === s.revealTarget);
    check(!!vol && !vol.seated, 'the volunteer stands on the mat', { vol, revealTarget: s.revealTarget });
    await exitAndSettle('reveal');
    // the puppet hops home (≈1 s)
    await waitFor((x) => x.attract, 2000, 'attract view after the reveal Exit');
    const t0 = Date.now();
    let home = false;
    while (Date.now() - t0 < 4000 && !home) {
      const r = await stage();
      home = !!r && r.spectators.filter((x) => x.id !== 'rabbit').every((x) => x.seated);
      if (!home) await page.waitForTimeout(150);
    }
    check(home, 'the volunteer hops home to its seat');
    await checkAttract('after Exit with the volunteer on the mat');
    await api.shot('core-attract-after-reveal-exit');
  } catch (e) {
    if (!failures.includes(String(e?.message ?? e))) failures.push(String(e?.message ?? e));
  }
  note(failures.length ? `FAILED (${failures.length})` : 'PASSED');
  return { pass: failures.length === 0, failures, timeline };
}
