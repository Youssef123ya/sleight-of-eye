// tests/run-all.mjs — the one-command QA regression (owned by Q).
//
//   node tests/run-all.mjs [--url=http://127.0.0.1:8081/]
//        [--only=boot,demos,audio,acts,core,fov,perf]   groups to run (default: all seven; alias scenarios = audio,acts,core)
//        [--with=selftest,overlay]                       opt-in QA-tooling self-tests (added to the groups above)
//        [--demos=core,debug] [--acts=1,3] [--paths=success,catch] [--core=act1,show] [--core-on=game|stub|game,stub]
//        [--step-timeout=<s>] [--timeout=<s>] [--bail] [--list]
//
// Every step is a child process (`node <script> …`) with a hard timeout; on timeout its whole process tree (node +
// headless Chrome) is killed (taskkill /T /F on Windows, SIGKILL elsewhere). Steps run one at a time: the dev server
// is shared, and perf + timing-sensitive scenarios must not compete for the CPU.
//   boot      tests/scenarios/boot.mjs — the game at / boots: window.__app, every module real, Enter ready, 0 errors
//   selftest  (opt-in) the QA tooling on its fixture (?demo=debug, mock window.__app): debug overlay + Act 1 driver
//   demos     tests/shot.mjs --xr per src/demos/<name>.demo.ts (seated eye, looking at the stage) →
//             tests/out/demos/<name>.png; FAIL on page/console errors or when the XR session did not start
//   audio     tests/scenarios/audio-lifecycle.mjs — locked → running (Enter) → suspended (pause) → running (resume) …
//   acts      tests/scenarios/act1..3.mjs --require-app — success + catch paths (tests/lib/acts.mjs)
//   core      tests/shot.mjs --xr --scenario=tests/scenarios/core-<name>.mjs for every core-*.mjs except core-lib.mjs,
//             on the game (/); --core-on=stub runs them on ?demo=core (stub services), --core-on=game,stub on both.
//             A scenario whose header comment says "WITHOUT --xr" (it checks the 2D page, then enters XR itself, e.g.
//             core-attract) is launched without --xr.
//   fov       tests/fov.mjs — Quest 3 + Meta VR Glasses frustum checks per act
//   perf      tests/perf.mjs — ≤ 70 draws/view, ≤ 300k triangles, ≤ 20 programs; allocation by owner
//   overlay   (opt-in) the ?debug=1 overlay inside the game
// Output: tests/out/summary.md + tests/out/summary.json, the full output of every step in tests/out/run-all/<id>.log.
// Exit 0 = every step passed · 1 = a step failed or timed out · 2 = could not start (dev server unreachable, bad
// arguments) · 3 = the whole run hit --timeout (default 3600 s; the summary is still written). --list prints the
// plan (commands + timeouts) and runs nothing.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as qa from './lib/iwer.mjs';

const args = qa.parseArgs();
const base = qa.baseUrl(args);
const T0 = Date.now();
const STARTED_AT = new Date().toISOString();
const GROUPS = ['boot', 'demos', 'audio', 'acts', 'core', 'fov', 'perf'];
const EXTRAS = ['selftest', 'overlay'];
const ORDER = ['boot', 'selftest', 'demos', 'audio', 'acts', 'core', 'fov', 'perf', 'overlay'];
const ALIASES = { scenarios: ['audio', 'acts', 'core'], all: [...GROUPS, ...EXTRAS] };
const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const expand = (names) => names.flatMap((n) => ALIASES[n] ?? [n]);
const TIMEOUT_S = Number(args.timeout ?? 3600);
const STEP_TIMEOUT_S = args['step-timeout'] !== undefined ? Number(args['step-timeout']) : null;
const DEADLINE = T0 + TIMEOUT_S * 1000;
const SEATED = ['--head=0,1.2,0'];

const usage = [];
const groups = new Set(args.only ? expand(csv(args.only)) : GROUPS);
for (const g of expand(csv(args.with))) groups.add(g);
for (const g of groups) if (!ORDER.includes(g)) usage.push(`unknown group "${g}" (groups: ${ORDER.join(', ')}; alias: scenarios)`);
if (!Number.isFinite(TIMEOUT_S) || TIMEOUT_S <= 0) usage.push(`--timeout must be a positive number of seconds`);
if (STEP_TIMEOUT_S !== null && !(STEP_TIMEOUT_S > 0)) usage.push(`--step-timeout must be a positive number of seconds`);
const FILTERS = ['only', 'with', 'demos', 'acts', 'paths', 'core', 'core-on'].filter((k) => args[k] !== undefined);
const SCOPE = FILTERS.length ? `partial: ${FILTERS.map((k) => `--${k}=${args[k]}`).join(' ')}` : `full (${GROUPS.join(', ')})`;

