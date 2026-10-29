import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export async function findDesktop() {
  if (basename(process.execPath).toLowerCase() === 'deepseek harness.exe') return process.execPath;
  const { stdout } = await execute('where.exe',['dsh.cmd'],{windowsHide:true,timeout:2000});
  const cli = stdout.split(/\r?\n/).find(Boolean);
  if (!cli) throw Error('DSH desktop unavailable');
  return resolve(dirname(cli),'../../../../DeepSeek Harness.exe');
}
/** A lifecycle-scoped focus bridge; no DSH executable patches or arbitrary commands. */
export async function startDesktopBridge(root) {
  const token = randomBytes(32).toString('hex');
  const directory = join(root,'.local'), filename = join(directory,'tray-control.json');
  await mkdir(directory,{recursive:true});
  const server = createServer(async (request,response)=>{
    const auth = request.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (!['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
      || Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(auth),Buffer.from(expected))) {
      response.writeHead(403).end();return;
    }
    if (request.method !== 'POST' || !['/select/dsh','/select/cyrene'].includes(request.url)) {response.writeHead(404).end();return;}
    try {
      if (request.url === '/select/dsh') {
        const executable = await findDesktop();
        await new Promise((accept,reject)=>{
          const child=spawn(executable,[],{detached:true,stdio:'ignore',windowsHide:false});
          child.once('error',reject);child.once('spawn',()=>{child.unref();accept();});
        });
      }
      response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"ok":true}');
    } catch {response.writeHead(503).end();}
  });
  server.requestTimeout=5000;server.headersTimeout=5000;
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
  const temporary=`${filename}.${token}.tmp`;
  try {
    await writeFile(temporary,JSON.stringify({protocol:1,port:server.address().port,token}),{mode:0o600,flag:'wx'});
    await rename(temporary,filename);
  } catch(error) {server.close();await unlink(temporary).catch(()=>{});throw error;}
  return async()=>{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    try {if(JSON.parse(await readFile(filename,'utf8')).token===token)await unlink(filename);}catch{}
  };
}
