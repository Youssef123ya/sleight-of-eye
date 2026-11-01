// tests/lib/acts.mjs — data-driven act playthroughs (owned by Q), shared by tests/scenarios/act1..3.mjs.
//
// The game is written in parallel, so the driver is written against the contracts and spec §7 rather than a fixed
// beat list: it reads window.__app.debugState() ({ act, beat, beatKind, phase, caught, alarm, palmed, loaded,
// gazeTarget, watchers, calibrated, paused, stars }), runs the handler for the current beatKind (intro, demo, show,
// steal, load, lookBack, reveal, bow), waits for the beat to change, and repeats. A beat that does not advance is
// reported with the last state and a screenshot, then skipped with skipTo() so one broken beat never hides the rest.
//
// Two paths per act:
//   success — misdirect with the act's gadget(s), steal unseen, load, look back, reveal → act complete, 0 catches.
//   catch   — steal while the audience watches the mat → caught increments and the beat holds (phase 'caught', the
//             catcher's alarm set), then really rewinds (same beat kind, phase 'active', alarm null, prop not
//             palmed), then misdirect and steal again to prove the rewind is recoverable (spec pillar 3).
import path from 'node:path';
import * as qa from './iwer.mjs';

/** Per-act plan (names follow the naming conventions; timings follow src/config.ts). */
export const ACTS = {
  1: {
    title: 'Vanishing Coin',
    prop: 'coin',
    // music box: 0.6 s dwell fires it, kits follow 0.3 s behind, head turn ~0.3 s
    misdirect: [{ look: ['musicBox-focus', 'musicBox'], hold: 1.5 }],
    duringSteal: ['musicBox-focus', 'musicBox'],
    load: null,
    reveal: [{ volunteerEar: true }],
  },
  2: {
    title: 'Cups & Ball',
    prop: 'ball',
    misdirect: [{ look: ['candle-focus', 'candle'], hold: 1.5 }],
    duringSteal: ['candle-focus', 'candle'],
    load: 'cupRight',
    reveal: ['cupMid', 'cupRight'],
  },
  3: {
    title: "The Critic's Watch",
    prop: 'watch',
    misdirect: [
      { look: ['firework-focus', 'firework'], hold: 0.9 }, // light the fuse (0.6 s dwell; bangs 2.5 s later)
      { look: ['brock-eyes', 'brock-head', 'brock'], hold: 1.4 }, // hold his eyes 1.0 s: blush + scribble 6 s
      { wait: 1.0 }, // BANG: every free head looks at the burst for 4 s
    ],
    duringSteal: ['burst', 'firework-focus', 'firework'],
    load: 'cupcake',
    reveal: ['cupcake'],
  },
};

const BEAT_TIMEOUT = { intro: 14, demo: 26, show: 10, steal: 10, load: 8, lookBack: 10, reveal: 10, bow: 4 };
// A catch holds the beat in phase 'caught' for CFG.catchCaptionTime (1.6 s) + half the 0.7 s rewind smear, then
// restores the checkpoint (src/game/tricks.ts caught()). Allow for slow headless frames.
const REWIND_TIMEOUT_MS = 6000;

const caughtValue = (s) => (typeof s?.caught === 'number' ? s.caught : s?.caught ? JSON.stringify(s.caught) : 0);
const caughtSince = (base, s) =>
  typeof s?.caught === 'number' && typeof base?.caught === 'number' ? s.caught > base.caught : !!s?.caught && caughtValue(s) !== caughtValue(base);
const holds = (v, prop) => (typeof v === 'string' ? v === prop : Array.isArray(v) ? v.includes(prop) : !!v && (v.prop === prop || v === true));
const actDone = (s, act) =>
  !!s && ((Array.isArray(s.stars) && Number(s.stars[act - 1]) > 0) || Number(s.act) > act || String(s.beatKind).toLowerCase() === 'bow');
