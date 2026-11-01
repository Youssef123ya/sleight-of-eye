// tests/scenarios/audio-lifecycle.mjs (owned by Q) — the REAL game's audio engine through a whole session lifecycle.
//
//   node tests/scenarios/audio-lifecycle.mjs [--url=http://127.0.0.1:8081/] [--no-shots] [--timeout=150]
//
// Drives the game at / (never a demo: demos build their own engines) in IWER and reads globalThis.__audio, the
// engine's QA view (src/audio/engine.ts AudioDebug: state is 'locked' before unlock(), else the AudioContext state):
//   1. before Enter     the game runs the real engine (window.__app.sources.createAudioEngine === 'real') and
//                       __audio.state === 'locked': no AudioContext until the player's gesture
//   2. Enter            a real click on the landing's #enter-btn (user activation; Chrome's default autoplay policy
//                       applies) → 'running', and the audio clock (AudioContext.currentTime) advances
//   3. pause (blurred)  IWER visibilityState 'visible-blurred' (system menu) → game paused → __audio.paused, the
//                       context 'suspended' within 3 s (the engine fades for 0.2 s, suspends at 0.32 s); clock stops
//   4. resume           'visible' → 'running', the clock advances again
//   5. pause (hidden)   'hidden' (headset off) → 'suspended'; 'visible' → 'running'
//   6. exit             world.exitXR() → the landing page is back and audio is 'suspended' (silent 2D page)
//   7. re-enter         a second Enter click → 'running' (the next show has sound)
// plus: the state sequence seen by an in-page 20 ms poller contains locked → running → suspended → running → …
// in that order and never 'closed'; zero console errors. Advisory only (never fails): the master-meter peak while
// running — Playwright's headless Chrome runs with --mute-audio, which silences the device, not the graph.
//
// Report: tests/out/scenarios/audio-lifecycle.json + .md, screenshots in tests/out/scenarios/audio-lifecycle/.
// Exit 0 = pass, 1 = a check failed (no window.__app or no __audio included), 2 = could not run (server down, the
// IWSDK world never started, exception).
// Also a tests/shot.mjs scenario, run WITHOUT --xr (it presses Enter itself so it can see 'locked' first):
//   node tests/shot.mjs --url=http://127.0.0.1:8081/ --scenario=tests/scenarios/audio-lifecycle.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as qa from '../lib/iwer.mjs';

const SEATED_LOOK = [0, 0.9, -0.45];
/** The key transitions, in order (the observed sequence must contain them as a subsequence). */
export const EXPECTED_STATES = ['locked', 'running', 'suspended', 'running', 'suspended', 'running', 'suspended', 'running'];

// ------------------------------------------------------------------------------------------------ in page
/**
 * __audio.state recorder on window.__qaAudio: a 20 ms poller (it sees 'locked' → the first context state) plus the
 * AudioContext's own 'statechange' event once there is a context (exact transition times). Marks label actions.
 * __audio is a read-only view that does not hand out its AudioContext, so the recorder notes every context the page
 * resumes, suspends or builds a graph on (prototype hooks: test-only, no behaviour change, undone by stop()) and
 * samples that context's clock.
 */
function installRecorder() {
  if (window.__qaAudio) return true;
  const S = { t0: performance.now(), log: [], timer: 0, hooked: null, contexts: new Set(), restore: [] };
  const hook = (start, name) => {
    let owner = start;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
    const orig = owner?.[name];
    if (typeof orig !== 'function') return;
    owner[name] = function (...a) {
      S.contexts.add(this);
      return orig.apply(this, a);
    };
    S.restore.push(() => (owner[name] = orig));
  };
  hook(window.AudioContext?.prototype, 'resume');
  hook(window.AudioContext?.prototype, 'suspend');
  hook(window.AudioContext?.prototype, 'createGain');
  /** The engine's context: the one whose state matches __audio.state (else the most recent). */
  S.context = () => {
    const st = globalThis.__audio?.state;
    let pick = null;
    for (const c of S.contexts) {
      if (!(c instanceof window.AudioContext)) continue; // an OfflineAudioContext is never the live engine's
      if (!pick || c.state === st) pick = c;
    }
    return pick;
  };
  const read = () => {
    const a = globalThis.__audio;
    let state = 'absent';
    try {
      state = a ? String(a.state) : 'absent';
      const ctx = S.context();
      if (ctx && S.hooked !== ctx) {
        S.hooked?.removeEventListener('statechange', read);
        S.hooked = ctx;
        ctx.addEventListener('statechange', read);
      }
    } catch (e) {
      state = `error: ${e?.message ?? e}`;
    }
    let last = null;
    for (let i = S.log.length - 1; i >= 0; i--) {
      if (S.log[i].state !== undefined) {
        last = S.log[i];
        break;
      }
    }
    if (!last || last.state !== state) S.log.push({ t: performance.now() - S.t0, state, paused: !!a?.paused, hidden: !!a?.hidden });
  };
  S.read = read;
  S.mark = (label) => (read(), S.log.push({ t: performance.now() - S.t0, mark: label }), true);
  S.stop = () => {
    clearInterval(S.timer);
    S.hooked?.removeEventListener('statechange', read);
    for (const undo of S.restore.splice(0)) undo();
  };
  read();
  S.timer = setInterval(read, 20);
  window.__qaAudio = S;
  return true;
}

