import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join,resolve,dirname,basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const rules={
  personal:new RegExp([basename(homedir()),resolve(root,'..'),...(process.env.CYRENE_AUDIT_PRIVATE_MARKERS?.split('|').filter(Boolean) ?? [])].map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'i'),
  privateKey:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{180,}-----END/,
  token:/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-(?:proj-|ant-)[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})/,
  email:/[A-Za-z0-9_.+%-]+@(?!users\.noreply\.github\.com|example\.(?:com|test|invalid))[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
};
const reviewed=JSON.parse(await readFile(join(root,'scripts/audit-reviewed.json'),'utf8'));
const findings=[],accepted=[];let scanned=0;
function scan(name,data,{dependency=false}={}) {
  if(data.includes(0))return;
  const text=data.toString('utf8');scanned++;
  for(const [rule,pattern]of Object.entries(rules)) {
    if(rule==='email'&&dependency)continue; // Preserve third-party copyright and package maintainer contacts.
    if(pattern.test(text)) {
      const digest=createHash('sha256').update(data).digest('hex');
      const review=reviewed.find(item=>item.file===name&&item.rule===rule&&item.sha256===digest);
      if(review)accepted.push({file:name,rule,reason:review.reason});
      else findings.push({file:name,rule});
    }
  }
}
const names=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
for(const name of new Set(names)) {
  if(name==='scripts/audit.mjs')continue; // This scanner's detection literals are not project data.
  scan(name,await readFile(join(root,name)));
}
const runtime=process.argv[2]&&resolve(process.argv[2]);
if(runtime) {
  const source=process.argv[3]&&resolve(process.argv[3]);
  if(!source)throw Error('Usage: node scripts/audit.mjs <unpacked-runtime> <cyrene-source>');
  const requireSource=createRequire(join(source,'package.json'));
  const requireBuilder=createRequire(requireSource.resolve('electron-builder'));
  const requireAppBuilder=createRequire(requireBuilder.resolve('app-builder-lib'));
  const asar=requireAppBuilder('@electron/asar');
  const archive=join(runtime,'resources/app.asar');
  for(const raw of asar.listPackage(archive)) {
    const nativeName=raw.replace(/^[/\\]/,'');
    const name=nativeName.replaceAll('\\','/');
    const info=asar.statFile(archive,nativeName,false);if(info.files||info.link)continue;
    if(!/\.(?:js|cjs|mjs|json|md|txt|html|css|yml|yaml)$/i.test(name))continue;
    try {scan('app.asar/'+name,asar.extractFile(archive,nativeName),{dependency:name.startsWith('node_modules/')});}
    catch(error) {throw Error('Unable to audit packaged text: '+name,{cause:error});}
  }
  async function walk(dir,prefix='') {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const name=prefix+entry.name;
      if(entry.isDirectory())await walk(join(dir,entry.name),name+'/');
      else if(/\.(?:js|cjs|mjs|json|md|txt|html|css|yml|yaml)$/i.test(entry.name))scan('runtime/'+name,await readFile(join(dir,entry.name)),{dependency:name.includes('node_modules/')});
    }
  }
  await walk(runtime);
}
const report={scanned,findings,reviewed:accepted,scope:runtime?'source-and-runtime':'source',limitations:'Text scan only. Product images, third-party licenses and binary metadata require manual review before upload.'};
await mkdir(join(root,'.artifacts'),{recursive:true});
await writeFile(join(root,'.artifacts/privacy-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if(findings.length)process.exitCode=1;