const beatKey = (s) => `${s?.act}:${s?.beat}:${s?.beatKind}`;
const kindOf = (s) => String(s?.beatKind ?? 'unknown');
/**
 * The catch really rewound: the same beat kind is running again (phase 'active', not 'caught'), the catcher's alarm
 * is cleared and the prop is not palmed. Same kind + not palmed alone is already true during the ~2 s 'caught'
 * phase, before anything rewinds, so phase and alarm (both in debugState) are required.
 */
const rewoundTo = (s, prop) => (st) => kindOf(st) === kindOf(s) && st.phase === 'active' && st.alarm === null && !holds(st.palmed, prop);
const brief = (st) => (st ? `beat ${st.beat} ${st.beatKind}, phase ${st.phase}, alarm ${st.alarm}, palmed ${JSON.stringify(st.palmed)}` : 'no state');

/** Wait for the beat to rewind after a catch seen at `caughtAt` (ms). Resolves { state | null, last, seconds }. */
async function waitRewind(ctx, s, prop, caughtAt) {
  let state = null;
  let last = null;
  try {
    state = await qa.waitForState(ctx.page, rewoundTo(s, prop), { timeout: REWIND_TIMEOUT_MS, label: 'rewind after the catch' });
  } catch (e) {
    last = e.details?.state ?? (await qa.appState(ctx.page).catch(() => null));
  }
  return { state, last, seconds: (Date.now() - caughtAt) / 1000 };
}

function rewindStep(ctx, rw) {
  return ctx.step(
    'steal',
    'beat rewinds (no penalty)',
    !!rw.state,
    rw.state ? `${rw.seconds.toFixed(1)} s after the catch: ${brief(rw.state)}` : `not rewound ${rw.seconds.toFixed(1)} s after the catch (last: ${brief(rw.last)})`,
  );
}

/** Report name: act<N>, or act<N>-<tag> (--tag keeps e.g. a fixture selftest apart from the real game's report). */
export const reportName = (act, tag) => {
  const t = String(tag ?? '').replace(/[^a-z0-9_-]+/gi, '');
  return t ? `act${act}-${t}` : `act${act}`;
};

/** Context for one path: page, logging, screenshots, failures. */
function makeCtx(page, { act, path: pathName, side, shots, outDir, name = `act${act}` }) {
  const ctx = {
    page,
    act,
    path: pathName,
    side,
    steps: [],
    failures: [],
    shots: [],
    shotIdx: 0,
    t0: Date.now(),
    async shot(label) {
      if (!shots) return null;
      const file = `${String(++ctx.shotIdx).padStart(2, '0')}-${label.replace(/[^a-z0-9-]+/gi, '_')}.png`;
      try {
        const p = await qa.screenshot(page, path.join(outDir, `${name}-${pathName}`, file));
        ctx.shots.push(p);
        return p;
      } catch {
        return null;
      }
    },
    step(kind, action, ok, note = '', extra = {}) {
      const rec = { t: +((Date.now() - ctx.t0) / 1000).toFixed(1), kind, action, ok, note, ...extra };
      ctx.steps.push(rec);
      if (ok === false) ctx.failures.push(`[${kind}] ${action}: ${note}`);
      return rec;
    },
  };
  return ctx;
}

/** Look at the first of `names` that exists (lookAt with a short human glance). */
async function lookFirst(ctx, names, duration = 0.3) {
  for (const n of names) {
    try {
      return await qa.lookAt(ctx.page, n, { duration });
    } catch {
      /* try the next name */
    }
  }
  throw new qa.QAError(`none of ${names.join(', ')} exists in the scene`);
}