function audioInfo() {
  const a = globalThis.__audio;
  if (!a) return { present: false };
  const ctx = window.__qaAudio?.context?.() ?? null;
  return {
    present: true,
    state: String(a.state),
    paused: !!a.paused,
    hidden: !!a.hidden,
    voices: a.voices,
    listenerOwner: a.listenerOwner,
    musicPlaying: a.musicPlaying,
    ctxState: ctx ? ctx.state : null,
    time: ctx ? ctx.currentTime : null,
  };
}

/** The engine's AudioContext.currentTime delta over `ms` of wall time (null without a context). */
async function audioClock(ms) {
  const ctx = window.__qaAudio?.context?.();
  if (!ctx) return null;
  const from = ctx.currentTime;
  const w0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  return { delta: ctx.currentTime - from, wall: (performance.now() - w0) / 1000, state: ctx.state };
}

/** Max master-meter peak / rms over `ms` (the engine's own analyser tap). */
async function meterPeak(ms) {
  const a = globalThis.__audio;
  if (!a?.meter) return null;
  const out = { peak: 0, rms: 0 };
  let peak = 0;
  let rms = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    a.meter(out);
    if (out.peak > peak) peak = out.peak;
    if (out.rms > rms) rms = out.rms;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { peak, rms };
}

function landingShown() {
  const el = document.getElementById('landing') ?? document.getElementById('landing-stub');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return !el.classList.contains('is-hidden') && cs.display !== 'none' && cs.visibility !== 'hidden' && el.getAttribute('aria-hidden') !== 'true';
}

function enterReady() {
  const b = document.getElementById('enter-btn');
  if (!b) return false;
  const r = b.getBoundingClientRect();
  return !b.disabled && b.getAttribute('aria-busy') !== 'true' && r.width > 0 && r.height > 0;
}

async function exitXR() {
  const w = window.FRAMEWORK_MCP_RUNTIME?.world;
  try {
    if (typeof w?.exitXR === 'function') await w.exitXR();
    else await window.IWER_DEVICE?.activeSession?.end();
    return 'ok';
  } catch (e) {
    return String(e?.message ?? e);
  }
}

// ------------------------------------------------------------------------------------------------ the check
/**
 * Run the lifecycle on a page showing the game at / that has NOT entered XR yet (open it with tests/lib/iwer.mjs
 * openApp so console errors are collected). Never throws: returns { ok, checks, advisories, timeline, states, ... }.
 */
