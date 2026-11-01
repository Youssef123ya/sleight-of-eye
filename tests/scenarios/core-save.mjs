// Autosave + resume + Exit on ?demo=core: every beat boundary writes localStorage; a reload resumes at the
// saved act/checkpoint after the first stable XR frames; poking the Exit plaque leaves XR (landing back).
//   node tests/shot.mjs --url="http://127.0.0.1:8091/?demo=core" --xr --head=0,1.2,0 --look=0,0.9,-0.45 \
//        --scenario=tests/scenarios/core-save.mjs --out=tests/out/core-save.png
import { makeHelpers } from './core-lib.mjs';

export default async function save(page, api) {
  const h = makeHelpers(page, api);
  const { note, waitFor, check, poke, where, state, add, failures, timeline } = h;
  try {
    await waitFor((s) => s.calibrated && s.started, 30000, 'show started');
    await page.evaluate(() => window.__app.setSettings({ captions: false }));
    await page.evaluate(() => window.__app.skipTo(2, 1));
    await waitFor((s) => s.act === 2 && s.beatKind === 'show' && s.phase === 'active', 5000, 'Act II show');
    const raw = await page.evaluate(() => localStorage.getItem('sleight-of-eye.save.v1'));
    const saved = raw ? JSON.parse(raw) : null;
    check(saved?.act === 2 && saved?.beat === 1 && saved?.settings?.captions === false, 'autosave at the beat boundary', saved);

    // reload: a fresh page resumes where we left off
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.FRAMEWORK_MCP_RUNTIME?.world, null, { timeout: 45000 });
    await page.evaluate(async () => {
      const { DemoDirector } = await import('/capture/director.js');
      const d = await DemoDirector.attach({ fovyDeg: 60 });
      window.__director = d;
      d.place({ head: [0, 1.2, 0], look: [0, 0.9, -0.45] });
    });
    let s = await waitFor((x) => x.calibrated && x.act === 2 && x.beatKind === 'show' && x.phase === 'active', 20000, 'reload → resumed at Act II show');
    check(s.settings.captions === false, 'settings restored from the save', s.settings);

    // Exit plaque: leave XR
    const exit = await where('plaque-exit');
    check(!!exit, 'exit plaque present');
    // the session ends mid-poke, so the director's XR-frame loop never finishes: don't await it
    poke(add(exit, [0, 0.07, 0.07]), exit, 0.9).catch(() => {});
    s = await waitFor((x) => !x.immersive, 5000, 'Exit plaque → back to the 2D landing');
    const landing = await page.evaluate(() => {
      const el = document.getElementById('landing-stub');
      return el ? el.style.display : 'n/a (real landing)';
    });
    check(landing !== 'none', 'landing visible again', { landing });
    await page.evaluate(() => window.__app.setSettings({ captions: true }));
  } catch (e) {
    if (!failures.includes(String(e?.message ?? e))) failures.push(String(e?.message ?? e));
  }
  note(failures.length ? `FAILED (${failures.length})` : 'PASSED');
  return { pass: failures.length === 0, failures, timeline };
}
