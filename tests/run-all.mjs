// tests/run-all.mjs — one command for the whole QA pass (owned by Q).
//
//   node tests/run-all.mjs [--url=http://127.0.0.1:8081/] [--only=demos,selftest,fov,perf,overlay,scenarios]
//                          [--step-timeout=300] [--timeout=1800]
//
// 1. demos      every src/demos/<name>.demo.ts at ?demo=<name>, in XR (seated eye, looking at the stage):
//               screenshot tests/out/demos/<name>.png + render stats; FAIL on page/console errors or no XR.
// 2. selftest   the QA tooling itself on the debug fixture (?demo=debug): overlay checks + the Act 1 scenario
//               against its mock window.__app.
// 3. game       when the game exists (window.__app at /): fov.mjs, perf.mjs, overlay.mjs (?debug=1),
//               scenarios/act1..3.mjs as child
//               processes (each with its own watchdog plus a hard timeout here); otherwise SKIP.
// Writes tests/out/summary.md (+ summary.json). Exit 1 when any step FAILs, 2 when the server is unreachable.
// Nothing can hang: every page call, child process and the whole run have timeouts.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as qa from './lib/iwer.mjs';

const args = qa.parseArgs();
qa.installWatchdog(Number(args.timeout ?? 1800) * 1000, 'run-all');
const base = qa.baseUrl(args);
const only = new Set(String(args.only ?? 'demos,selftest,fov,perf,overlay,scenarios').split(','));
const STEP_TIMEOUT = Number(args['step-timeout'] ?? 300) * 1000;
const steps = [];
const t0 = Date.now();

const record = (name, status, details = '', extra = {}) => {
  const s = { name, status, details, ...extra };
  steps.push(s);
  console.error(`[run-all] ${status.padEnd(4)} ${name}${details ? ` — ${details}` : ''}`);
  return s;
};

// ------------------------------------------------------------------------------------------------ server
try {
  const r = await qa.withTimeout(fetch(base), 8000, 'server check');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  record('server', 'FAIL', `dev server not reachable at ${base} (${e.message}). Start it: APP_PORT=<port> node scripts/dev-local.mjs`);
  finish(2);
}

// ------------------------------------------------------------------------------------------------ demos
if (only.has('demos')) {
  const demos = qa.listDemos();
  const browser = await qa.launchBrowser();
  try {
    for (const demo of demos) {
      const started = Date.now();
      let app = null;
      try {
        await qa.withTimeout(
          (async () => {
            app = await qa.openApp(qa.appUrl(base, { demo }), { browser });
            const xr = await qa.enterXR(app.page, { fov: 60, head: qa.DEFAULT_EYE, look: [0, 0.95, -0.6] });
            await qa.wait(app.page, 1.5);
            const stats = await qa.renderStats(app.page, 500);
            const shot = await qa.screenshot(app.page, qa.outPath('demos', `${demo}.png`));
            const errors = [...qa.consoleErrors(app.page)];
            const ok = errors.length === 0 && xr.xrActive;
            record(
              `demo ${demo}`,
              ok ? 'PASS' : 'FAIL',
              ok ? `${stats.drawCallsPerView} draws/view, ${Math.round(stats.trianglesPerView / 1000)}k tris/view, ${stats.programs} programs` : (errors[0] ?? 'XR session did not start'),
              { shot, stats, errors, seconds: (Date.now() - started) / 1000 },
            );
          })(),
          90_000,
          `demo ${demo}`,
        );
      } catch (e) {
        record(`demo ${demo}`, 'FAIL', String(e?.message ?? e).split('\n')[0], {
          errors: app ? [...qa.consoleErrors(app.page)] : [],
          seconds: (Date.now() - started) / 1000,
        });
        if (app) await qa.screenshot(app.page, qa.outPath('demos', `${demo}-fail.png`)).catch(() => {});
      } finally {
        if (app) await app.close();
      }
    }
    if (!demos.length) record('demos', 'SKIP', 'no src/demos/*.demo.ts');
  } finally {
    await browser.close().catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------------ child steps
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

/** Run a node script; resolve { code, stdout, stderr, timedOut }. */
function runNode(script, scriptArgs, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(qa.APP_DIR, script), ...scriptArgs], { cwd: qa.APP_DIR, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-200_000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-50_000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, timedOut });
    });
  });
}

const readJson = (rel) => {
  const p = path.join(qa.OUT_DIR, rel);
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};