export async function checkAudioLifecycle(page, { shotsDir = null, log = () => {} } = {}) {
  const t0 = Date.now();
  const checks = [];
  const advisories = [];
  const timeline = [];
  const latencies = {};
  const shots = [];
  const note = (msg, extra) => {
    const e = { t: +((Date.now() - t0) / 1000).toFixed(1), msg, ...(extra !== undefined && extra !== '' ? { extra } : {}) };
    timeline.push(e);
    log(e);
  };
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok, detail: String(detail ?? '') });
    note(`${ok ? 'pass' : 'FAIL'}: ${name}`, detail);
    return !!ok;
  };
  const advise = (msg) => (advisories.push(msg), note(`advisory: ${msg}`));
  const ev = (fn, arg, label, ms = 15_000) => qa.withTimeout(page.evaluate(fn, arg), ms, label);
  const info = () => ev(audioInfo, undefined, '__audio');
  const mark = (label) => ev((l) => window.__qaAudio?.mark(l) ?? false, label, 'mark');
  const shot = async (name) => {
    if (!shotsDir) return;
    try {
      shots.push(await qa.screenshot(page, path.join(shotsDir, `${name}.png`)));
    } catch {
      /* evidence only */
    }
  };
  /** Poll __audio until pred(info) (50 ms), else null. */
  const waitAudio = async (pred, ms) => {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < ms) {
      last = await info().catch(() => null);
      if (last && pred(last)) return last;
      await qa.sleep(50);
    }
    return null;
  };
  /** Latency (s) from the last mark `label` to the first logged `state` after it, from the in-page log. */
  const latency = async (label, state) => {
    // sample once more first: the Node-side poll can see a new state before the in-page recorder logged it
    const L = await ev(() => (window.__qaAudio?.read?.(), window.__qaAudio?.log ?? []), undefined, 'recorder log').catch(() => []);
    let m = -1;
    for (let i = L.length - 1; i >= 0; i--) {
      if (L[i].mark === label) {
        m = i;
        break;
      }
    }
    if (m < 0) return null;
    for (let i = m + 1; i < L.length; i++) if (L[i].state === state) return +((L[i].t - L[m].t) / 1000).toFixed(3);
    // already in that state when the mark was set
    for (let i = m - 1; i >= 0; i--) if (L[i].state !== undefined) return L[i].state === state ? 0 : null;
    return null;
  };
  const lat = (v) => (v === null || v === undefined ? '' : ` (${Math.round(v * 1000)} ms after the action)`);
  const clockRuns = async (label) => {
    const c = await ev(audioClock, 400, 'audio clock').catch(() => null);
    return check(label, !!c && c.delta > 0.2, c ? `currentTime +${c.delta.toFixed(3)} s in ${c.wall.toFixed(2)} s wall, context ${c.state}` : 'no AudioContext');
  };
  const clockStopped = async (label) => {
    const c = await ev(audioClock, 400, 'audio clock').catch(() => null);
    return check(label, !!c && Math.abs(c.delta) < 0.02, c ? `currentTime +${c.delta.toFixed(3)} s in ${c.wall.toFixed(2)} s wall, context ${c.state}` : 'no AudioContext');
  };
  const enter = async (label) => {
    const ready = await page
      .waitForFunction(enterReady, null, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!check(`${label}: the landing's Enter button is ready`, ready, ready ? '#enter-btn enabled' : '#enter-btn missing, disabled or busy after 20 s')) return false;
    await mark(label);
    const xr = await qa.enterXR(page, { fov: 60, head: qa.DEFAULT_EYE, look: SEATED_LOOK, enterSelector: '#enter-btn' }).catch((e) => ({ error: String(e?.message ?? e) }));
    return check(`${label}: XR session started by clicking Enter (user activation)`, !!xr.xrActive && String(xr.via).startsWith('button'), xr.error ?? `via ${xr.via}, ${xr.device}, IWER ${xr.iwer}`);
  };
  const pauseResume = async (vis) => {
    // pause
    await mark(`pause:${vis}`);
    await qa.setVisibility(page, vis);
    const p = await qa.waitForState(page, (s) => s.paused === true, { timeout: 3000, throws: false });
    check(`${vis} → the game pauses`, !!p, p ? `debugState.paused, curtain closing` : 'debugState().paused never became true');
    const s = await waitAudio((a) => a.paused && a.state === 'suspended', 3000);
    const l1 = await latency(`pause:${vis}`, 'suspended');
    latencies[`pause:${vis} → suspended`] = l1;
    check(`${vis} → audio suspended`, !!s, s ? `__audio.paused, context ${s.ctxState}${lat(l1)}` : `still ${JSON.stringify(await info().catch(() => null))}`);
    await clockStopped(`${vis}: the audio clock stops (no audio thread work while paused)`);
    if (vis === 'visible-blurred') await shot('paused-blurred');
    // resume
    await mark(`resume:${vis}`);
    await qa.setVisibility(page, 'visible');
    const r = await qa.waitForState(page, (st) => st.paused === false, { timeout: 3000, throws: false });
    check(`visible after ${vis} → the game resumes`, !!r, r ? 'debugState.paused false' : 'still paused');
    const run = await waitAudio((a) => !a.paused && a.state === 'running', 3000);
    const l2 = await latency(`resume:${vis}`, 'running');
    latencies[`resume after ${vis} → running`] = l2;
    check(`visible after ${vis} → audio running again`, !!run, run ? `context ${run.ctxState}${lat(l2)}` : `still ${JSON.stringify(await info().catch(() => null))}`);
    await clockRuns(`after ${vis}: the audio clock advances again`);
  };

  let fatal = null;
  let completed = false;
  try {
    // ---------------------------------------------------------------------------------------- 1. before Enter
    const booted = await qa.hasApp(page, { timeout: 30_000 });
    check('the game booted (window.__app)', booted, booted ? page.url() : `no window.__app at ${page.url()} after 30 s`);
    if (!booted) throw new qa.QAError('the game did not boot');
    const sources = await ev(() => window.__app?.sources ?? null, undefined, 'sources').catch(() => null);
    check('the game runs the real audio engine, not the silent stub', sources?.createAudioEngine === 'real', `sources.createAudioEngine = ${sources?.createAudioEngine ?? 'unknown'}`);
    await ev(installRecorder, undefined, 'install recorder');
    const a0 = await info();
    if (!check('globalThis.__audio is exposed (src/audio/engine.ts QA view)', a0.present, a0.present ? `state ${a0.state}` : 'missing')) throw new qa.QAError('no globalThis.__audio');
    const already = await ev(() => !!window.IWER_DEVICE?.activeSession, undefined, 'xr active');
    if (already) check("'locked' before Enter", false, 'XR was already active when the check started (run it without tests/shot.mjs --xr)');
    else check("'locked' before Enter: the engine waits for the player's gesture", a0.state === 'locked', `state ${a0.state}, paused ${a0.paused}`);

    // ---------------------------------------------------------------------------------------- 2. Enter
    if (!already && !(await enter('enter'))) throw new qa.QAError('could not enter XR from the landing page');
    const run1 = await waitAudio((a) => a.state === 'running', 6000);
    const l0 = await latency('enter', 'running');
    latencies['Enter → running'] = l0;
    check('Enter → audio running', !!run1, run1 ? `context ${run1.ctxState}, listener ${run1.listenerOwner}${lat(l0)}` : `still ${JSON.stringify(await info().catch(() => null))}`);
    await clockRuns('running: the audio clock advances');
    const st = await qa.waitForState(page, (s) => s.immersive === true && s.calibrated === true, { timeout: 8000, throws: false });
    check('immersive and calibrated (the show is on)', !!st, st ? `act ${st.act}, beat ${st.beat} ${st.beatKind}, phase ${st.phase}` : 'not immersive + calibrated after 8 s');
    const m = await ev(meterPeak, 2500, 'meter', 20_000).catch(() => null);
    const music = (await info().catch(() => null))?.musicPlaying;
    if (!m) advise('no master meter reading');
    else if (m.peak > 1e-4) note('master meter while running', `peak ${m.peak.toFixed(4)}, rms ${m.rms.toFixed(4)}, café trio playing ${music}`);
    else advise(`master meter silent while running (peak ${m.peak.toExponential(1)}, café trio playing ${music}): sound content is the audio module's offline verifier's job`);

    // ---------------------------------------------------------------------------------------- 3-5. pause / resume
    await pauseResume('visible-blurred');
    await pauseResume('hidden');

    // ---------------------------------------------------------------------------------------- 6. exit
    await mark('exit');
    const ex = await ev(exitXR, undefined, 'exitXR', 10_000).catch((e) => String(e?.message ?? e));
    const out = await qa.waitForState(page, (s) => s.immersive === false, { timeout: 6000, throws: false });
    const shown = await ev(landingShown, undefined, 'landing').catch(() => null);
    check('exitXR → back on the landing page', !!out && shown !== false, `exitXR ${ex}; immersive ${out ? 'false' : 'still true'}; landing shown ${shown}`);
    const s3 = await waitAudio((a) => a.state === 'suspended', 3000);
    const l3 = await latency('exit', 'suspended');
    latencies['exit → suspended'] = l3;
    check('leaving XR suspends audio (silent 2D page)', !!s3, s3 ? `context ${s3.ctxState}${lat(l3)}` : `still ${JSON.stringify(await info().catch(() => null))}`);
    await shot('after-exit');

    // ---------------------------------------------------------------------------------------- 7. re-enter
    if (await enter('re-enter')) {
      const run3 = await waitAudio((a) => !a.paused && a.state === 'running', 6000);
      const l4 = await latency('re-enter', 'running');
      latencies['re-enter → running'] = l4;
      check('second Enter → audio running (the next show has sound)', !!run3, run3 ? `context ${run3.ctxState}${lat(l4)}` : `still ${JSON.stringify(await info().catch(() => null))}`);
      await clockRuns('re-entered: the audio clock advances');
      await shot('re-entered');
    }
    completed = true;
  } catch (e) {
    fatal = e instanceof qa.QAError ? null : String(e?.stack ?? e);
    if (fatal) note('exception', fatal);
  }

  // ------------------------------------------------------------------------------------------ the sequence
  const rawLog = await ev(() => (window.__qaAudio?.read?.(), window.__qaAudio?.stop?.(), window.__qaAudio?.log ?? []), undefined, 'recorder log').catch(() => []);
  const states = [];
  for (const e of rawLog) if (e.state !== undefined && states[states.length - 1] !== e.state) states.push(e.state);
  if (completed && rawLog.length) {
    // (an aborted run already reported its root cause; the partial sequence is still in the report)
    let k = 0;
    for (const s of states) if (k < EXPECTED_STATES.length && s === EXPECTED_STATES[k]) k++;
    const reached = checks.some((c) => c.name.startsWith('second Enter')) ? EXPECTED_STATES.length : EXPECTED_STATES.length - 1;
    check('state sequence: locked → running → (suspended → running) ×2 → suspended → running', k >= reached, `observed ${states.join(' → ')}`);
    check("the context is never 'closed'", !states.includes('closed') && !states.some((s) => s.startsWith('error')), states.join(' → '));
  }
  const errors = [...qa.consoleErrors(page)];
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const ok = !fatal && checks.length > 0 && checks.every((c) => c.ok);
  note(ok ? 'PASSED' : `FAILED (${checks.filter((c) => !c.ok).length} checks${fatal ? ', exception' : ''})`);
  return { ok, fatal, checks, advisories, latencies, states, log: rawLog.slice(0, 400), timeline, errors, warnings: [...qa.consoleWarnings(page)].slice(0, 20), screenshots: shots, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
}

