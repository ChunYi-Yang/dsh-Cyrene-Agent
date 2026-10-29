import { createRequire } from 'node:module';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile,mkdir } from 'node:fs/promises';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=process.argv[2]&&resolve(process.argv[2]);
if(!source)throw Error('Usage: node scripts/build-tool-schema.mjs <integration-source>');
const requireSource=createRequire(join(source,'cyrene/package.json'));
const {build}=requireSource('esbuild');
await build({stdin:{contents:`export { defineTool } from './packages/core/tools/lib/types/schema.js';`,resolveDir:join(source,'harness')},
  outfile:join(root,'runtime/tool-schema.js'),bundle:true,platform:'node',format:'esm',target:'node24',minify:true,sourcemap:false,
  banner:{js:'// DSH tool-schema helper, bundled to avoid replacing host services. See runtime/LICENSE-DSH.txt.'},legalComments:'inline'});
await copyFile(join(source,'harness/LICENSE'),join(root,'runtime/LICENSE-DSH.txt'));
