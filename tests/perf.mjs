// tests/perf.mjs — render budget + frame-time sampling in XR (owned by Q).
//
//   node tests/perf.mjs [--url=http://127.0.0.1:8081/] [--demo=<name>] [--seconds=3] [--warmup=6]
//                       [--poses=ahead,mat,audience,musicBox,candle,firework,burst]
//                       [--draws=70] [--tris=300000] [--programs=20] [--debug] [--no-shots] [--tag=<name>] [--timeout=240]
//
// Loads the game (or ?demo=<name>) in an emulated XR session (hands only, seated eye 0,1.2,0) and,
// for each head pose in all three act casts, samples every frame for N seconds: frame interval, renderer.info draw calls + triangles,
// CPU ms in world.update (all systems) and renderer.render (draw submission), and allocation volume from Chrome's
// sampling heap profiler, charged to the deepest app frame (src/<file>:<function>) or to three/IWSDK / the emulator.
// Budgets (fail → exit 1): draw calls ≤ 70, triangles ≤ 300k, shader programs ≤ 20 — measured PER VIEW: IWER has
// no multiview, so three draws every object once per eye view; the Quest renders both eyes in one pass
// (OCULUS_multiview), which is what the budget means. Raw numbers are in the report too.
// Desktop fps / CPU ms are reported as signals only: they cannot prove Quest 3 performance.
// The QA stats overlay stays OFF by default so the numbers are the shipped game's (it costs 1 draw call per view, its
// canvas redraws allocate, and its 4 Hz debugState() reads would be charged to src/game); --debug adds ?debug=1 and
// puts the overlay's snapshot in the report.
// Writes tests/out/perf-report.md (+ perf.json, tests/out/perf/<pose>.png) and prints a JSON summary; --tag=<name>
// writes perf-<name>-report.md / perf-<name>.json / perf/<name>/ instead (e.g. a demo measured beside the game's report).
import * as qa from './lib/iwer.mjs';

const args = qa.parseArgs();
qa.installWatchdog(Number(args.timeout ?? 240) * 1000, 'perf');

const BUDGET = {
  draws: Number(args.draws ?? 70),
  tris: Number(args.tris ?? 300_000),
  programs: Number(args.programs ?? 20),
};
const SECONDS = Number(args.seconds ?? 3);
if (!(SECONDS > 0) || !Number.isFinite(SECONDS)) throw new Error('--seconds must be a positive finite number');
// once-per-frame functions run in V8's baseline tier (boxing every double) for several seconds before they are
// optimized: warm up long enough that the allocation numbers reflect steady state
const WARMUP = Number(args.warmup ?? 6);
const eye = qa.vec(args.eye, qa.DEFAULT_EYE);
// look targets: a named object when the scene has one, else the layout.ts mark (rig-local, rig at the eye)
const POSES = {
  ahead: { names: [], local: [0, 0, -1] },
  mat: { names: ['mat', 'coin'], local: [0, -0.297, -0.4] },
  audience: { names: ['kit2-head', 'kit2-eyes', 'kit2'], local: [0, -0.17, -0.66] },
  musicBox: { names: ['musicBox-focus', 'musicBox'], local: [-0.36, -0.09, -0.82] },
  candle: { names: ['candle-focus', 'candle'], local: [0.36, -0.09, -0.82] },
  firework: { names: ['firework-focus', 'firework'], local: [0, -0.01, -0.92] },
  burst: { names: ['burst'], local: [0, 0.12, -0.95] },
};
const poseNames = String(args.poses ?? Object.keys(POSES).join(',')).split(',').filter((p) => POSES[p]);
if (!poseNames.length) throw new Error('--poses selected no known poses');

