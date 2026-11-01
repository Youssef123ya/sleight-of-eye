// tests/overlay.mjs — checks the ?debug=1 overlay (src/debug/overlay.ts) in XR (owned by Q).
//
//   node tests/overlay.mjs [--url=http://127.0.0.1:8081/] [--demo=debug]   (without --demo: the game with ?debug=1)
//
// 1. numbers update: two snapshots 1.5 s apart → more frames, more canvas redraws, live fps/draws/tris/programs
// 2. cost: hiding the panel removes ≤ 2 draw calls per view
// 3. placement: the panel sits ~0.8 m away, low in view (−22° pitch), facing the eyes
// 4. lazy follow: a small head turn (inside the 14° dead zone) leaves it world-locked; a 40° turn brings it back
//    in front of the head within 2 s
// Screenshots: tests/out/overlay/*.png; result tests/out/overlay[-<demo>].json. Prints JSON; exit 1 on a failed check.
import * as qa from './lib/iwer.mjs';

const args = qa.parseArgs();
qa.installWatchdog(Number(args.timeout ?? 150) * 1000, 'overlay');
const url = qa.appUrl(qa.baseUrl(args), args.demo ? { demo: args.demo } : { debug: 1 });
const checks = [];
const check = (name, ok, detail = '') => (checks.push({ name, ok: !!ok, detail }), ok);
const eye = qa.DEFAULT_EYE;
let fatal = null;