/** tests/shot.mjs scenario entry (run shot.mjs WITHOUT --xr). */
export default async function audioLifecycle(page) {
  const r = await checkAudioLifecycle(page, { shotsDir: qa.outPath('scenarios', 'audio-lifecycle'), log: (e) => console.error(`[audio-lifecycle ${e.t}s] ${e.msg}${e.extra ? ` ${e.extra}` : ''}`) });
  return { pass: r.ok, failures: r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`), states: r.states, latencies: r.latencies, advisories: r.advisories, timeline: r.timeline };
}

// ------------------------------------------------------------------------------------------------ CLI
function markdown(r) {
  const L = [`# Audio lifecycle: ${r.ok ? 'PASS' : r.fatal ? 'ERROR' : 'FAIL'}`, '', `URL: ${r.url} · ${r.seconds ?? '?'} s`, ''];
  if (r.fatal) L.push('## Fatal', '', '```', r.fatal, '```', '');
  if (r.states?.length) L.push(`States seen (20 ms poller): **${r.states.join(' → ')}**`, '');
  L.push(qa.mdTable(['check', 'ok', 'detail'], (r.checks ?? []).map((c) => [c.name, c.ok ? 'yes' : '**NO**', c.detail])), '');
  const lat = Object.entries(r.latencies ?? {});
  if (lat.length) L.push('## Transition latency', '', qa.mdTable(['transition', 'seconds'], lat.map(([k, v]) => [k, v ?? '–'])), '');
  if (r.advisories?.length) L.push('## Advisory', '', ...r.advisories.map((a) => `- ${a}`), '');
  if (r.screenshots?.length) L.push('## Screenshots', '', ...r.screenshots.map((p) => `- [${path.basename(p)}](${qa.relOut(p).replace(/^scenarios\//, '')})`), '');
  if (r.errors?.length) L.push('## Console errors', '', ...r.errors.slice(0, 10).map((e) => `- \`${e.slice(0, 300)}\``), '');
  return `${L.join('\n')}\n`;
}

async function cli() {
  const args = qa.parseArgs();
  qa.installWatchdog(Number(args.timeout ?? 150) * 1000, 'audio-lifecycle');
  // always the game itself: drop ?demo= from --url
  const url = qa.appUrl(qa.baseUrl(args), { demo: null });
  const shotsDir = args.shots === false ? null : qa.outPath('scenarios', 'audio-lifecycle');
  let res;
  let app = null;
  try {
    app = await qa.openApp(url, { w: 1280, h: 720 });
    res = await checkAudioLifecycle(app.page, { shotsDir, log: (e) => console.error(`[audio-lifecycle ${e.t}s] ${e.msg}${e.extra ? ` ${e.extra}` : ''}`) });
  } catch (e) {
    res = { ok: false, fatal: String(e?.stack ?? e), checks: [], errors: app ? [...qa.consoleErrors(app.page)] : [] };
  } finally {
    await app?.close();
  }
  res.url = url;
  qa.writeJson(qa.outPath('scenarios', 'audio-lifecycle.json'), res);
  qa.writeText(qa.outPath('scenarios', 'audio-lifecycle.md'), markdown(res));
  console.log(
    JSON.stringify(
      {
        ok: res.ok,
        url,
        states: res.states,
        failures: (res.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
        latencies: res.latencies,
        advisories: res.advisories,
        fatal: res.fatal ?? undefined,
        report: 'tests/out/scenarios/audio-lifecycle.md',
      },
      null,
      2,
    ),
  );
  process.exit(res.fatal ? 2 : res.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();
