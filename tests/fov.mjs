// tests/fov.mjs — field-of-view check for the seated stage (owned by Q).
//
//   node tests/fov.mjs [--url=http://127.0.0.1:8081/] [--demo=<name>] [--acts=1,2,3] [--eye=0,1.2,0]
//                      [--tolerance=0] [--no-shots] [--timeout=240]
//
// In XR, head at the seated eye (default 0,1.2,0) facing -Z, it measures yaw / pitch / distance of every named key
// object — props, gadgets + '<id>-focus', spectator heads ('<id>-head', else '<id>-eyes'), 'plaque-<action>', 'mat',
// 'burst' — in these head poses:
//   ahead            level, facing -Z (the calibrated forward)
//   mat              looking at the mat centre (where the hands work)
//   glance:<gadget>  looking at each gadget's focus (the misdirection glance)
// and checks them against two zones (tangent-plane angles, i.e. exactly how a display frustum clips):
//   quest3   Quest 3 comfortable view: ±40° horizontal, +35° / -45° vertical (inside the ~110°x96° display FoV,
//            clear of the lens rim)
//   glasses  Meta VR Glasses frustum: 37° left/right, 25° up, 43° down (IWER metaVRGlassesVisibilityMask)
// Required checks (exit 1 when one fails on a visible object):
//   ahead:   props, mat, spectator heads, gadgets + focus, burst inside quest3 AND glasses
//   mat:     props + mat inside glasses; plaques inside quest3 (they must be reachable from the working pose)
//   glance:  every mat prop + the mat centre inside the glasses frustum (spec §3)
// Everything else (plaques straight ahead, heads during a glance, hidden objects) is reported as advisory.
// window.__app.fovReport() is used when present: its ids join the ahead table and its angles are cross-checked.
// With window.__app, each act in --acts is measured after skipTo(act, 0).
//
// Writes tests/out/fov-report.md (+ fov.json, glasses-view screenshots tests/out/fov/*.png), prints a JSON summary.
import * as qa from './lib/iwer.mjs';

const args = qa.parseArgs();
qa.installWatchdog(Number(args.timeout ?? 240) * 1000, 'fov');

// --tolerance=<deg>: accept a required object up to this far past an edge (default 0 = strict)
const TOL = Number(args.tolerance ?? 0);
const ZONES = {
  quest3: { left: 40, right: 40, up: 35, down: 45, label: 'Quest 3 comfortable' },
  glasses: { ...qa.GLASSES, label: 'Meta VR Glasses' },
};
const PROPS = ['coin', 'ball', 'cupLeft', 'cupMid', 'cupRight', 'watch', 'cupcake'];
const GADGETS = ['musicBox', 'candle', 'firework'];
const SPECTATORS = ['kit1', 'kit2', 'kit3', 'magpie', 'brock', 'rabbit'];
const PLAQUES = ['retry', 'easy', 'assist', 'recenter', 'exit'];

/** Required (zone list) per pose kind and category; anything not listed is advisory. */
const REQUIRED = {
  ahead: { prop: ['quest3', 'glasses'], mat: ['quest3', 'glasses'], head: ['quest3', 'glasses'], gadget: ['quest3', 'glasses'], focus: ['quest3', 'glasses'], burst: ['quest3', 'glasses'] },
  mat: { prop: ['glasses'], mat: ['glasses'], plaque: ['quest3'] },
  glance: { prop: ['glasses'], mat: ['glasses'] },
};

// ------------------------------------------------------------------------------------------------ maths
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const DEG = 180 / Math.PI;

function basis(eye, look) {
  const f = norm(sub(look, eye));
  let r = cross(f, [0, 1, 0]);
  if (len(r) < 1e-6) r = [1, 0, 0];
  r = norm(r);
  return { f, r, u: cross(r, f) };
}
/** Tangent-plane angles of p seen from eye with basis B (yaw + = right, pitch + = up). */
function angles(eye, B, p) {
  const d = sub(p, eye);
  const z = dot(d, B.f);
  return { yaw: Math.atan2(dot(d, B.r), z) * DEG, pitch: Math.atan2(dot(d, B.u), z) * DEG, dist: len(d), behind: z <= 1e-4 };
}
function inZone(a, zone, margin = 0) {
  return !a.behind && a.yaw >= -zone.left + margin && a.yaw <= zone.right - margin && a.pitch <= zone.up - margin && a.pitch >= -zone.down + margin;
}
/** How far inside (positive) or outside (negative) the zone edge, in degrees. */
function edgeMargin(a, zone) {
  if (a.behind) return -180;
  return Math.min(zone.left + a.yaw, zone.right - a.yaw, zone.up - a.pitch, zone.down + a.pitch);
}

