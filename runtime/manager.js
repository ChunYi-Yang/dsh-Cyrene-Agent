import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const prefix = 'https://github.com/ChunYi-Yang/dsh-Cyrene-Agent/releases/download/';
const messages = {
  unsupported: '当前版本支持 Windows x64，请使用对应电脑。',
  unavailable: '此插件版本的 Cyrene 程序包尚未发布，请更新插件后重试。',
  invalid: '程序发布清单无效，请更新插件后重试。',
  download: '程序下载失败，请检查网络后重试。',
  integrity: '程序完整性检查失败，请重新安装插件或联系维护者。',
  busy: '另一个 DSH 窗口正在准备 Cyrene，请稍后重试。',
  extraction: '程序解压失败，请检查磁盘空间后重试。',
};
export function runtimeError(code) { return Object.assign(new Error(messages[code] ?? messages.integrity), { code }); }

export function validateManifest(manifest, platform, arch) {
  if (platform !== 'win32' || arch !== 'x64') throw runtimeError('unsupported');
  if (!manifest || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(manifest.version)) throw runtimeError('invalid');
  const entry = manifest.assets?.[`${platform}-${arch}`];
  if (!entry) throw runtimeError('unavailable');
  let url;
  try { url = new URL(entry.url); } catch { throw runtimeError('invalid'); }
  if (!entry.url.startsWith(prefix) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^runtime-v[a-zA-Z0-9.-]+\/Cyrene-win32-x64\.zip$/.test(entry.url.slice(prefix.length))
    || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 2 * 1024 ** 3
    || !entry.files || Object.keys(entry.files).sort().join(',') !== 'Cyrene.exe,resources/app.asar'
    || Object.values(entry.files).some(value => !/^[a-f0-9]{64}$/.test(value))) throw runtimeError('invalid');
  return entry;
}

export async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function download(entry, target, fetcher, progress) {
  const signal = AbortSignal.timeout(20 * 60 * 1000);
  let url = entry.url, response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(parsed.hostname)) throw runtimeError('download');
    response = await fetcher(url, { redirect: 'manual', signal });
    if (![301,302,303,307,308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 5) throw runtimeError('download');
    url = new URL(location, url).href;
  }
  if (!response?.ok || !response.body) throw runtimeError('download');
  const handle = await open(target, 'wx');
  let received = 0; const digest = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > entry.bytes) throw runtimeError('integrity');
      digest.update(chunk); await handle.write(chunk);
      progress({ received, total: entry.bytes });
    }
  } finally { await handle.close(); }
  if (received !== entry.bytes || digest.digest('hex') !== entry.sha256) throw runtimeError('integrity');
}

export async function extractZip(archive, destination) {
  try {
    await execute('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-File',
      fileURLToPath(new URL('./extract.ps1', import.meta.url)), '-Archive', archive, '-Destination', destination],
    { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
  } catch { throw runtimeError('extraction'); }
}

export function createRuntimeManager({ root, manifest, platform = process.platform, arch = process.arch, fetcher = fetch, extract = extractZip }) {
  let pending; let state = { phase: 'idle', received: 0, total: 0 };
  const update = patch => { state = { ...state, ...patch }; };
  const directory = join(root, 'runtime');
  async function validateInstalled(target, entry) {
    try {
      const saved = JSON.parse(await readFile(join(target, '.installed.json'), 'utf8'));
      if (saved.sha256 !== entry.sha256) throw runtimeError('integrity');
      for (const [file, digest] of Object.entries(entry.files)) {
        if (await fileHash(join(target, file)) !== digest) throw runtimeError('integrity');
      }
    } catch { throw runtimeError('integrity'); }
    return join(target, 'Cyrene.exe');
  }
  async function install() {
    update({ phase:'checking',error:undefined,received:0,total:0 });
    let lock, work;
    const lockPath = join(directory, '.install-lock');
    try {
      const entry = validateManifest(manifest, platform, arch);
      const target = join(directory, `${manifest.version}-${entry.sha256.slice(0,12)}`);
      try { await stat(target); return await validateInstalled(target, entry); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(directory, { recursive: true });
      try { lock = await open(lockPath, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Only reclaim our abandoned lock when its owner has exited; a fresh empty lock is still being written.
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs < 30000) throw runtimeError('busy');
        const owner = Number(await readFile(lockPath, 'utf8'));
        if (!Number.isSafeInteger(owner) || owner < 1) throw runtimeError('busy');
        try { process.kill(owner, 0); throw runtimeError('busy'); }
        catch (failure) { if (failure.code !== 'ESRCH') throw runtimeError('busy'); }
        await rm(lockPath); lock = await open(lockPath, 'wx');
      }
      await lock.writeFile(String(process.pid));
      // Another process may have completed while we acquired the lock.
      try { await stat(target); return await validateInstalled(target, entry); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      work = join(directory, `.install-${randomUUID()}`);
      await mkdir(work);
      const archive = join(work, 'download.zip'), unpacked = join(work, 'unpacked');
      update({ phase:'downloading',total:entry.bytes });
      await download(entry, archive, fetcher, update);
      update({ phase:'extracting' });
      await extract(archive, unpacked);
      await writeMarker(unpacked, entry);
      await validateInstalled(unpacked, entry);
      await rename(unpacked, target);
      return join(target, 'Cyrene.exe');
    } catch (error) {
      const safe = runtimeError(Object.hasOwn(messages,error.code) ? error.code : 'download');
      update({ phase:'error',error:safe.message }); throw safe;
    } finally {
      if (work) await rm(work,{ recursive:true,force:true }).catch(()=>{});
      if (lock) { await lock.close(); await rm(lockPath,{force:true}); }
    }
  }
  async function writeMarker(target, entry) {
    await open(join(target,'.installed.json'),'wx').then(async handle=>{
      try { await handle.writeFile(JSON.stringify({version:manifest.version,sha256:entry.sha256})); }
      finally { await handle.close(); }
    });
  }
  return {
    status: () => ({...state}),
    ensure() {
      if (!pending) pending = install().then(executable=>{
        update({phase:'ready',error:undefined});return executable;
      }).finally(()=>{pending=undefined;});
      return pending;
    },
  };
}