const base = qa.baseUrl(args);
const url = qa.appUrl(base, { demo: args.demo ?? undefined, debug: args.debug === true ? 1 : null });
const shots = args.shots !== false;
const tag = String(args.tag ?? '').replace(/[^a-z0-9_-]+/gi, '');
const NAME = tag ? `perf-${tag}` : 'perf';
const report = { url, budget: BUDGET, seconds: SECONDS, poses: [], failures: [], warnings: [], notes: [] };
let exitCode = 0;
const browser = await qa.launchBrowser();
try {
  const app = await qa.openApp(url, { browser });
  const page = app.page;
  report.xr = await qa.enterXR(page, { fov: 60, head: eye, look: [eye[0], eye[1], eye[2] - 1] });
  report.game = await qa.hasApp(page, { timeout: args.demo ? 1000 : 8000 });
  if (report.game) await qa.waitForState(page, (s) => s.calibrated !== false, { timeout: 5000, throws: false });
  if (!args.demo && !report.game) throw new Error('the full game DebugApi is required for all-act performance checks');
  const stages = report.game && !args.demo
    ? await page.evaluate(async () => (await import('/src/game/acts.ts')).ACTS.map((a) => {
        const beat = a.beats.findIndex((b) => b.kind === 'steal');
        return { act: a.act, beat, gadgets: a.beats[beat]?.gadgets ?? [], cast: a.cast.map((c) => c.id) };
      }))
    : [{ act: null, gadgets: [], cast: [] }];
  if (stages.some((s) => s.act !== null)) report.notes.push('All-act checks prepare steal checkpoints through skipTo; gadget effects are activated by gaze. This measures prepared rendering states, not gameplay completion. Firework cycle samples last four seconds to include the fuse and burst.');
  for (const stage of stages) {
    const prepare = async () => {
      if (stage.act === null) return;
      if (stage.beat < 0) throw new Error(`Act ${stage.act} has no steal checkpoint`);
      await qa.callApp(page, 'skipTo', stage.act, stage.beat);
      await qa.waitForState(page, (s) => s.act === stage.act && s.beatKind === 'steal' && s.phase === 'active' && s.running, {
        timeout: 8000, label: `Act ${stage.act} steal checkpoint`,
      });
    };
    await prepare();
    // Warm each cast and viewpoint before collecting its steady-state allocation numbers.
    const targets = {};
    for (const p of poseNames) {
      const spec = POSES[p];
      let look = [eye[0] + spec.local[0], eye[1] + spec.local[1], eye[2] + spec.local[2]];
      let via = 'layout mark';
      if (spec.names.length) {
        const found = (await qa.findObjects(page, spec.names)).find((o) => o.found);
        if (found) {
          look = found.center ?? found.position;
          via = found.name;
        }
      } else via = 'level, -Z';
      targets[p] = { look, via };
      await qa.placeHead(page, eye, look);
      await qa.wait(page, WARMUP / poseNames.length + 0.1);
    }
    for (const p of poseNames) {
      await prepare(); // a fresh gadget window, rather than the spent one left by warm-up
      const { look, via } = targets[p];
      const label = stage.act === null ? p : `act${stage.act}-${p}`;
      const gadget = p === 'burst' ? 'firework' : p;
      const activeEffect = stage.gadgets.includes(gadget);
      if (activeEffect) {
        const focus = (await qa.findObjects(page, [`${gadget}-focus`, gadget])).find((o) => o.found);
        if (!focus) throw new Error(`${label}: ${gadget} focus is missing`);
        await qa.placeHead(page, eye, focus.position);
        await qa.waitForState(page, (s) => s.gadgets?.[gadget]?.active, { timeout: 5000, label: `${label}: gaze activates ${gadget}` });
      }
      await qa.placeHead(page, eye, look);
      await qa.wait(page, activeEffect ? 0.1 : 0.5);
      const stateBefore = stage.act === null ? null : await qa.appState(page);
      // Include fuse, flight, and burst in the firework sample (the bang is confirmed after sampling).
      const seconds = activeEffect && gadget === 'firework' ? 4 : SECONDS;
      await qa.startSampler(page);
      const samplingStarted = Date.now();
      let alloc = null;
      let allocError = null;
      try {
        alloc = await qa.allocationProfile(page, () => qa.wait(page, seconds));
      } catch (e) {
        allocError = String(e?.message ?? e);
        report.failures.push(`${label}: allocation measurement unavailable: ${allocError}`);
        // The profiler may fail before running its callback. Still collect a full frame-time window.
        const left = seconds - (Date.now() - samplingStarted) / 1000;
        if (left > 0) await qa.wait(page, left);
      }
      const s = await qa.stopSampler(page);
      const frames = Math.max(1, s.frames);
      s.alloc = alloc ? {
        error: null,
        totalKBPerFrame: alloc.totalKB / frames,
        appKBPerFrame: alloc.owners.filter((o) => o.owner.startsWith('src/')).reduce((a, o) => a + o.kb, 0) / frames,
        owners: alloc.owners.slice(0, 12).map((o) => ({ owner: o.owner, kbPerFrame: o.kb / frames, share: o.share })),
        sites: (alloc.sites ?? []).slice(0, 8).map((x) => ({ site: x.site, kbPerFrame: x.kb / frames })),
        depSites: (alloc.depSites ?? []).slice(0, 8).map((x) => ({ site: x.site, kbPerFrame: x.kb / frames })),
      } : { error: allocError, totalKBPerFrame: null, appKBPerFrame: null, owners: [], sites: [], depSites: [] };
      if (!s.frames) report.failures.push(`${label}: no XR frames sampled`);
      const stateAfter = stage.act === null ? null : await qa.appState(page);
      if (activeEffect && gadget === 'firework' && !stateAfter?.bangActive) report.failures.push(`${label}: the firework bang was not confirmed after the sample`);
      const raw = await qa.renderStats(page, 200);
      let shot = null;
      if (shots) shot = await qa.screenshot(page, qa.outPath(...(tag ? ['perf', tag] : ['perf']), `${label}.png`));
      report.poses.push({ pose: label, act: stage.act, cast: stage.cast, activeEffect: activeEffect ? gadget : null, seconds,
        stateBefore, stateAfter, via, look, ...s, raw, shot });
    }
  }
  report.overlay = await page.evaluate(() => window.__debugOverlay?.snapshot?.() ?? null).catch(() => null);
  report.state = report.game ? await qa.appState(page).catch(() => null) : null;
  report.errors = [...qa.consoleErrors(page)];
  await app.close();
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  exitCode = 2;
} finally {
  await browser.close().catch(() => {});
}