// ------------------------------------------------------------------------------------------------ scene
function candidateNames() {
  return [
    ...PROPS,
    'mat',
    ...GADGETS,
    ...GADGETS.map((g) => `${g}-focus`),
    ...SPECTATORS.flatMap((s) => [s, `${s}-head`, `${s}-eyes`]),
    ...PLAQUES.map((p) => `plaque-${p}`),
    'burst',
    'volunteerSpot',
  ];
}

/** Key objects: { id, cat, position, radius, visible, via, corners? } from a findObjects result. */
function keyObjects(found) {
  const by = new Map(found.filter((o) => o.found).map((o) => [o.name, o]));
  const out = [];
  // the visual centre (world box of visible geometry) — the origin of a baked mesh can be anywhere; anchors use the origin
  const add = (id, cat, o, via = o.name) => out.push({ id, cat, position: o.center ?? o.position, radius: o.radius ?? 0, visible: o.visible, via, corners: o.corners });
  for (const p of PROPS) if (by.has(p)) add(p, 'prop', by.get(p));
  if (by.has('mat')) add('mat', 'mat', by.get('mat'));
  for (const g of GADGETS) {
    if (by.has(g)) add(g, 'gadget', by.get(g));
    if (by.has(`${g}-focus`)) add(`${g}-focus`, 'focus', by.get(`${g}-focus`));
  }
  for (const s of SPECTATORS) {
    const h = by.get(`${s}-head`) ?? by.get(`${s}-eyes`);
    if (h) add(`${s}-head`, 'head', h);
    else if (by.has(s)) {
      const r = by.get(s);
      add(`${s}-head`, 'head', { ...r, position: [r.position[0], r.position[1] + 0.09, r.position[2]], radius: 0.03 }, `${s} (+9 cm)`);
    }
  }
  for (const p of PLAQUES) if (by.has(`plaque-${p}`)) add(`plaque-${p}`, 'plaque', by.get(`plaque-${p}`));
  if (by.has('burst')) add('burst', 'burst', by.get('burst'));
  if (by.has('volunteerSpot')) add('volunteerSpot', 'spot', by.get('volunteerSpot'));
  return out;
}

function categoryOf(id) {
  if (PROPS.includes(id)) return 'prop';
  if (id === 'mat') return 'mat';
  if (GADGETS.includes(id)) return 'gadget';
  if (id.endsWith('-focus')) return 'focus';
  if (id.startsWith('plaque')) return 'plaque';
  if (SPECTATORS.some((s) => id === s || id.startsWith(`${s}-`))) return 'head';
  if (id === 'burst') return 'burst';
  return 'other';
}