async function misdirect(ctx, plan) {
  for (const m of plan.misdirect) {
    if (m.wait) {
      await qa.wait(ctx.page, m.wait);
      continue;
    }
    const r = await lookFirst(ctx, m.look);
    await qa.wait(ctx.page, m.hold);
    ctx.step('steal', `misdirect: look at ${r.target}`, true, `yaw ${r.yaw.toFixed(0)}°, pitch ${r.pitch.toFixed(0)}°`);
  }
  const s = await qa.waitForState(ctx.page, (st) => typeof st.watchers !== 'number' || st.watchers === 0, {
    timeout: 3000,
    throws: false,
  });
  if (!s) {
    const now = await qa.appState(ctx.page);
    ctx.step('steal', 'audience looks away', null, `watchers still ${now?.watchers} (trying anyway)`);
  }
  // keep the eyes off the mat while the hand works
  try {
    await lookFirst(ctx, plan.duringSteal, 0.2);
  } catch {
    /* keep the current head pose */
  }
}

async function waitAdvance(ctx, from, seconds) {
  return qa.waitForState(
    ctx.page,
    (s) => beatKey(s) !== beatKey(from) || actDone(s, ctx.act),
    { timeout: seconds * 1000, throws: false, interval: 120 },
  );
}

// ------------------------------------------------------------------------------------------------ handlers
// Each handler performs the beat's action and returns { advanced: state|null }.
const HANDLERS = {
  async intro(ctx, plan, s) {
    // heads follow the spotlight: glance around the audience and back to the mat
    const tour = ['kit1-head', 'kit3-head', 'mat', 'kit2-head', 'mat'];
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < BEAT_TIMEOUT.intro * 1000) {
      await lookFirst(ctx, [tour[i++ % tour.length], 'mat'], 0.35).catch(() => {});
      const adv = await waitAdvance(ctx, s, 1.2);
      if (adv) return { advanced: adv };
    }
    return { advanced: null };
  },

  async demo(ctx, plan, s) {
    await lookFirst(ctx, ['mat'], 0.3).catch(() => {});
    return { advanced: await waitAdvance(ctx, s, BEAT_TIMEOUT.demo) };
  },

  async show(ctx, plan, s) {
    await lookFirst(ctx, [plan.prop, 'mat'], 0.3).catch(() => {});
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await qa.pinchAt(ctx.page, ctx.side, plan.prop, { lift: 0.1, hold: 0.8 });
      ctx.step('show', `pinch-lift ${plan.prop} (attempt ${attempt})`, r.ok, r.result?.error ?? `${r.selects} selectstart`);
      await ctx.shot(`show-lifted-${plan.prop}`);
      const adv = await waitAdvance(ctx, s, 4);
      if (adv) return { advanced: adv };
    }
    return { advanced: await waitAdvance(ctx, s, 2) };
  },

  async steal(ctx, plan, s) {
    const base = await qa.appState(ctx.page);
    if (ctx.path === 'catch' && !ctx.caughtOnce) {
      // everyone watches the mat, then steal in plain sight
      await lookFirst(ctx, ['mat', plan.prop], 0.3).catch(() => {});
      await qa.wait(ctx.page, 1.0);
      const watching = await qa.appState(ctx.page);
      ctx.step('steal', 'audience watches the mat', typeof watching?.watchers !== 'number' || watching.watchers > 0, `watchers ${watching?.watchers}`);
      const r = await qa.pinchAt(ctx.page, ctx.side, plan.prop, { hold: 0.2 });
      ctx.step('steal', `pinch-palm ${plan.prop} in plain sight`, r.ok, r.result?.error ?? `${r.selects} selectstart`);
      const caught = await qa.waitForState(ctx.page, (st) => caughtSince(base, st), { timeout: 4000, throws: false });
      const caughtAt = Date.now();
      await ctx.shot('caught');
      ctx.step('steal', '"I SAW THAT!" (caught increments)', !!caught, caught ? `caught ${JSON.stringify(caught.caught)}` : 'no catch registered');
      ctx.caughtOnce = true;
      if (!caught) return { advanced: await waitAdvance(ctx, s, 1), abort: true };
      // the catch is visible: the runner holds the beat ('caught' phase) while the catcher's sight cone flashes
      ctx.step('steal', "caught phase: the beat holds, the catcher's cone flashes", caught.phase === 'caught' && caught.alarm != null, brief(caught));
      // rewind: the same beat kind running again (phase 'active'), alarm cleared, prop not palmed
      const rw = await waitRewind(ctx, s, plan.prop, caughtAt);
      await ctx.shot('rewound');
      rewindStep(ctx, rw);
      if (!rw.state) return { advanced: await waitAdvance(ctx, s, 1), abort: true };
      return { advanced: null, retry: true }; // the driver re-reads the state and runs the success steal
    }
    await misdirect(ctx, plan);
    const r = await qa.pinchAt(ctx.page, ctx.side, plan.prop, { hold: 0.15 });
    ctx.step('steal', `pinch-palm ${plan.prop} unseen`, r.ok, r.result?.error ?? `${r.selects} selectstart`);
    const palmed = await qa.waitForState(ctx.page, (st) => holds(st.palmed, plan.prop) || beatKey(st) !== beatKey(s) || caughtSince(base, st), {
      timeout: 3000,
      throws: false,
    });
    await ctx.shot(`stole-${plan.prop}`);
    if (palmed && caughtSince(base, palmed)) {
      const caughtAt = Date.now();
      ctx.step('steal', `${plan.prop} palmed unseen`, false, `caught while stealing (watchers ${palmed.watchers}, by ${palmed.alarm ?? '?'})`);
      // retry only once the beat has really rewound (pinches are ignored during the 'caught' phase)
      rewindStep(ctx, await waitRewind(ctx, s, plan.prop, caughtAt));
      return { advanced: null, retry: true };
    }
    ctx.step('steal', `${plan.prop} palmed unseen`, !!palmed, palmed ? `palmed ${JSON.stringify(palmed.palmed)}` : 'palmed never set');
    // a steal+load beat (Act 2/3) loads right away while the gadget still holds the room
    if (plan.load && palmed && beatKey(palmed) === beatKey(s)) await HANDLERS.load(ctx, plan, palmed, { inline: true });
    return { advanced: await waitAdvance(ctx, s, 4) };
  },

  async load(ctx, plan, s, { inline = false } = {}) {
    if (!plan.load) return { advanced: await waitAdvance(ctx, s, BEAT_TIMEOUT.load) };
    const base = await qa.appState(ctx.page);
    const r = await qa.pinchAt(ctx.page, ctx.side, plan.load, { hold: 0.15 });
    ctx.step('load', `pinch-load into ${plan.load} without looking`, r.ok, r.result?.error ?? `${r.selects} selectstart`);
    const loaded = await qa.waitForState(
      ctx.page,
      (st) => !!st.loaded || beatKey(st) !== beatKey(s) || caughtSince(base, st),
      { timeout: 3000, throws: false },
    );
    await ctx.shot(`loaded-${plan.load}`);
    if (loaded && caughtSince(base, loaded)) ctx.step('load', 'load unseen', false, 'caught while loading');
    else ctx.step('load', 'load registered', !!loaded, loaded ? `loaded ${JSON.stringify(loaded.loaded)}` : 'loaded never set');
    if (inline) return { advanced: null };
    return { advanced: await waitAdvance(ctx, s, 4) };
  },

  async lookBack(ctx, plan, s) {
    await lookFirst(ctx, ['mat'], 0.35).catch(() => {});
    ctx.step('lookBack', 'look back at the mat', true);
    const adv = await waitAdvance(ctx, s, BEAT_TIMEOUT.lookBack);
    await ctx.shot('look-back');
    return { advanced: adv };
  },

  async reveal(ctx, plan, s) {
    // The game names the live poke target once the reveal is ready (debugState().revealTarget: '<kit>-ear' or a
    // prop id). Use it when present; otherwise fall back to the plan (volunteer's ear / the act's props).
    const ready = await qa.waitForState(
      ctx.page,
      (st) => (typeof st.revealTarget === 'string' && st.revealTarget.length > 0) || beatKey(st) !== beatKey(s) || !('revealTarget' in st),
      { timeout: 5000, throws: false },
    );
    const named = ready && beatKey(ready) === beatKey(s) && typeof ready.revealTarget === 'string' ? ready.revealTarget : null;
    const targets = [];
    if (named) targets.push(named);
    else {
      for (const t of plan.reveal) {
        if (t.volunteerEar) targets.push(...(await volunteerEars(ctx)));
        else targets.push(t);
      }
    }
    let adv = null;
    for (const target of targets) {
      await lookFirst(ctx, [target, 'mat'], 0.3).catch(() => {});
      const r = await qa.pokeAt(ctx.page, ctx.side, target);
      ctx.step('reveal', `poke ${target}`, r.ok, r.result?.error ?? `contact ${r.contactMs ?? '?'} ms`);
      await ctx.shot(`poke-${target}`);
      adv = await waitAdvance(ctx, s, 2.5);
      if (adv && actDone(adv, ctx.act)) return { advanced: adv };
    }
    return { advanced: adv ?? (await waitAdvance(ctx, s, 3)) };
  },

  async bow() {
    return { advanced: null };
  },

  async unknown(ctx, plan, s) {
    return { advanced: await waitAdvance(ctx, s, 8) };
  },
};

