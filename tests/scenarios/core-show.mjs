// The whole show end to end, no skipTo: landing → Enter (tests/shot.mjs --xr clicks the landing's Enter button)
// → calibration on the first stable XR frames → Act I → Act II (with one magpie catch) → Act III → the bow
// (review + poster + Retry/Exit plaques) → Exit plaque → back on the landing page.
//   node tests/shot.mjs --url="http://127.0.0.1:8081/" --xr --head=0,1.2,0 --look=0,0.9,-0.45 \
//        --scenario=tests/scenarios/core-show.mjs --out=tests/out/core-show.png
// Works on ?demo=core (stubs) too. ~3 minutes.
import { playAct1 } from './core-act1.mjs';
import { playAct2 } from './core-act2.mjs';
import { playAct3 } from './core-act3.mjs';
import { makeHelpers } from './core-lib.mjs';

export default async function show(page, api) {
  const h = makeHelpers(page, api);
  const { note, waitFor, check, state, events, where, poke, add, failures, timeline } = h;
  const landingShown = () =>
    page.evaluate(() => {
      const el = document.getElementById('landing') ?? document.getElementById('landing-stub');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return !el.classList.contains('is-hidden') && cs.display !== 'none' && cs.visibility !== 'hidden' && el.getAttribute('aria-hidden') !== 'true';
    });
  try {
    // ------------------------------------------------------------------ entering: landing hidden, stage calibrated
    let s = await waitFor((x) => x.immersive && x.calibrated && x.started, 30000, 'Enter → immersive, stage calibrated, show started');
    check(s.calibrations === 1, 'calibrated once from the first stable head pose', { calibrations: s.calibrations });
    check(s.act === 1 && s.beat === 0, 'a fresh show starts at Act I, beat 0', { act: s.act, beat: s.beat });
    check((await landingShown()) !== true, 'the landing page is hidden while immersive');
    const vis = (await events()).filter((e) => e.type === 'session:visibility').map((e) => e.data.state);
    check(vis.includes('visible'), "'session:visibility' visible on entering", { vis });

    // ------------------------------------------------------------------ the three acts
    await playAct1(h);
    await playAct2(h, { skip: false });
    await playAct3(h, { skip: false });

    // ------------------------------------------------------------------ after the bow
    s = await state();
    check(s.act === 4 && s.beatKind === 'bow', 'the bow', { act: s.act, kind: s.beatKind });
    check(s.stars[0] >= 2 && s.stars[1] === 1 && s.stars[2] >= 2, 'stars per act (Act II had one catch)', { stars: s.stars });
    check(s.caught === 1, 'one catch in the whole show', { caught: s.caught });
    const save = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('sleight-of-eye.save.v1') ?? 'null');
      } catch {
        return null;
      }
    });
    check(!!save && save.act === 4 && save.shows === 1 && save.posters?.length === 1, 'autosaved at the bow with a new poster', {
      act: save?.act,
      shows: save?.shows,
      posters: save?.posters?.length,
    });
    const exitAt = await where('plaque-exit');
    check(!!exitAt, 'Exit plaque at the bow');
    if (exitAt) {
      await poke(add(exitAt, [0, 0.07, 0.07]), exitAt, 0.9);
      s = await waitFor((x) => !x.immersive, 5000, 'Exit plaque → leaves XR');
      await page.waitForTimeout(600);
      check((await landingShown()) !== false, 'the landing page is back after exiting', { shown: await landingShown() });
      await api.shot('core-show-landing-after-exit');
    }
  } catch (e) {
    if (!failures.includes(String(e?.message ?? e))) failures.push(String(e?.message ?? e));
  }
  note(failures.length ? `FAILED (${failures.length})` : 'PASSED');
  return { pass: failures.length === 0, failures, timeline };
}