// ------------------------------------------------------------------------------------------------ run
const base = qa.baseUrl(args);
const url = qa.appUrl(base, { demo: args.demo ?? undefined });
const eye = qa.vec(args.eye, qa.DEFAULT_EYE);
const shots = args.shots !== false;
const report = { url, eye, zones: ZONES, acts: [], failures: [], warnings: [], crossCheck: [], screenshots: [], source: 'scene' };
let exitCode = 0;
const browser = await qa.launchBrowser();
try {
  const app = await qa.openApp(url, { browser });
  const page = app.page;
  await qa.enterXR(page, { fov: 60, head: eye, look: [eye[0], eye[1], eye[2] - 1] });
  const hasApp = await qa.hasApp(page, { timeout: args.demo ? 1500 : 8000 });
  if (hasApp) await qa.waitForState(page, (s) => s.calibrated !== false, { timeout: 5000, throws: false });
  const hasFovReport = hasApp && (await page.evaluate(() => typeof window.__app?.fovReport === 'function').catch(() => false));
  if (hasFovReport) report.source = 'fovReport + scene';
  const acts = hasApp && !args.demo ? String(args.acts ?? '1,2,3').split(',').map(Number).filter(Boolean) : [null];

  // second page sized to the glasses frustum for screenshots: symmetric 86° fovy (±43°) and 37° sides, then the
  // top band above +25° is clipped away → exactly 37/37/25/43.
  let glassPage = null;
  const GW = 808;
  const GH = 1000;
  const clipTop = Math.round((GH * (1 - Math.tan((25 * Math.PI) / 180) / Math.tan((43 * Math.PI) / 180))) / 2);
  if (shots) {
    const gapp = await qa.openApp(url, { browser, w: GW, h: GH });
    glassPage = gapp.page;
    await qa.enterXR(glassPage, { fov: 86, head: eye, look: [eye[0], eye[1], eye[2] - 1] });
    await glassPage.evaluate(() => window.__debugOverlay?.setVisible(false)).catch(() => {}); // clean frustum shots
  }

  for (const act of acts) {
    const label = act ? `Act ${act}` : 'Scene';
    if (act) {
      for (const p of [page, glassPage].filter(Boolean)) {
        await qa.placeHead(p, eye, [eye[0], eye[1], eye[2] - 1]);
        await qa.callApp(p, 'skipTo', act, 0).catch((e) => report.warnings.push(`${label}: skipTo failed: ${e.message}`));
      }
      await qa.wait(page, 1.5);
    }
    const found0 = await qa.findObjects(page, candidateNames(), { corners: true });
    const objs0 = keyObjects(found0);
    const actRes = { act, label, poses: [], objects: objs0.map((o) => ({ id: o.id, cat: o.cat, via: o.via, visible: o.visible })) };
    report.acts.push(actRes);
    if (objs0.length === 0) {
      report.failures.push(`${label}: no named key objects found (expected names like coin, mat, musicBox-focus, kit1-head, plaque-exit)`);
      continue;
    }
    const byId = new Map(objs0.map((o) => [o.id, o]));
    const poses = [{ name: 'ahead', kind: 'ahead', look: [eye[0], eye[1], eye[2] - 1] }];
    const matObj = byId.get('mat') ?? byId.get('coin');
    if (matObj) poses.push({ name: 'mat', kind: 'mat', look: matObj.position });
    for (const g of GADGETS) {
      const f = byId.get(`${g}-focus`) ?? byId.get(g);
      if (f) poses.push({ name: `glance:${g}`, kind: 'glance', look: f.position });
    }

    for (const pose of poses) {
      await qa.placeHead(page, eye, pose.look);
      await qa.wait(page, 0.3);
      const foundList = await qa.findObjects(page, candidateNames(), { corners: true });
      const foundMap = new Map(foundList.filter((f) => f.found).map((f) => [f.name, f]));
      const objs = keyObjects(foundList);
      const B = basis(eye, pose.look);
      const rows = [];
      for (const o of objs) {
        const a = angles(eye, B, o.position);
        // props: the whole world box must be inside (exact extent; prop origins usually sit at their base)
        const box = o.cat === 'prop' && o.corners ? o.corners.map((c) => angles(eye, B, c)) : null;
        const angR = 0;
        const zones = {};
        for (const [zn, z] of Object.entries(ZONES)) {
          zones[zn] = box
            ? { inside: box.every((c) => inZone(c, z)), margin: Math.min(...box.map((c) => edgeMargin(c, z))) }
            : { inside: inZone(a, z), margin: edgeMargin(a, z) };
        }
        const req = REQUIRED[pose.kind]?.[o.cat] ?? [];
        const row = { id: o.id, cat: o.cat, visible: o.visible, ...a, angR, zones, required: req };
        if (o.cat === 'mat' && o.corners) {
          const ca = o.corners.map((c) => angles(eye, B, c));
          row.corners = { minPitch: Math.min(...ca.map((c) => c.pitch)), maxPitch: Math.max(...ca.map((c) => c.pitch)), maxAbsYaw: Math.max(...ca.map((c) => Math.abs(c.yaw))), allInGlasses: ca.every((c) => inZone(c, ZONES.glasses)) };
        }
        for (const zn of Object.keys(ZONES)) {
          if (zones[zn].inside) continue;
          const msg = `${label} · ${pose.name}: ${o.id} (${o.cat}) outside ${ZONES[zn].label} — yaw ${a.yaw.toFixed(1)}°, pitch ${a.pitch.toFixed(1)}°${a.behind ? ' (behind)' : ''}, ${(-zones[zn].margin).toFixed(1)}° past the edge`;
          if (req.includes(zn) && o.visible !== false && -zones[zn].margin > TOL) report.failures.push(msg);
          else if (req.includes(zn) && o.visible !== false) report.warnings.push(`${msg} [within --tolerance=${TOL}]`);
          else if (req.includes(zn)) report.warnings.push(`${msg} [hidden]`);
        }
        rows.push(row);
      }
      // the game's own report for this pose
      let reported = null;
      if (hasFovReport) {
        reported = await qa.callApp(page, 'fovReport').catch((e) => (report.warnings.push(`fovReport() threw: ${e.message}`), null));
        if (Array.isArray(reported)) {
          for (const e of reported) {
            if (!e || typeof e.id !== 'string') continue;
            // compare against the same-named scene object when it exists (any name), else the head/focus row
            const same = foundMap.get(e.id);
            const mine = same
              ? { id: e.id, ...angles(eye, B, same.position) }
              : (rows.find((r) => r.id === `${e.id}-head`) ?? rows.find((r) => r.id === `${e.id}-focus`));
            if (mine) {
              const d = Math.max(Math.abs(mine.yaw - e.yaw), Math.abs(mine.pitch - e.pitch));
              report.crossCheck.push({ act, pose: pose.name, id: e.id, against: mine.id, dYawPitch: +d.toFixed(2), dDist: +Math.abs(mine.dist - e.distance).toFixed(3) });
            } else if (pose.kind === 'ahead') {
              const cat = categoryOf(e.id);
              const a = { yaw: e.yaw, pitch: e.pitch, dist: e.distance, behind: false };
              const zones = {};
              for (const [zn, z] of Object.entries(ZONES)) zones[zn] = { inside: inZone(a, z), margin: edgeMargin(a, z) };
              const req = REQUIRED.ahead[cat] ?? [];
              rows.push({ id: e.id, cat, visible: true, ...a, angR: 0, zones, required: req, reportedOnly: true });
              for (const zn of Object.keys(ZONES)) {
                if (!zones[zn].inside && req.includes(zn)) report.failures.push(`${label} · ahead: ${e.id} (fovReport) outside ${ZONES[zn].label} — yaw ${e.yaw.toFixed(1)}°, pitch ${e.pitch.toFixed(1)}°`);
              }
            }
          }
        }
      }
      // glasses-shaped screenshot of this pose
      let shot = null;
      if (glassPage) {
        await qa.placeHead(glassPage, eye, pose.look);
        await qa.wait(glassPage, 0.35);
        shot = await qa.screenshot(glassPage, qa.outPath('fov', `${act ? `act${act}-` : ''}${pose.name.replace(':', '-')}.png`), {
          clip: { x: 0, y: clipTop, width: GW, height: GH - clipTop },
        });
        report.screenshots.push(shot);
      }
      actRes.poses.push({ name: pose.name, kind: pose.kind, look: pose.look, rows, shot, reportedCount: Array.isArray(reported) ? reported.length : null });
    }
  }
  const big = report.crossCheck.filter((c) => c.dYawPitch > 2.5);
  if (big.length) report.warnings.push(`fovReport() disagrees with the scene by > 2.5° for ${big.length} entries (e.g. ${big[0].id}: ${big[0].dYawPitch}°) — check its angle convention`);
  report.errors = [...qa.consoleErrors(page)];
  if (report.errors.length) report.warnings.push(`console errors during the run: ${report.errors.slice(0, 3).join(' | ')}`);
  await app.close();
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  exitCode = 2;
} finally {
  await browser.close().catch(() => {});
}

