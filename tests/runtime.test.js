import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntimeManager, validateManifest } from '../runtime/manager.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const payload = Buffer.from('synthetic archive');
const manifest = { version: '0.2.0', assets: { 'win32-x64': {
  url: 'https://github.com/ChunYi-Yang/dsh-Cyrene-Agent/releases/download/runtime-v0.2.0/Cyrene-win32-x64.zip',
  sha256: hash(payload), bytes: payload.length,
  files: { 'Cyrene.exe': hash('executable'), 'resources/app.asar': hash('application') },
} } };
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cyrene-runtime-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloads = 0;
  const manager = createRuntimeManager({ root, manifest, platform: 'win32', arch: 'x64',
    fetcher: async () => { downloads++; return new Response(payload); },
    extract: async (_archive, target) => {
      await mkdir(join(target, 'resources'), { recursive: true });
      await writeFile(join(target, 'Cyrene.exe'), 'executable');
      await writeFile(join(target, 'resources/app.asar'), 'application');
    }, ...overrides });
  return { root, manager, downloads: () => downloads };
}
test('first installation, concurrent requests and restart reuse', async t => {
  const f = await fixture(t);
  const [a,b] = await Promise.all([f.manager.ensure(),f.manager.ensure()]);
  assert.equal(a,b); assert.equal(f.downloads(),1);
  assert.equal(await readFile(a,'utf8'),'executable');
  const next = createRuntimeManager({ root:f.root,manifest,platform:'win32',arch:'x64',fetcher:()=>{throw Error('offline');} });
  assert.equal(await next.ensure(),a);
  assert.equal(next.status().phase,'ready');
});
test('checksum failure is retryable and never becomes ready', async t => {
  let fail=true;
  const f=await fixture(t,{fetcher:async()=>new Response(fail?Buffer.from('bad'):payload)});
  await assert.rejects(f.manager.ensure()); assert.equal(f.manager.status().phase,'error');
  fail=false; await f.manager.ensure(); assert.equal(f.manager.status().phase,'ready');
});
test('tampered executable is not launched from cache',async t=>{
  const f=await fixture(t);const executable=await f.manager.ensure();await writeFile(executable,'tampered');
  await assert.rejects(f.manager.ensure());assert.equal(f.manager.status().phase,'error');
});
test('failed extraction leaves no accepted installation',async t=>{
  const f=await fixture(t,{extract:async()=>{throw Error('extraction failed');}});
  await assert.rejects(f.manager.ensure());assert.equal(f.manager.status().phase,'error');
});
test('manifest rejects foreign downloads, traversal, unsupported platform and missing release',()=>{
  for(const url of ['http://github.com/x','https://example.com/a.zip','https://github.com/other/repo/a.zip']) {
    assert.throws(()=>validateManifest({...manifest,assets:{'win32-x64':{...manifest.assets['win32-x64'],url}}},'win32','x64'));
  }
  assert.throws(()=>validateManifest({...manifest,version:'../escape'},'win32','x64'));
  assert.throws(()=>validateManifest(manifest,'darwin','arm64'));
  assert.throws(()=>validateManifest({version:'0.2.0',assets:{}},'win32','x64'));
});