/** The volunteer kit is the one standing nearest the volunteerSpot (waits for its hop); returns ear names. */
async function volunteerEars(ctx) {
  const kits = ['kit1', 'kit2', 'kit3'];
  const t0 = Date.now();
  let order = kits;
  while (Date.now() - t0 < 4000) {
    const objs = await qa.findObjects(ctx.page, ['volunteerSpot', ...kits]);
    const spot = objs[0];
    if (!spot.found) break;
    const d = objs.slice(1).filter((o) => o.found).map((o) => ({ id: o.name, d: Math.hypot(o.position[0] - spot.position[0], o.position[2] - spot.position[2]) }));
    d.sort((a, b) => a.d - b.d);
    order = d.map((x) => x.id);
    if (d[0] && d[0].d < 0.06) break;
    await qa.sleep(250);
  }
  return order.map((id) => `${id}-ear`);
}

// ------------------------------------------------------------------------------------------------ driver
async function discoverBeat(page, act, kind, maxBeat = 14) {
  for (let b = 0; b <= maxBeat; b++) {
    await qa.callApp(page, 'skipTo', act, b);
    const s = await qa.waitForState(page, (st) => Number(st.act) === act && Number(st.beat) === b, { timeout: 1500, throws: false });
    if (s && kindOf(s) === kind) return b;
    if (s && Number(s.act) !== act) break;
  }
  return -1;
}

