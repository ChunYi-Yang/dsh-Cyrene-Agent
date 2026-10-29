import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractZip } from '../runtime/manager.js';
const fixtures=JSON.parse(await readFile(new URL('./zip-fixtures.json',import.meta.url),'utf8'));
test('Windows extraction rejects traversal, alternate streams and reserved names',{skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'cyrene-zip-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [name,bytes]of Object.entries(fixtures)) {
    const archive=join(root,'fixture.zip');await writeFile(archive,Buffer.from(bytes,'base64'));
    const target=join(root,'unpack-'+Object.keys(fixtures).indexOf(name));
    if(name==='ok.txt'||name.startsWith('nested/')) {
      await extractZip(archive,target);assert.equal(await readFile(join(target,name),'utf8'),'synthetic fixture');
    } else await assert.rejects(extractZip(archive,target),error=>error.code==='extraction');
  }
  await assert.rejects(readFile(join(root,'escape.txt')),error=>error.code==='ENOENT');
});