const app = await qa.openApp(url);
const page = app.page;
try {
  await qa.enterXR(page, { fov: 60, head: eye, look: [0, 0.95, -0.6] });
  await qa.wait(page, 1.0);
  const has = await page.evaluate(() => !!window.__debugOverlay);
  check('overlay installed (window.__debugOverlay)', has, url);
  if (!has) throw new qa.QAError('no overlay on this page');
  const snap = () => page.evaluate(() => window.__debugOverlay.snapshot());
  const offset = async () => {
    const [o] = await qa.findObjects(page, ['debug-overlay']);
    const h = await qa.headPose(page);
    const d = [o.position[0] - h.position[0], o.position[1] - h.position[1], o.position[2] - h.position[2]];
    const yawP = Math.atan2(d[0], -d[2]);
    const yawH = Math.atan2(h.forward[0], -h.forward[2]);
    let dy = ((yawP - yawH) * 180) / Math.PI;
    while (dy > 180) dy -= 360;
    while (dy < -180) dy += 360;
    const pitchP = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
    const pitchH = (Math.asin(Math.max(-1, Math.min(1, h.forward[1]))) * 180) / Math.PI;
    return { yaw: dy, pitch: pitchP - pitchH, dist: Math.hypot(...d), world: o.position };
  };
  const pEntry = await offset();
  check('snaps in front of the head when XR starts', Math.abs(pEntry.yaw) < 3 && Math.abs(pEntry.pitch + 22) < 3, `yaw ${pEntry.yaw.toFixed(1)}°, pitch ${pEntry.pitch.toFixed(1)}° from the view centre`);

  // 1. numbers update
  const a = await snap();
  await qa.wait(page, 1.5);
  const b = await snap();
  check('frames advance', b.frames > a.frames, `${a.frames} → ${b.frames}`);
  check('canvas redraws (4 Hz)', b.redraws - a.redraws >= 3, `${a.redraws} → ${b.redraws}`);
  check('fps measured', b.fps > 20 && b.fps < 200, `fps ${b.fps.toFixed(1)}, ${b.frameMsAvg.toFixed(1)} ms avg, p95 ${b.frameMsP95.toFixed(1)}`);
  check('renderer numbers', b.drawCallsPerView > 0 && b.trianglesPerView > 0 && b.programs > 0 && b.geometries > 0, `${b.drawCallsPerView} draws/view ×${b.views}, ${b.trianglesPerView} tris/view, ${b.programs} programs, ${b.geometries} geos, ${b.textures} tex`);
  const hasApp = await qa.hasApp(page);
  if (hasApp) check('app-state lines', b.app.length > 0, b.app.join(' / '));
  await qa.screenshot(page, qa.outPath('overlay', `${args.demo ?? 'game'}-panel.png`));

  // 2. draw-call cost: count the overlay's own draws (onBeforeRender fires once per draw) over 30 XR frames
  const cost = await page.evaluate(async () => {
    const holder = window.__qa.find('debug-overlay-holder') ?? window.__qa.find('debug-overlay');
    let meshes = 0;
    let draws = 0;
    const undo = [];
    holder.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const prev = o.onBeforeRender;
      o.onBeforeRender = function (...a) {
        draws++;
        return prev.apply(this, a);
      };
      undo.push(() => (o.onBeforeRender = prev));
    });
    await window.__qa.xrFrames(30);
    undo.forEach((f) => f());
    const xr = window.__qa.world().renderer.xr;
    const views = xr.isPresenting && !xr.isMultiview ? xr.getCamera().cameras.length : 1;
    return { meshes, perView: draws / 30 / views };
  });
  check('cost ≤ 2 draw calls per view', cost.perView > 0 && cost.perView <= 2, `${cost.meshes} mesh, ${cost.perView.toFixed(2)} draws/view per frame`);

  // 3. placement relative to the head
  // entering XR snaps the panel in front of the head; re-showing it does too (deterministic start for the checks)
  await page.evaluate(() => (window.__debugOverlay.setVisible(false), window.__debugOverlay.setVisible(true)));
  await qa.wait(page, 0.3);
  const p0 = await offset();
  check('placed low in view at ~0.8 m', Math.abs(p0.yaw) < 3 && Math.abs(p0.pitch + 22) < 3 && Math.abs(p0.dist - 0.8) < 0.05, `yaw ${p0.yaw.toFixed(1)}°, pitch ${p0.pitch.toFixed(1)}° from the view centre, ${p0.dist.toFixed(2)} m`);

  // 4. lazy follow
  const look = (yawDeg, pitchDeg) => {
    const y = (yawDeg * Math.PI) / 180;
    const p = (pitchDeg * Math.PI) / 180;
    return [eye[0] + Math.sin(y) * Math.cos(p), eye[1] + Math.sin(p), eye[2] - Math.cos(y) * Math.cos(p)];
  };
  const basePitch = (Math.atan2(0.95 - eye[1], 0.6) * 180) / Math.PI;
  await qa.lookAt(page, look(8, basePitch), { duration: 0.3 });
  await qa.wait(page, 1.0);
  const p1 = await offset();
  const moved = Math.hypot(p1.world[0] - p0.world[0], p1.world[1] - p0.world[1], p1.world[2] - p0.world[2]);
  check('world-locked inside the dead zone (8° turn)', moved < 0.005, `moved ${(moved * 100).toFixed(2)} cm`);
  await qa.lookAt(page, look(40, basePitch + 5), { duration: 0.4 });
  await qa.screenshot(page, qa.outPath('overlay', `${args.demo ?? 'game'}-follow-mid.png`));
  await qa.wait(page, 2.0);
  const p2 = await offset();
  const s2 = await snap();
  check('re-centres after a 40° turn', Math.abs(p2.yaw) < 3 && Math.abs(p2.pitch + 22) < 3 && !s2.following, `yaw ${p2.yaw.toFixed(1)}°, pitch ${p2.pitch.toFixed(1)}°, following ${s2.following}`);
  await qa.screenshot(page, qa.outPath('overlay', `${args.demo ?? 'game'}-follow-settled.png`));
  const errs = qa.consoleErrors(page);
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
  fatal = String(e?.message ?? e);
} finally {
  await app.close();
}
const ok = !fatal && checks.every((c) => c.ok);
const res = { ok, url, fatal, checks };
qa.writeJson(qa.outPath(args.demo ? `overlay-${args.demo}.json` : 'overlay.json'), res);
console.log(JSON.stringify(res, null, 2));
process.exit(ok ? 0 : fatal ? 2 : 1);