/** Play one act along one path on an XR-ready page. */
export async function playActPath(page, act, pathName, { side = 'right', shots = true, outDir = qa.outPath('scenarios'), maxBeats = 16, name } = {}) {
  const plan = ACTS[act];
  const ctx = makeCtx(page, { act, path: pathName, side, shots, outDir, name: name ?? reportName(act) });
  try {
    if (pathName === 'catch') {
      const b = await discoverBeat(page, act, 'steal');
      ctx.step('setup', `skipTo(${act}, steal beat)`, b >= 0, b >= 0 ? `steal is beat ${b}` : 'no beat with beatKind "steal"');
      if (b < 0) return finish(ctx, null);
    } else {
      await qa.callApp(page, 'skipTo', act, 0);
      const s = await qa.waitForState(page, (st) => Number(st.act) === act, { timeout: 4000, throws: false });
      ctx.step('setup', `skipTo(${act}, 0)`, !!s, s ? `beat ${s.beat} ${s.beatKind}` : 'act never became current');
      if (!s) return finish(ctx, null);
    }
    const startState = await qa.appState(page);
    ctx.startCaught = startState?.caught;
    await ctx.shot(`start-${kindOf(startState)}`);
    let state = startState;
    let lastKey = null;
    let repeats = 0;
    for (let i = 0; i < maxBeats; i++) {
      if (actDone(state, act)) break;
      if (pathName === 'catch' && ctx.recovered) break;
      const kind = kindOf(state);
      const key = beatKey(state);
      repeats = key === lastKey ? repeats + 1 : 0;
      lastKey = key;
      if (repeats > 2) {
        ctx.step(kind, 'beat stuck', false, `still ${key} after ${repeats + 1} tries — skipping`, { state });
        await qa.callApp(page, 'skipTo', act, Number(state.beat) + 1).catch(() => {});
        state = await qa.appState(page);
        continue;
      }
      const handler = HANDLERS[kind] ?? HANDLERS.unknown;
      const beforeShot = await ctx.shot(`beat${state.beat}-${kind}`);
      const r = await handler(ctx, plan, state);
      if (pathName === 'catch' && kind === 'steal' && ctx.caughtOnce && !r.retry && r.advanced && !r.abort) ctx.recovered = true;
      if (r.abort) break;
      if (r.retry) {
        state = await qa.appState(page);
        continue;
      }
      if (!r.advanced) {
        const now = await qa.appState(page);
        ctx.step(kind, 'beat completes', false, `no advance from ${key}; state ${JSON.stringify(now)}`, { shot: beforeShot });
        await ctx.shot(`stuck-${kind}`);
        await qa.callApp(page, 'skipTo', act, Number(state.beat) + 1).catch(() => {});
        state = await qa.appState(page);
        continue;
      }
      ctx.step(kind, 'beat completes', true, `→ ${beatKey(r.advanced)}`);
      state = r.advanced;
    }
    const end = await qa.appState(page);
    await ctx.shot(`end-${kindOf(end)}`);
    return finish(ctx, end);
  } catch (e) {
    ctx.step('driver', 'exception', false, `${e.message}${e.details?.state ? ` | state ${JSON.stringify(e.details.state)}` : ''}`);
    await ctx.shot('exception');
    return finish(ctx, await qa.appState(page).catch(() => null));
  }
}

