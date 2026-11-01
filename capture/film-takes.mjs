// node capture/film-takes.mjs --url=http://127.0.0.1:8081/ [--shots=s01-cold-open,s04-act1] [--prefix=final]
// Real-time 1920×1080 capture with the game's audio. Metadata is saved after EACH take; failures close cleanly.
import {mkdirSync, writeFileSync, existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as qa from '../tests/lib/iwer.mjs';

const args=qa.parseArgs();
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(here,'../captures'); mkdirSync(out,{recursive:true});
const known=['s01-cold-open','s02-wide','s04-act1','s05-act2','s06-catch','s07-act3','s08-bow','s09-hands','s10-glasses'];
const selected=args.shots?String(args.shots).split(','):known;
for(const s of selected) if(!known.includes(s)) throw new Error(`unknown shot ${s}`);
const prefix=String(args.prefix??'final').replace(/[^a-z0-9_-]/gi,'_');
const manifestFile=path.join(out,`${prefix}-takes.json`);
const previous=args.resume&&existsSync(manifestFile)?JSON.parse(readFileSync(manifestFile,'utf8')):null;
const manifest=previous??{createdAt:new Date().toISOString(),url:qa.baseUrl(args),requestedCanvas:[1920,1080],requestedFps:60,
  capture:'Meta IWER, real game, real-time hand/gaze input; debug jumps occur before each take',takes:[]};
delete manifest.fatal; manifest.interrupted=false;
const save=()=>writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
let browser=null, context=null, page=null, recording=false, interrupted=false;
process.on('SIGINT',()=>{interrupted=true;});
try {
  browser=await qa.launchBrowser({extraArgs:['--autoplay-policy=no-user-gesture-required']});
  context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1,ignoreHTTPSErrors:true});
  await context.addInitScript({path:path.join(here,'audio-tap.js')});
  await context.addInitScript(()=>localStorage.removeItem('sleight-of-eye.save.v1'));
  // Stop code changes from reloading a rolling camera. The IWER bridge websocket is left intact.
  await context.routeWebSocket(u=>u.pathname==='/'&&u.searchParams.has('token'),ws=>{ws.onMessage(()=>{});ws.send(JSON.stringify({type:'connected'}));});
  page=await context.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
  await page.goto(qa.baseUrl(args),{waitUntil:'load',timeout:60000});
  await page.waitForFunction(()=>!!window.__app,null,{timeout:60000});
  const xr=await qa.enterXR(page,{fov:60,head:[0,1.2,0],look:[0,0.9,-0.45]});
  manifest.xr=xr;
  await qa.waitForState(page,s=>s.calibrated&&s.started,{timeout:30000,label:'capture game ready'});
  await page.evaluate(async()=>{window.__film=await import('/capture/trailer.js');});
  for(const shot of selected){
    if(interrupted) break;
    if(args.resume&&manifest.takes.some(t=>t.shot===shot&&t.ok)){console.log(`Keeping successful ${shot}`);continue;}
    console.log(`Preparing ${shot}`);
    const take={shot,name:`${prefix}-${shot}`,startedAt:new Date().toISOString(),ok:false};
    const errorStart=errors.length;
    try {
      take.prepared=await qa.withTimeout(page.evaluate(s=>window.__film.prepare(s),shot),25000,`${shot} prepare`);
      await qa.withTimeout(page.evaluate(n=>window.__film.start(n),take.name),20000,`${shot} record start`);
      recording=true;
      console.log(`Rolling ${shot}`);
      take.performance=await qa.withTimeout(page.evaluate(s=>window.__film.perform(s),shot),160000,`${shot} gameplay`);
      take.recording=await qa.withTimeout(page.evaluate(()=>window.__film.stop()),25000,`${shot} flush`);
      recording=false;
      take.errors=errors.slice(errorStart);
      if(take.errors.length) throw new Error(take.errors.join('\n'));
      take.ok=true;
      console.log(`Saved ${take.recording.name}: ${take.recording.seconds.toFixed(1)} s, ${take.recording.xrFps.toFixed(1)} fps`);
    } catch(e) {
      take.error=String(e.stack??e);
      if(recording){take.partial=await qa.withTimeout(page.evaluate(()=>window.__film.stop()),12000,'failed take flush').catch(e=>({error:String(e)}));recording=false;}
      take.lastState=await qa.appState(page).catch(()=>null);
      console.error(`FAILED ${shot}: ${e.message}`);
    }
    const old=manifest.takes.findIndex(t=>t.shot===shot);
    if(old>=0) manifest.takes[old]=take; else manifest.takes.push(take);
    save();
    // An expired page.evaluate keeps executing in the page. Stop on failure so it cannot move hands/gaze
    // inside the next take; the saved manifest and --shots make a clean, targeted retry easy.
    if(!take.ok) break;
  }
  manifest.interrupted=interrupted;
} catch(e) {manifest.fatal=String(e.stack??e); console.error(manifest.fatal);}
finally {
  if(recording&&page) await qa.withTimeout(page.evaluate(()=>window.__film.stop()),12000,'final flush').catch(()=>{});
  await context?.close().catch(()=>{}); await browser?.close().catch(()=>{});
  manifest.finishedAt=new Date().toISOString(); save();
}
console.log(`Manifest: ${path.join(out,`${prefix}-takes.json`)}`);
process.exitCode=manifest.fatal||manifest.interrupted||manifest.takes.some(t=>!t.ok)?1:0;
