import { fork, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRuntimeManager } from '../runtime/manager.js';
import { createControl } from '../plugins/ruwo-suoxie/control.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=process.argv[2]&&resolve(process.argv[2]);
if(!source)throw Error('Usage: node scripts/smoke-runtime.mjs <integration-source>');
const local=process.env.CYRENE_SMOKE_DIRECTORY?resolve(process.env.CYRENE_SMOKE_DIRECTORY):join(root,'.artifacts',`smoke-${randomUUID()}`);
if(!local.startsWith(join(root,'.artifacts')+'/')&&!local.startsWith(join(root,'.artifacts')+'\\'))throw Error('Smoke directory must be inside .artifacts');
await mkdir(local,{recursive:true});
const installed=process.argv.includes('--installed');
const patch=join(local,'patch.yml');
const quote=value=>JSON.stringify(value.replaceAll('\\','/'));
let patchText=`- id: webserver
  config:
    host: 127.0.0.1
    port: 0
- id: web-runtime
  config:
    openBrowser: false
    printUrl: false
    surfaceContext: false
- id: hmr
  disabled: true
- id: session-title-llm
  disabled: true
- id: session-telemetry-otel
  disabled: true
- insert:
    - id: ruwo-suoxie-release
      name: ${quote(join(root,'plugins/ruwo-suoxie/index.js'))}
`;
if(installed)patchText=patchText.slice(0,patchText.indexOf('- insert:'));
await writeFile(patch,patchText);
const child=fork(join(source,'harness/apps/cli/lib/bin.js'),['--profile','web','--patch',patch],{
  cwd:join(source,'harness'),windowsHide:true,
  env:{...process.env,DSH_HOME:installed?local:join(local,'dsh'),LOCALAPPDATA:join(local,'appdata')},stdio:['ignore','ignore','pipe','ipc'],
});
const log=createWriteStream(join(local,'native.log'));child.stderr.pipe(log);
const requireSource=createRequire(join(source,'cyrene/package.json'));
const {DesktopSessionClient}=requireSource('./dist/main/main/deepseek/desktop-sessions.js');
const base=join(local,'appdata/CyreneDSH');
let data,control;
try {
  for(let i=0;i<120;i++) {
    try {
      for(const name of await readdir(base)) {
        const candidate=join(base,name);
        try {await readFile(join(candidate,'.local/dsh-desktop-connection.json'));await new DesktopSessionClient(candidate).request('identity',{});data=candidate;break;}catch{}
      }
    }catch{}
    if(data)break;
    if(child.exitCode!==null)throw Error('Isolated DSH process exited; inspect the local native log');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(data,'Plugin did not initialize in the isolated DSH profile');
  const client=new DesktopSessionClient(data);
  assert.equal((await client.request('identity',{})).runtime,'DeepSeek Harness');
  assert.deepEqual((await client.request('team',{action:'snapshot'})).members,[]);
  const manifest=JSON.parse(await readFile(join(root,'runtime-manifest.json'),'utf8'));
  const archive=join(root,'.artifacts',`runtime-${manifest.version}`,'Cyrene-win32-x64.zip');
  const manager=createRuntimeManager({root:data,manifest,fetcher:async()=>new Response(Readable.toWeb(createReadStream(archive)))});
  const executable=await manager.ensure();
  // A fresh manager must reuse this verified installation without any network access.
  const offline=createRuntimeManager({root:data,manifest,fetcher:()=>{throw Error('offline');}});
  assert.equal(await offline.ensure(),executable);
  control=createControl(data,{launchExecutable:()=>offline.ensure(),spawn:(executable,args,options)=>spawn(executable,['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',...args],options)});
  assert.equal((await control.open()).running,true);
  assert.equal((await control.status()).running,true);
  await new Promise(resolve=>setTimeout(resolve,8000));
  const debugFile=join(data,'.local/cyrene/DevToolsActivePort');
  const port=Number((await readFile(debugFile,'utf8')).split('\n')[0]);
  assert.ok(port>0);
  const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const main=pages.find(page=>page.type==='page'&&page.url.includes('/react/index.html'));
  assert.ok(main,'Main renderer did not load');
  const socket=new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((accept,reject)=>{socket.addEventListener('open',accept,{once:true});socket.addEventListener('error',reject,{once:true});});
  let nextId=0;const waiting=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id&&waiting.has(message.id)){waiting.get(message.id)(message);waiting.delete(message.id);}});
  const cdp=(method,params={})=>new Promise((accept,reject)=>{const id=++nextId;const timer=setTimeout(()=>{waiting.delete(id);reject(Error('Renderer check timed out'));},10000);waiting.set(id,message=>{clearTimeout(timer);accept(message);});socket.send(JSON.stringify({id,method,params}));});
  const dom=await cdp('Runtime.evaluate',{expression:'JSON.stringify({ready:document.readyState,text:document.body.innerText,rootChildren:document.querySelector("#cyrene-react-root")?.childElementCount})',returnByValue:true});
  const content=JSON.parse(dom.result.result.value);
  await writeFile(join(local,'renderer-state.json'),JSON.stringify(content,null,2));
  const capture=await cdp('Page.captureScreenshot');
  await writeFile(join(local,'renderer.png'),Buffer.from(capture.result.data,'base64'));
  console.log(JSON.stringify({rendererReady:content.ready,rootChildren:content.rootChildren,bodyLength:content.text.length}));
  assert.equal(content.ready,'complete');assert.ok(content.rootChildren>0,'Main renderer is blank');assert.ok(content.text.length>20);
  const screenshot=await cdp('Page.captureScreenshot');
  await writeFile(join(local,'renderer.png'),Buffer.from(screenshot.result.data,'base64'));
  socket.close();
  await control.quit();
  for(let i=0;i<100 && (await control.status()).running;i++)await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal((await control.status()).running,false,'Owned Cyrene process did not stop');
  const result={nativePlugin:true,installedPackage:installed,teamGateway:true,firstInstall:true,offlineReuse:true,portableStartup:true,portableShutdown:true,mainRenderer:true,modelCalls:0};
  await writeFile(join(local,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  if(control)await control.quit().catch(()=>{});
  child.kill();log.end();
}