function finish(ctx, end) {
  const { act, path: pathName } = ctx;
  if (pathName === 'success') {
    const done = actDone(end, act);
    ctx.step('result', 'act complete', done, end ? `stars ${JSON.stringify(end.stars)}, act ${end.act}, beat ${end.beatKind}` : 'no state');
    const clean = end ? !caughtSince({ caught: ctx.startCaught }, end) : false;
    ctx.step('result', 'no catches on the success path', clean, `caught ${JSON.stringify(end?.caught)}`);
  } else {
    ctx.step('result', 'caught, rewound and recovered', !!ctx.caughtOnce && !!ctx.recovered, ctx.recovered ? 'steal succeeded after the rewind' : 'recovery steal did not complete');
  }
  return {
    act,
    path: pathName,
    ok: ctx.failures.length === 0,
    failures: ctx.failures,
    steps: ctx.steps,
    screenshots: ctx.shots,
    end,
    seconds: +((Date.now() - ctx.t0) / 1000).toFixed(1),
  };
}

// ------------------------------------------------------------------------------------------------ CLI
/**
 * Standalone runner for tests/scenarios/act<N>.mjs:
 *   node tests/scenarios/act1.mjs [--url=http://127.0.0.1:8081/] [--demo=debug] [--paths=success,catch]
 *        [--hand=right|left] [--easy] [--no-shots] [--require-app] [--tag=<name>] [--timeout=240]
 * Report: tests/out/scenarios/act<N>[-<tag>].json + .md, screenshots in tests/out/scenarios/act<N>[-<tag>]-<path>/.
 * Exit 0 = pass (or skipped: no window.__app), 1 = a path failed, 2 = could not run.
 */
export async function runActCli(act) {
  const args = qa.parseArgs();
  const timeoutS = Number(args.timeout ?? 240);
  qa.installWatchdog(timeoutS * 1000, `act${act} scenario`);
  const name = reportName(act, args.tag);
  const res = await runAct(act, args).catch((e) => ({ act, name, status: 'error', error: String(e?.stack ?? e) }));
  qa.writeJson(qa.outPath('scenarios', `${name}.json`), res);
  console.log(JSON.stringify(summarize(res), null, 2));
  process.exit(res.status === 'pass' || res.status === 'skip' ? 0 : res.status === 'fail' ? 1 : 2);
}