// ------------------------------------------------------------------------------------------------ the plan
const plan = [];
const add = (step) => plan.push({ ...step, timeoutS: STEP_TIMEOUT_S ?? step.timeoutS });
const invalid = (id, group, name, why) => plan.push({ id, group, name, invalid: why, timeoutS: 0 });

function buildPlan() {
  const byGroup = {
    boot() {
      add({ id: 'boot', group: 'boot', name: 'game boots to the landing page', script: 'tests/scenarios/boot.mjs', args: [`--url=${base}`, '--timeout=90'], timeoutS: 120, json: 'scenarios/boot.json', evaluate: evalBoot });
    },
    selftest() {
      add({ id: 'selftest-overlay', group: 'selftest', name: 'selftest: debug overlay on the QA fixture', script: 'tests/overlay.mjs', args: [`--url=${base}`, '--demo=debug', '--timeout=150'], timeoutS: 180, json: 'overlay-debug.json', evaluate: evalOverlay });
      add({ id: 'selftest-act1', group: 'selftest', name: 'selftest: Act 1 driver on the QA fixture (mock)', script: 'tests/scenarios/act1.mjs', args: [`--url=${base}`, '--demo=debug', '--require-app', '--tag=fixture', '--timeout=240'], timeoutS: 270, json: 'scenarios/act1-fixture.json', report: 'scenarios/act1-fixture.md', evaluate: evalAct });
    },
    demos() {
      const all = qa.listDemos();
      for (const d of args.demos ? csv(args.demos) : all) {
        if (!all.includes(d)) {
          invalid(`demo-${d}`, 'demos', `demo ${d}`, `no src/demos/${d}.demo.ts (demos: ${all.join(', ')})`);
          continue;
        }
        add({ id: `demo-${d}`, group: 'demos', name: `demo ${d}`, script: 'tests/shot.mjs', args: [`--url=${qa.appUrl(base, { demo: d })}`, '--xr', ...SEATED, '--look=0,0.9,-0.6', `--out=tests/out/demos/${d}.png`], timeoutS: 120, shotJson: true });
      }
    },
    audio() {
      add({ id: 'audio-lifecycle', group: 'audio', name: 'audio lifecycle (real engine)', script: 'tests/scenarios/audio-lifecycle.mjs', args: [`--url=${base}`, '--timeout=150'], timeoutS: 180, json: 'scenarios/audio-lifecycle.json', report: 'scenarios/audio-lifecycle.md', evaluate: evalAudio });
    },
    acts() {
      const paths = args.paths ? csv(args.paths).join(',') : 'success,catch';
      for (const a of args.acts ? csv(args.acts) : ['1', '2', '3']) {
        if (!['1', '2', '3'].includes(a)) {
          invalid(`act${a}`, 'acts', `act ${a}`, 'acts are 1, 2 and 3');
          continue;
        }
        add({ id: `act${a}`, group: 'acts', name: `act ${a} (${paths})`, script: `tests/scenarios/act${a}.mjs`, args: [`--url=${base}`, '--require-app', `--paths=${paths}`, '--timeout=420'], timeoutS: 480, json: `scenarios/act${a}.json`, report: `scenarios/act${a}.md`, evaluate: evalAct });
      }
    },
    core() {
      const dir = path.join(qa.APP_DIR, 'tests', 'scenarios');
      const all = readdirSync(dir)
        .filter((f) => /^core-.+\.mjs$/.test(f) && f !== 'core-lib.mjs')
        .map((f) => f.slice(5, -4))
        .sort();
      const targets = args['core-on'] ? csv(args['core-on']) : ['game'];
      for (const t of targets) if (t !== 'game' && t !== 'stub') usage.push(`--core-on takes game, stub or game,stub (got "${t}")`);
      // A scenario whose leading comment says "WITHOUT --xr" checks the 2D page first and enters XR itself
      // (e.g. core-attract): launch it without --xr.
      const header = (name) => {
        try {
          const lines = readFileSync(path.join(dir, `core-${name}.mjs`), 'utf8').split(/\r?\n/);
          const end = lines.findIndex((l) => !l.startsWith('//'));
          return lines.slice(0, end < 0 ? lines.length : end).join('\n');
        } catch {
          return '';
        }
      };
      for (const name of args.core ? csv(args.core) : all) {
        const xr = !/without\s+--xr/i.test(header(name));
        for (const target of targets.filter((t) => t === 'game' || t === 'stub')) {
          const id = `core-${name}${target === 'stub' ? '-stub' : ''}`;
          const label = `core ${name}${target === 'stub' ? ' (?demo=core stubs)' : ''}${xr ? '' : ' (2D start)'}`;
          if (!all.includes(name)) {
            invalid(id, 'core', label, `no tests/scenarios/core-${name}.mjs (core scenarios: ${all.join(', ')})`);
            continue;
          }
          const url = target === 'stub' ? qa.appUrl(base, { demo: 'core' }) : qa.appUrl(base, { demo: null });
          add({
            id,
            group: 'core',
            name: label,
            script: 'tests/shot.mjs',
            args: [`--url=${url}`, ...(xr ? ['--xr', ...SEATED, '--look=0,0.9,-0.45'] : []), `--scenario=tests/scenarios/core-${name}.mjs`, `--out=tests/out/core/${target}/${name}.png`, '--wait=500'],
            timeoutS: name === 'show' ? 600 : 300,
            shotJson: true,
            scenario: true,
            saveAs: `core/${target}/${name}.json`,
          });
        }
      }
    },
    fov() {
      add({ id: 'fov', group: 'fov', name: 'fov (Quest 3 + Meta VR Glasses)', script: 'tests/fov.mjs', args: [`--url=${base}`, '--timeout=270'], timeoutS: 300, json: 'fov.json', report: 'fov-report.md', evaluate: evalFov });
    },
    perf() {
      add({ id: 'perf', group: 'perf', name: 'perf budgets', script: 'tests/perf.mjs', args: [`--url=${base}`, '--timeout=270'], timeoutS: 300, json: 'perf.json', report: 'perf-report.md', evaluate: evalPerf });
    },
    overlay() {
      add({ id: 'overlay', group: 'overlay', name: 'debug overlay in the game (?debug=1)', script: 'tests/overlay.mjs', args: [`--url=${base}`, '--timeout=150'], timeoutS: 180, json: 'overlay.json', evaluate: evalOverlay });
    },
  };
  for (const g of ORDER) if (groups.has(g)) byGroup[g]();
}

