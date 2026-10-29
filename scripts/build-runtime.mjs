import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileHash } from '../runtime/manager.js';
const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source = process.argv[2] && resolve(process.argv[2]);
if (!source || process.platform !== 'win32' || process.arch !== 'x64') throw Error('Usage: node scripts/build-runtime.mjs <built-cyrene-source> (Windows x64)');
for (const file of ['package.json','dist/main/main/index.js','dist/preload/preload/index.js','dist/renderer/index.html','node_modules/electron/dist/electron.exe']) await access(join(source,file));
const pkg = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const output = join(root,'.artifacts',`runtime-${pkg.version}`);
await mkdir(output,{recursive:true});
const requireSource = createRequire(join(source,'package.json'));
const { build, Platform, Arch } = requireSource('electron-builder');
// Use only compiled product files; never copy the development repository or its private runtime directory.
await build({projectDir:source,targets:Platform.WINDOWS.createTarget(['dir'],Arch.x64),config:{
  appId:'com.cyrene.dsh',productName:'Cyrene',asar:true,npmRebuild:false,nodeGypRebuild:false,
  electronDist:join(source,'node_modules/electron/dist'),
  directories:{output},publish:null,
  files:[
    'dist/main/**/*','dist/preload/**/*','dist/renderer/**/*','assets/**/*','vendor/srt-win/**/*','package.json',
    '!**/*.map','!**/*.test.*','!**/*.log','!**/installation.json','!**/.local/**/*',
    '!**/*.onnx','!**/*.onnx_data','!**/*.safetensors',
    '!**/onnxruntime-node/bin/napi-v3/darwin/**/*','!**/onnxruntime-node/bin/napi-v3/linux/**/*','!**/onnxruntime-node/bin/napi-v3/win32/arm64/**/*',
  ],
  asarUnpack:['**/*.node','**/node_modules/sharp/**','**/vendor/srt-win/**','**/node_modules/@ast-grep/**','**/node_modules/@playwright/**','**/node_modules/playwright/**','**/node_modules/playwright-core/**','**/node_modules/@modelcontextprotocol/**'],
  extraFiles:[{from:join(source,'prompts'),to:'prompts'},{from:join(source,'LICENSE'),to:'LICENSE-Cyrene.txt'}],
  extraMetadata:{author:'Cyrene contributors',homepage:'https://github.com/Playa-Cyrene/Cyrene-Agent',scripts:null,devDependencies:null},
  win:{icon:join(source,'assets/tray-icon.ico'),signAndEditExecutable:false,electronLanguages:['en-US','zh-CN','zh-TW']},
}});
const unpacked=join(output,'win-unpacked');
const archive=join(output,'Cyrene-win32-x64.zip');
await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',join(root,'scripts/zip-runtime.ps1'),'-Source',unpacked,'-Destination',archive],{windowsHide:true,timeout:20*60*1000});
const files={};for (const name of ['Cyrene.exe','resources/app.asar']) files[name]=await fileHash(join(unpacked,name));
const manifest={version:pkg.version,assets:{'win32-x64':{
  url:`https://github.com/ChunYi-Yang/dsh-Cyrene-Agent/releases/download/runtime-v${pkg.version}/Cyrene-win32-x64.zip`,
  sha256:await fileHash(archive),bytes:(await stat(archive)).size,files,
}}};
await writeFile(join(root,'runtime-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Runtime built: ${manifest.assets['win32-x64'].bytes} bytes. Not uploaded; run privacy audit before publishing.`);