export async function runAct(act, args = {}) {
  const base = qa.baseUrl(args);
  const url = qa.appUrl(base, { demo: args.demo ?? undefined });
  const paths = String(args.paths ?? 'success,catch').split(',').filter(Boolean);
  const side = args.hand === 'left' ? 'left' : 'right';
  const shots = args.shots !== false;
  const name = reportName(act, args.tag);
  const browser = await qa.launchBrowser();
  const results = [];
  const errors = [];
  let status = 'pass';
  try {
    for (const p of paths) {
      const app = await qa.openApp(url, { browser });
      try {
        if (!(await qa.hasApp(app.page, { timeout: Number(args.appWait ?? 20) * 1000 }))) {
          await app.close();
          return { act, name, status: args['require-app'] ? 'fail' : 'skip', reason: `no window.__app at ${url}`, url, results };
        }
        await qa.enterXR(app.page, { fov: 60, head: qa.DEFAULT_EYE, look: [0, 1.2, -1] });
        await qa.waitForState(app.page, (s) => s.calibrated !== false, { timeout: 5000, throws: false });
        if (args.easy) await qa.callApp(app.page, 'setSettings', { easyAudience: true }).catch(() => {});
        await qa.lookAt(app.page, 'mat').catch(() => {});
        const r = await playActPath(app.page, act, p, { side, shots, name });
        r.consoleErrors = [...qa.consoleErrors(app.page)];
        if (r.consoleErrors.length) {
          r.ok = false;
          r.failures.push(`console errors: ${r.consoleErrors.slice(0, 3).join(' | ')}`);
        }
        results.push(r);
        if (!r.ok) status = 'fail';
      } finally {
        await app.close();
      }
    }
  } catch (e) {
    errors.push(String(e?.message ?? e));
    status = 'error';
  } finally {
    await browser.close().catch(() => {});
  }
  const res = { act, name, title: ACTS[act].title, status, url, side, results, errors };
  qa.writeText(qa.outPath('scenarios', `${name}.md`), actMarkdown(res));
  return res;
}

export function summarize(res) {
  return {
    act: res.act,
    status: res.status,
    reason: res.reason,
    url: res.url,
    errors: res.errors,
    paths: (res.results ?? []).map((r) => ({ path: r.path, ok: r.ok, seconds: r.seconds, failures: r.failures, end: r.end })),
    report: qa.relOut(qa.outPath('scenarios', `${res.name ?? reportName(res.act)}.md`)),
  };
}

function actMarkdown(res) {
  const lines = [`# Act ${res.act} — ${res.title}: ${res.status.toUpperCase()}`, '', `URL: ${res.url} · hand: ${res.side}`, ''];
  for (const r of res.results ?? []) {
    lines.push(`## ${r.path} path: ${r.ok ? 'PASS' : 'FAIL'} (${r.seconds}s)`, '');
    if (r.failures.length) lines.push('**Failures**', '', ...r.failures.map((f) => `- ${f}`), '');
    lines.push(
      qa.mdTable(
        ['t (s)', 'beat', 'action', 'ok', 'note'],
        r.steps.map((s) => [s.t, s.kind, s.action, s.ok === true ? 'yes' : s.ok === false ? '**NO**' : '–', s.note]),
      ),
      '',
    );
    if (r.screenshots.length) lines.push('Screenshots:', '', ...r.screenshots.map((p) => `- [${path.basename(p)}](${qa.relOut(p).replace(/^scenarios\//, '')})`), '');
    lines.push(`End state: \`${JSON.stringify(r.end)}\``, '');
  }
  if (res.errors?.length) lines.push('## Errors', '', ...res.errors.map((e) => `- ${e}`), '');
  return `${lines.join('\n')}\n`;
}