// ------------------------------------------------------------------------------------------------ evaluators
// Each turns a step's JSON report into { ok, details, data }.
const first = (v) => String(v ?? '').split('\n')[0];
const failedChecks = (j) => (j?.checks ?? []).filter((c) => !c.ok);
function evalBoot(j) {
  const bad = failedChecks(j);
  if (j.ok) return { ok: true, details: `__app ${j.timings?.app}s, Enter ready ${j.timings?.enterReady}s, modules: ${Object.keys(j.sources ?? {}).length} real`, data: { timings: j.timings, sources: j.sources } };
  return { ok: false, details: j.fatal ? first(j.fatal) : `${bad[0]?.name}: ${bad[0]?.detail}`, data: { timings: j.timings, sources: j.sources } };
}
function evalAudio(j) {
  const L = j.latencies ?? {};
  const ms = (k) => (typeof L[k] === 'number' ? `${Math.round(L[k] * 1000)} ms` : '?');
  if (j.ok)
    return {
      ok: true,
      details: `${(j.states ?? []).join(' → ')}; pause→suspended ${ms('pause:visible-blurred → suspended')}, resume→running ${ms('resume after visible-blurred → running')}${j.advisories?.length ? ` (advisory: ${j.advisories[0]})` : ''}`,
      data: { states: j.states, latencies: j.latencies },
    };
  const bad = failedChecks(j);
  return { ok: false, details: j.fatal ? first(j.fatal) : `${bad.length} failed — ${bad[0]?.name}: ${bad[0]?.detail}`, data: { states: j.states, latencies: j.latencies } };
}
function evalAct(j) {
  const paths = (j.results ?? []).map((x) => `${x.path} ${x.ok ? 'ok' : `FAILED (${x.failures[0] ?? '?'})`}`);
  const details = paths.join(', ') || j.reason || j.error || j.errors?.[0] || j.status;
  return { ok: j.status === 'pass', details, data: { status: j.status, paths: (j.results ?? []).map((x) => ({ path: x.path, ok: x.ok, seconds: x.seconds, failures: x.failures })) } };
}
function evalFov(j) {
  if (j.ok) return { ok: true, details: `${j.acts?.length ?? 0} act(s): every required object in view${j.warnings?.length ? ` (${j.warnings.length} advisory)` : ''}`, data: { failures: [], warnings: j.warnings?.length ?? 0 } };
  return { ok: false, details: `${j.failures?.length ?? 0} out of view — ${first(j.failures?.[0] ?? j.fatal ?? 'failed')}`, data: { failures: j.failures } };
}
function evalPerf(j) {
  const w = j.worst;
  const nums = w ? `${Math.round(w.drawCallsPerView)} draws/view, ${Math.round(w.trianglesPerView / 1000)}k tris/view, ${w.programs} programs, app alloc ${qa.fmt(w.appAllocKBPerFrame, 2)} KB/frame` : '';
  if (j.ok) return { ok: true, details: nums, data: { worst: w } };
  return { ok: false, details: `${j.failures?.[0] ?? first(j.fatal ?? 'failed')}${nums ? ` — ${nums}` : ''}`, data: { worst: w, failures: j.failures } };
}
function evalOverlay(j) {
  if (j.ok) return { ok: true, details: `${j.checks?.length ?? 0} checks`, data: null };
  const bad = failedChecks(j);
  return { ok: false, details: j.fatal ? first(j.fatal) : `${bad[0]?.name}: ${bad[0]?.detail}`, data: null };
}
/** tests/shot.mjs output (demo screenshot or core scenario). */
function evalShot(step, j) {
  if (!j) return { ok: false, details: 'tests/shot.mjs printed no JSON' };
  const stats = j.stats ?? {};
  const data = { stats: stats.fps !== undefined ? { fps: stats.fps, drawCalls: stats.drawCalls, triangles: stats.triangles, programs: stats.programs, xrActive: stats.xrActive } : null, warnings: j.warnings?.length ?? 0 };
  if (j.fatal) return { ok: false, details: first(j.fatal), data };
  if (j.errors?.length) return { ok: false, details: `${j.errors.length} console error(s): ${first(j.errors[0]).slice(0, 220)}`, data };
  // (core-save / core-show end on the landing page by design: only a demo screenshot must still be in XR)
  if (!step.scenario && !stats.xrActive) return { ok: false, details: 'the XR session was not active at the end (enterXR failed or the page left XR)', data };
  if (step.scenario) {
    const sc = j.scenario;
    data.failures = sc?.failures ?? null;
    if (!sc) return { ok: false, details: 'the scenario returned nothing', data };
    const passes = (sc.timeline ?? []).filter((e) => /^pass:/.test(e.msg)).length;
    if (sc.pass !== true) return { ok: false, details: `${sc.failures?.length ?? '?'} failed — ${first(sc.failures?.[0] ?? 'no failure text')}`, data };
    return { ok: true, details: `${passes} checks passed`, data };
  }
  // IWER renders each view separately (no multiview): the Quest's single-pass cost is about half the raw count
  const views = 2;
  return { ok: true, details: `≈${Math.round(stats.drawCalls / views)} draws/view, ≈${Math.round(stats.triangles / views / 1000)}k tris/view, ${stats.programs} programs, ${stats.fps} fps`, data };
}