// ------------------------------------------------------------------------------------------------ verdict
if (!report.fatal) {
  const max = (f) => Math.max(0, ...report.poses.map(f));
  // An incomplete profile cannot produce a numeric "worst" allocation result.
  const maxAlloc = (key) => report.poses.some((p) => p.alloc?.error)
    ? null : max((p) => p.alloc?.[key] ?? 0);
  report.worst = {
    drawCallsPerView: max((p) => p.drawCallsPerView.max),
    trianglesPerView: max((p) => p.trianglesPerView.max),
    programs: max((p) => p.programs),
    frameMsP95: max((p) => p.frameMs.p95),
    systemsMsP95: max((p) => p.systemsMs.p95),
    renderMsP95: max((p) => p.renderMs.p95),
    allocKBPerFrame: max((p) => p.allocKBPerFrame),
    appAllocKBPerFrame: maxAlloc('appKBPerFrame'),
    totalAllocKBPerFrame: maxAlloc('totalKBPerFrame'),
    fpsMin: Math.min(...report.poses.map((p) => p.fps)),
  };
  const w = report.worst;
  if (w.drawCallsPerView > BUDGET.draws) report.failures.push(`draw calls ${Math.round(w.drawCallsPerView)} per view > budget ${BUDGET.draws}`);
  if (w.trianglesPerView > BUDGET.tris) report.failures.push(`triangles ${Math.round(w.trianglesPerView)} per view > budget ${BUDGET.tris}`);
  if (w.programs > BUDGET.programs) report.failures.push(`shader programs ${w.programs} > budget ${BUDGET.programs}`);
  if (w.drawCallsPerView > BUDGET.draws * 0.85 && w.drawCallsPerView <= BUDGET.draws) report.warnings.push(`draw calls at ${Math.round((w.drawCallsPerView / BUDGET.draws) * 100)}% of budget`);
  if (w.fpsMin < 55) report.warnings.push(`desktop fps dipped to ${w.fpsMin.toFixed(1)} (emulator runs at the browser rAF rate, ~60)`);
  if (w.systemsMsP95 > 3) report.warnings.push(`systems take ${w.systemsMsP95.toFixed(2)} ms p95 on this desktop CPU — expect ~4-5x on Quest 3 (13.9 ms frame at 72 Hz)`);
  if (w.appAllocKBPerFrame > 2) {
    const top = report.poses.flatMap((p) => p.alloc?.sites ?? []).sort((a, b) => b.kbPerFrame - a.kbPerFrame)[0];
    report.warnings.push(`app code (src/) allocates ${w.appAllocKBPerFrame.toFixed(1)} KB per frame${top ? ` — top site: ${top.site} (${top.kbPerFrame.toFixed(2)} KB/frame)` : ''}; per-frame code should allocate nothing (GC hitches on Quest)`);
  }
  if (report.errors?.length) report.failures.push(`console errors: ${report.errors.slice(0, 3).join(' | ')}`);
  if (args.debug === true && !report.overlay) report.notes.push('?debug=1 was set but no debug overlay is installed on this page (installDebugOverlay is wired by the boot/game code)');
  if (report.xr && !report.xr.multiview) report.notes.push(`IWER renders ${report.xr.views} views without multiview: raw counts are ${report.xr.views}x the per-view (Quest multiview) numbers`);
}
report.ok = !report.fatal && report.failures.length === 0;
if (!report.fatal && report.failures.length) exitCode = 1;
qa.writeText(qa.outPath(`${NAME}-report.md`), markdown(report));
qa.writeJson(qa.outPath(`${NAME}.json`), report);
console.log(
  JSON.stringify(
    {
      ok: report.ok,
      url: report.url,
      budget: report.budget,
      worst: report.worst,
      poses: report.poses.map((p) => ({
        pose: p.pose,
        act: p.act,
        activeEffect: p.activeEffect,
        sampledSeconds: p.seconds,
        fps: +p.fps.toFixed(1),
        drawsPerView: Math.round(p.drawCallsPerView.max),
        trisPerView: Math.round(p.trianglesPerView.max),
        programs: p.programs,
        frameMsP95: +p.frameMs.p95.toFixed(2),
        systemsMsP95: +p.systemsMs.p95.toFixed(2),
        appAllocKBPerFrame: p.alloc?.appKBPerFrame == null ? null : +p.alloc.appKBPerFrame.toFixed(2),
        allocKBPerFrame: p.alloc?.totalKBPerFrame == null ? null : +p.alloc.totalKBPerFrame.toFixed(1),
        allocationError: p.alloc?.error ?? null,
      })),
      overlay: report.overlay ? { fps: report.overlay.fps, drawCallsPerView: report.overlay.drawCallsPerView, redraws: report.overlay.redraws } : null,
      failures: report.failures,
      warnings: report.warnings,
      notes: report.notes,
      fatal: report.fatal,
      report: `tests/out/${NAME}-report.md`,
    },
    null,
    2,
  ),
);
process.exit(exitCode);