async function childStep(name, script, scriptArgs, { jsonFile, report, summarize }) {
  const started = Date.now();
  const r = await runNode(script, ['--url=' + base, ...scriptArgs], STEP_TIMEOUT);
  const json = jsonFile ? readJson(jsonFile) : null;
  const seconds = (Date.now() - started) / 1000;
  if (r.timedOut) return record(name, 'FAIL', `timed out after ${STEP_TIMEOUT / 1000}s`, { report, seconds });
  let status = r.code === 0 ? 'PASS' : 'FAIL';
  if (json?.status === 'skip') status = 'SKIP';
  const details = summarize?.(json, r) ?? (r.code === 0 ? '' : (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | '));
  return record(name, status, details, { report, seconds, exitCode: r.code });
}

// ------------------------------------------------------------------------------------------------ selftest
if (only.has('selftest')) {
  await childStep('selftest: debug overlay on the fixture', 'tests/overlay.mjs', ['--demo=debug'], {
    jsonFile: 'overlay-debug.json',
    report: 'overlay-debug.json',
    summarize: (j) => (j ? (j.ok ? `${j.checks.length} checks` : (j.checks.find((c) => !c.ok)?.name ?? j.fatal)) : 'no overlay.json'),
  });
  await childStep('selftest: act1 on the debug fixture', 'tests/scenarios/act1.mjs', ['--demo=debug', '--require-app'], {
    jsonFile: 'scenarios/act1.json',
    report: 'scenarios/act1.md',
    summarize: (j) => (j ? (j.results ?? []).map((x) => `${x.path} ${x.ok ? 'ok' : `FAILED (${x.failures[0] ?? '?'})`}`).join(', ') : 'no result file'),
  });
}

// ------------------------------------------------------------------------------------------------ game
const wantsGame = ['fov', 'perf', 'overlay', 'scenarios'].some((s) => only.has(s));
let game = false;
if (wantsGame) {
  const browser = await qa.launchBrowser();
  try {
    const app = await qa.openApp(base, { browser });
    game = await qa.hasApp(app.page, { timeout: 20_000 });
    await app.close();
  } catch (e) {
    record('game boot', 'FAIL', String(e?.message ?? e).split('\n')[0]);
  } finally {
    await browser.close().catch(() => {});
  }
  const skip = (n) => record(n, 'SKIP', 'game not integrated yet (no window.__app at /)');
  if (only.has('fov')) {
    if (!game) skip('fov');
    else
      await childStep('fov', 'tests/fov.mjs', [], {
        jsonFile: 'fov.json',
        report: 'fov-report.md',
        summarize: (j) => (j ? (j.ok ? `${j.acts?.length ?? 0} act(s), all required checks in view` : (j.failures?.[0] ?? j.fatal ?? 'failed')) : 'no fov.json'),
      });
  }
  if (only.has('perf')) {
    if (!game) skip('perf');
    else
      await childStep('perf', 'tests/perf.mjs', [], {
        jsonFile: 'perf.json',
        report: 'perf-report.md',
        summarize: (j) =>
          j?.worst
            ? `${Math.round(j.worst.drawCallsPerView)} draws/view, ${Math.round(j.worst.trianglesPerView / 1000)}k tris, ${j.worst.programs} programs${j.failures?.length ? ` — ${j.failures[0]}` : ''}`
            : (j?.fatal ?? 'no perf.json'),
      });
  }
  if (only.has('overlay')) {
    if (!game) skip('overlay (game, ?debug=1)');
    else
      await childStep('overlay (game, ?debug=1)', 'tests/overlay.mjs', [], {
        jsonFile: 'overlay.json',
        report: 'overlay.json',
        summarize: (j) => (j ? (j.ok ? `${j.checks.length} checks` : `${j.checks.find((c) => !c.ok)?.name ?? j.fatal}`) : 'no overlay.json'),
      });
  }
  if (only.has('scenarios')) {
    for (const act of [1, 2, 3]) {
      if (!game) {
        skip(`scenario act${act}`);
        continue;
      }
      await childStep(`scenario act${act}`, `tests/scenarios/act${act}.mjs`, [], {
        jsonFile: `scenarios/act${act}.json`,
        report: `scenarios/act${act}.md`,
        summarize: (j) => (j ? (j.results ?? []).map((x) => `${x.path} ${x.ok ? 'ok' : `FAILED (${x.failures[0] ?? '?'})`}`).join(', ') || j.reason || j.status : 'no result file'),
      });
    }
  }
}

finish(steps.some((s) => s.status === 'FAIL') ? 1 : 0);

// ------------------------------------------------------------------------------------------------ summary
function finish(code) {
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);
  const counts = steps.reduce((m, s) => ((m[s.status] = (m[s.status] ?? 0) + 1), m), {});
  const verdict = steps.some((s) => s.status === 'FAIL') ? 'FAIL' : 'PASS';
  const lines = [
    `# QA summary: ${verdict}`,
    '',
    `${new Date().toISOString()} · ${base} · ${seconds}s · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`,
    '',
    qa.mdTable(
      ['step', 'status', 'time', 'details', 'evidence'],
      steps.map((s) => [
        s.name,
        s.status === 'FAIL' ? '**FAIL**' : s.status,
        s.seconds !== undefined ? `${s.seconds.toFixed(0)}s` : '',
        s.details,
        [s.shot ? `[png](${qa.relOut(s.shot)})` : '', s.report ? `[report](${s.report})` : ''].filter(Boolean).join(' '),
      ]),
    ),
    '',
  ];
  const failing = steps.filter((s) => s.errors?.length);
  if (failing.length) lines.push('## Console errors', '', ...failing.flatMap((s) => [`### ${s.name}`, '', ...s.errors.slice(0, 8).map((e) => `- \`${e.slice(0, 300)}\``), '']));
  qa.writeText(qa.outPath('summary.md'), `${lines.join('\n')}\n`);
  qa.writeJson(qa.outPath('summary.json'), { verdict, base, seconds: Number(seconds), steps });
  console.log(JSON.stringify({ verdict, counts, summary: 'tests/out/summary.md', steps: steps.map((s) => ({ name: s.name, status: s.status, details: s.details })) }, null, 2));
  process.exit(code);
}