// ------------------------------------------------------------------------------------------------ processes
let active = null;

function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    else child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

const cap = (s, n) => (s.length > n ? `[… ${s.length - n} chars cut …]\n${s.slice(-n)}` : s);

/** Run `node <script> <args>` from the app dir: { code, stdout, stderr, timedOut, seconds }. Never rejects. */
function runNode(script, scriptArgs, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    let grace = null;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      active = null;
      resolve({ code, stdout, stderr, timedOut, pid: child.pid, seconds: (Date.now() - started) / 1000 });
    };
    const child = spawn(process.execPath, [path.join(qa.APP_DIR, script), ...scriptArgs], {
      cwd: qa.APP_DIR,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    active = child;
    child.stdout.on('data', (d) => (stdout = cap(stdout + d, 2_000_000)));
    child.stderr.on('data', (d) => (stderr = cap(stderr + d, 500_000)));
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      grace = setTimeout(() => done(null), 10_000); // pipes held open by a straggler must not hang the run
    }, Math.max(1000, timeoutMs));
    child.on('close', (code) => done(code));
    child.on('error', (e) => {
      stderr += `\n[run-all] spawn failed: ${e.message}`;
      done(-1);
    });
  });
}

/** The last top-level JSON value printed on stdout (tests/shot.mjs prints exactly one). */
function lastJson(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** A report file written by THIS run of the step (a stale one from an earlier run never counts). */
function freshJson(rel, since) {
  const p = path.join(qa.OUT_DIR, rel);
  try {
    if (!existsSync(p) || statSync(p).mtimeMs < since - 1500) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const quote = (a) => (/[\s?&"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const commandOf = (s) => (s.script ? `node ${[s.script, ...s.args].map(quote).join(' ')}` : '');
const tail = (text, n = 3) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ');

// ------------------------------------------------------------------------------------------------ results
const results = [];
function record(step, status, details, extra = {}) {
  const r = { id: step.id, group: step.group, name: step.name, status, details: String(details ?? ''), ...extra };
  results.push(r);
  const n = `${results.length}/${plan.length}`;
  console.error(`[run-all] ${n.padStart(5)} ${status.padEnd(4)} ${step.name}${r.seconds !== undefined ? ` (${Math.round(r.seconds)}s)` : ''}${r.details ? ` — ${r.details}` : ''}`);
  return r;
}

async function runStep(step) {
  if (step.invalid) return record(step, 'FAIL', step.invalid, { seconds: 0 });
  const remaining = DEADLINE - Date.now();
  const timeoutMs = Math.min(step.timeoutS * 1000, remaining);
  const started = Date.now();
  const r = await runNode(step.script, step.args, timeoutMs);
  const log = qa.outPath('run-all', `${step.id}.log`);
  qa.writeText(
    log,
    `$ ${commandOf(step)}\n# cwd ${qa.APP_DIR}\n# pid ${r.pid} · exit ${r.code} · ${r.seconds.toFixed(1)} s${r.timedOut ? ` · process tree KILLED after the ${Math.round(timeoutMs / 1000)} s timeout` : ''}\n\n## stdout\n${r.stdout}\n\n## stderr\n${r.stderr}\n`,
  );
  const info = { seconds: r.seconds, exitCode: r.code, timedOut: r.timedOut, command: commandOf(step), log: qa.relOut(log), report: step.report ?? step.json ?? null };
  if (r.timedOut) {
    const why = remaining <= step.timeoutS * 1000 ? 'the run-all --timeout' : `its ${step.timeoutS} s timeout`;
    return record(step, 'FAIL', `timed out: killed after ${Math.round(timeoutMs / 1000)} s (${why}); last output: ${tail(r.stderr || r.stdout, 2).slice(0, 200)}`, info);
  }
  let ev;
  let errors;
  if (step.shotJson) {
    const j = lastJson(r.stdout);
    ev = evalShot(step, j);
    errors = j?.errors ?? [];
    if (j?.out) info.shot = qa.relOut(j.out);
    if (step.saveAs && j) {
      info.report = step.saveAs;
      qa.writeJson(path.join(qa.OUT_DIR, step.saveAs), { command: commandOf(step), exitCode: r.code, ...j });
    }
  } else {
    const j = freshJson(step.json, started);
    ev = j ? step.evaluate(j) : { ok: false, details: `no fresh ${step.json} (exit ${r.code}): ${tail(r.stderr || r.stdout).slice(0, 240)}` };
    // console errors: per path for the act driver (its top-level `errors` are runner exceptions), else top level
    errors = step.evaluate === evalAct ? (j?.results ?? []).flatMap((x) => x.consoleErrors ?? []) : Array.isArray(j?.errors) ? j.errors : [];
    if (j?.screenshot) info.shot = qa.relOut(j.screenshot);
  }
  let ok = ev.ok;
  let details = ev.details;
  if (ok && r.code !== 0) {
    ok = false;
    details = `exit code ${r.code} although the report passed — ${tail(r.stderr || r.stdout, 2).slice(0, 200)}`;
  }
  return record(step, ok ? 'PASS' : 'FAIL', details, { ...info, errors: (errors ?? []).slice(0, 12), data: ev.data ?? null });
}

// ------------------------------------------------------------------------------------------------ summary
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  const seconds = Math.round((Date.now() - T0) / 1000);
  const counts = results.reduce((m, s) => ((m[s.status] = (m[s.status] ?? 0) + 1), m), {});
  const failed = results.filter((s) => s.status === 'FAIL');
  const verdict = failed.length ? 'FAIL' : results.length ? 'PASS' : 'EMPTY';
  const exitCode = code ?? (failed.length ? 1 : 0);
  const dur = (s) => (s === undefined ? '' : s >= 90 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);
  const link = (label, rel) => (rel ? `[${label}](${rel.split(path.sep).join('/')})` : '');
  const md = [
    `# QA regression: ${verdict}`,
    '',
    `${STARTED_AT} · ${base} · ${dur(seconds)} · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'no steps'} · exit ${exitCode}`,
    '',
    `Scope: ${SCOPE}. Command: \`node tests/run-all.mjs${process.argv.slice(2).length ? ` ${process.argv.slice(2).join(' ')}` : ''}\``,
    '',
    qa.mdTable(
      ['#', 'step', 'status', 'time', 'details', 'evidence'],
      results.map((s, i) => [
        i + 1,
        s.name,
        s.status === 'FAIL' ? '**FAIL**' : s.status,
        dur(s.seconds),
        s.details,
        [link('png', s.shot), link('report', s.report), link('log', s.log)].filter(Boolean).join(' '),
      ]),
    ),
    '',
  ];
  if (failed.length) {
    md.push('## Failures', '');
    for (const s of failed) {
      md.push(`### ${s.name}`, '', `- ${s.details}`);
      if (s.command) md.push(`- re-run: \`${s.command}\``);
      if (s.data?.failures?.length) md.push(...s.data.failures.slice(0, 6).map((f) => `- ${typeof f === 'string' ? f : JSON.stringify(f)}`));
      if (s.data?.paths) for (const p of s.data.paths) if (!p.ok) md.push(...p.failures.slice(0, 6).map((f) => `- ${p.path}: ${f}`));
      md.push('');
    }
  }
  const withErrors = results.filter((s) => s.errors?.length);
  if (withErrors.length) md.push('## Console errors', '', ...withErrors.flatMap((s) => [`### ${s.name}`, '', ...s.errors.slice(0, 8).map((e) => `- \`${String(e).slice(0, 300).replace(/`/g, "'")}\``), '']));
  try {
    qa.writeText(qa.outPath('summary.md'), `${md.join('\n')}\n`);
    qa.writeJson(qa.outPath('summary.json'), { verdict, exitCode, base, scope: SCOPE, args, startedAt: STARTED_AT, seconds, counts, steps: results });
  } catch (e) {
    console.error(`[run-all] could not write the summary: ${e.message}`);
  }
  console.log(JSON.stringify({ verdict, exitCode, counts, seconds, summary: 'tests/out/summary.md', steps: results.map((s) => ({ name: s.name, status: s.status, details: s.details })) }, null, 2));
  process.exit(exitCode);
}

function abortRun(reason, code) {
  killTree(active);
  results.push({ id: 'run-all', group: 'run-all', name: 'run-all', status: 'FAIL', details: reason });
  for (const s of plan) if (!results.some((r) => r.id === s.id)) results.push({ id: s.id, group: s.group, name: s.name, status: 'SKIP', details: `not run (${reason})` });
  finish(code);
}

// ------------------------------------------------------------------------------------------------ main
buildPlan();
if (usage.length) {
  console.error(`[run-all] ${usage.join('\n[run-all] ')}`);
  process.exit(2);
}
if (args.list) {
  console.log(`run-all plan — ${plan.length} steps · scope ${SCOPE} · --timeout ${TIMEOUT_S}s\n`);
  plan.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. [${s.group}] ${s.name} · ${s.invalid ? `INVALID: ${s.invalid}` : `timeout ${s.timeoutS}s\n    ${commandOf(s)}`}`));
  process.exit(0);
}
if (!plan.length) {
  console.error('[run-all] nothing to run (check --only / --demos / --acts / --core)');
  process.exit(2);
}

// last resort: a hung parent still writes the summary (all real work happens in killable children)
setTimeout(() => abortRun(`the run hit --timeout=${TIMEOUT_S}s (watchdog)`, 3), TIMEOUT_S * 1000 + 60_000).unref();
process.on('SIGINT', () => abortRun('interrupted (Ctrl+C)', 130));

try {
  const res = await qa.withTimeout(fetch(base), 8000, 'dev server check');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (e) {
  results.push({ id: 'server', group: 'server', name: 'dev server', status: 'FAIL', details: `not reachable at ${base} (${e.message}) — the shared dev server must be running` });
  finish(2);
}

for (const step of plan) {
  if (Date.now() > DEADLINE - 10_000) {
    abortRun(`the run hit --timeout=${TIMEOUT_S}s`, 3);
    break;
  }
  const r = await runStep(step);
  if (args.bail && r.status === 'FAIL') {
    abortRun(`--bail after "${step.name}" failed`, 1);
    break;
  }
}
finish();