function markdown(r) {
  const f = qa.fmt;
  const L = [`# Perf report: ${r.ok ? 'PASS' : r.fatal ? 'ERROR' : 'FAIL'}`, ''];
  L.push(`- URL: ${r.url}`, `- Budget per view: ≤ ${r.budget.draws} draw calls, ≤ ${r.budget.tris.toLocaleString('en-US')} triangles, ≤ ${r.budget.programs} programs`);
  L.push(`- ${r.seconds}s sampled per pose after warm-up (active firework cycles: 4s); XR: ${r.xr ? `${r.xr.device}, IWER ${r.xr.iwer}, ${r.xr.views} views, multiview ${r.xr.multiview}, canvas ${r.xr.canvas?.join('x')}` : 'n/a'}`, '');
  if (r.fatal) L.push('## Fatal', '', '```', r.fatal, '```', '');
  if (r.failures.length) L.push('## Failures', '', ...r.failures.map((x) => `- ${x}`), '');
  if (r.warnings.length) L.push('## Warnings', '', ...r.warnings.map((x) => `- ${x}`), '');
  if (r.notes.length) L.push('## Notes', '', ...r.notes.map((x) => `- ${x}`), '');
  if (r.worst) {
    L.push('## Worst case', '', qa.mdTable(['metric', 'value', 'budget'], [
      ['draw calls / view (max)', f(r.worst.drawCallsPerView, 0), r.budget.draws],
      ['triangles / view (max)', Math.round(r.worst.trianglesPerView).toLocaleString('en-US'), r.budget.tris.toLocaleString('en-US')],
      ['shader programs', r.worst.programs, r.budget.programs],
      ['frame ms p95 (desktop)', f(r.worst.frameMsP95, 2), '13.9 @ 72 Hz on Quest'],
      ['systems CPU ms p95 (desktop)', f(r.worst.systemsMsP95, 2), 'signal'],
      ['render submit CPU ms p95 (desktop)', f(r.worst.renderMsP95, 2), 'signal'],
      ['app code (src/) allocation KB / frame', f(r.worst.appAllocKBPerFrame, 2), 'should be ~0 (sampling heap profiler)'],
      ['all allocation KB / frame', f(r.worst.totalAllocKBPerFrame, 1), 'includes three/IWSDK and the IWER emulator'],
      ['page heap growth KB / frame', f(r.worst.allocKBPerFrame, 1), 'signal'],
    ]), '');
  }
  L.push('## Per pose', '', qa.mdTable(
    ['pose', 'looks at', 'fps', 'frame ms avg / p95 / max', 'draws/view avg / max', 'tris/view max', 'raw draws', 'programs', 'geos / tex', 'systems ms p95', 'render ms p95', 'app alloc KB/frame', 'all alloc KB/frame', 'GCs'],
    r.poses.map((p) => [
      p.pose,
      p.via,
      f(p.fps, 1),
      `${f(p.frameMs.avg, 1)} / ${f(p.frameMs.p95, 1)} / ${f(p.frameMs.max, 1)}`,
      `${f(p.drawCallsPerView.avg, 1)} / ${f(p.drawCallsPerView.max, 0)}`,
      Math.round(p.trianglesPerView.max).toLocaleString('en-US'),
      p.raw?.drawCalls,
      p.programs,
      `${p.geometries} / ${p.textures}`,
      f(p.systemsMs.p95, 2),
      f(p.renderMs.p95, 2),
      f(p.alloc?.appKBPerFrame, 2),
      f(p.alloc?.totalKBPerFrame, 1),
      p.gcCount,
    ]),
  ), '');
  const withShots = r.poses.filter((p) => p.shot);
  if (withShots.length) L.push('## Views sampled', '', ...withShots.map((p) => `- ${p.pose}: ![${p.pose}](${qa.relOut(p.shot)})`), '');
  const owners = new Map();
  for (const p of r.poses) for (const o of p.alloc?.owners ?? []) owners.set(o.owner, Math.max(owners.get(o.owner) ?? 0, o.kbPerFrame));
  if (owners.size) {
    L.push('## Allocation by owner (worst pose, KB per frame)', '', 'Sampling heap profiler (CDP, garbage included). Each allocation is charged to the deepest app frame (src/...) on its stack, else to the script that allocated.', '');
    L.push(qa.mdTable(['owner', 'KB / frame'], [...owners.entries()].sort((a, b) => b[1] - a[1]).map(([o, kb]) => [o, f(kb, 2)])), '');
  }
  const sites = new Map();
  for (const p of r.poses) for (const x of p.alloc?.sites ?? []) sites.set(x.site, Math.max(sites.get(x.site) ?? 0, x.kbPerFrame));
  const deps = new Map();
  for (const p of r.poses) for (const x of p.alloc?.depSites ?? []) deps.set(x.site, Math.max(deps.get(x.site) ?? 0, x.kbPerFrame));
  if (deps.size) L.push('## Top dependency allocation sites (three / IWSDK, not under app code; KB per frame)', '', 'Pre-bundled chunk:line function. Framework garbage the app cannot remove directly, but it sets the GC baseline on Quest.', '', qa.mdTable(['site', 'KB / frame'], [...deps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([x, kb]) => [x, f(kb, 2)])), '');
  if (sites.size) L.push('## Top app allocation sites (worst pose, KB per frame)', '', qa.mdTable(['site (file:line function)', 'KB / frame'], [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([x, kb]) => [x, f(kb, 2)])), '');
  if (r.overlay) L.push('## Debug overlay snapshot', '', '```json', JSON.stringify(r.overlay, null, 2), '```', '');
  if (r.state) L.push('## Game state at the end', '', '```json', JSON.stringify(r.state), '```', '');
  return `${L.join('\n')}\n`;
}
