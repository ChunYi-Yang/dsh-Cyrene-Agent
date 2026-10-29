import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDesktopBridge } from '../runtime/desktop-bridge.js';
import { installationRoot } from '../runtime/location.js';
test('profiles receive stable separate locations outside the plugin install directory',()=>{
  const env={LOCALAPPDATA:join(tmpdir(),'appdata')};
  assert.equal(installationRoot('profile-a',env),installationRoot('profile-a',env));
  assert.notEqual(installationRoot('profile-a',env),installationRoot('profile-b',env));
  assert.ok(!installationRoot('private-profile-name',env).includes('private-profile-name'));
});
test('desktop focus bridge requires token and rejects arbitrary actions',async t=>{
  const root=await mkdtemp(join(tmpdir(),'cyrene-bridge-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const close=await startDesktopBridge(root);t.after(close);
  const record=JSON.parse(await readFile(join(root,'.local/tray-control.json'),'utf8'));
  const url=`http://127.0.0.1:${record.port}`;
  assert.equal((await fetch(url+'/select/cyrene',{method:'POST'})).status,403);
  const headers={authorization:`Bearer ${record.token}`};
  assert.equal((await fetch(url+'/run',{method:'POST',headers})).status,404);
  assert.equal((await fetch(url+'/select/cyrene',{headers})).status,404);
  assert.equal((await fetch(url+'/select/cyrene',{method:'POST',headers})).status,200);
});