report.ok = !report.fatal && report.failures.length === 0;
if (!report.fatal && report.failures.length) exitCode = 1;
qa.writeText(qa.outPath('fov-report.md'), markdown(report));
qa.writeJson(qa.outPath('fov.json'), report);
console.log(
  JSON.stringify(
    {
      ok: report.ok,
      url: report.url,
      source: report.source,
      acts: report.acts.map((a) => ({ act: a.act, objects: a.objects.length, poses: a.poses.map((p) => p.name) })),
      failures: report.failures,
      warnings: report.warnings.slice(0, 20),
      fatal: report.fatal,
      report: 'tests/out/fov-report.md',
    },
    null,
    2,
  ),
);
process.exit(exitCode);

// ------------------------------------------------------------------------------------------------ report
function markdown(r) {
  const L = [];
  L.push(`# FoV report: ${r.ok ? 'PASS' : r.fatal ? 'ERROR' : 'FAIL'}`, '');
  L.push(`- URL: ${r.url}`, `- Eye: (${r.eye.join(', ')}) · source: ${r.source}`);
  L.push(
    `- Zones (tangent-plane angles, as a display frustum clips): **quest3** ±${ZONES.quest3.left}° / +${ZONES.quest3.up}° / -${ZONES.quest3.down}°; **glasses** ±${ZONES.glasses.left}° / +${ZONES.glasses.up}° / -${ZONES.glasses.down}°`,
    '- Props must be fully inside (all 8 corners of their world box). Required checks: ahead → props, mat, heads, gadgets, focus, burst in both zones; mat pose → props + mat in glasses, plaques in quest3; each gadget glance → props + mat in glasses.',
    '',
  );
  if (r.fatal) L.push('## Fatal', '', '```', r.fatal, '```', '');
  if (r.failures.length) L.push('## Failures', '', ...r.failures.map((f) => `- ${f}`), '');
  if (r.warnings.length) L.push('## Advisory', '', ...r.warnings.map((f) => `- ${f}`), '');
  for (const a of r.acts) {
    L.push(`## ${a.label}`, '');
    for (const p of a.poses) {
      L.push(`### Pose \`${p.name}\` (look at ${p.look.map((v) => v.toFixed(2)).join(', ')})`, '');
      L.push(
        qa.mdTable(
          ['object', 'cat', 'yaw°', 'pitch°', 'dist m', 'quest3', 'glasses', 'required', 'note'],
          p.rows.map((row) => [
            row.id,
            row.cat,
            row.yaw.toFixed(1),
            row.pitch.toFixed(1),
            row.dist.toFixed(2),
            zoneCell(row, 'quest3'),
            zoneCell(row, 'glasses'),
            row.required.join('+') || '–',
            [
              row.visible === false ? 'hidden' : '',
              row.reportedOnly ? 'fovReport only' : '',
              row.corners ? `corners pitch ${row.corners.minPitch.toFixed(0)}…${row.corners.maxPitch.toFixed(0)}°, |yaw| ≤ ${row.corners.maxAbsYaw.toFixed(0)}°${row.corners.allInGlasses ? ', all in glasses' : ''}` : '',
            ]
              .filter(Boolean)
              .join('; '),
          ]),
        ),
        '',
      );
      if (p.shot) L.push(`Glasses view: ![${p.name}](${qa.relOut(p.shot)})`, '');
    }
  }
  if (r.crossCheck.length) {
    const worst = [...r.crossCheck].sort((x, y) => y.dYawPitch - x.dYawPitch).slice(0, 10);
    L.push('## fovReport() cross-check (largest differences)', '', qa.mdTable(['act', 'pose', 'id', 'vs', 'Δ angle °', 'Δ dist m'], worst.map((c) => [c.act ?? '–', c.pose, c.id, c.against, c.dYawPitch, c.dDist])), '');
  }
  return `${L.join('\n')}\n`;
}

function zoneCell(row, zn) {
  const z = row.zones[zn];
  const m = `${z.margin >= 0 ? '+' : ''}${z.margin.toFixed(1)}°`;
  if (z.inside) return `in (${m})`;
  return row.required.includes(zn) ? `**OUT** (${m})` : `out (${m})`;
}
