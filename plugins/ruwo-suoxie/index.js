import { createTeam } from './team/dsh.js';
import { createUsageReader } from './usage.js';
import { createRuntimeManager } from '../../runtime/manager.js';
import { installationRoot } from '../../runtime/location.js';
import { startDesktopBridge } from '../../runtime/desktop-bridge.js';
import { createContinuation } from './continuation.js';
import { createControl } from './control.js';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionResponse } from './sessions.js';
import { createCompanion } from './companion.js';
import { createModelImporter } from './model-sync.js';
import { createPluginManagement } from './plugin-management.js';

export const name = 'ruwo-suoxie';
export const inject = ['connection', 'sessionController', 'webServer', 'agents', 'systemPrompt', 'tools'];

/** Register on DSH's existing authenticated host connection, never a public listener. */
export async function apply(ctx, config = {}) {
  const root = installationRoot(ctx.baseUrl ?? 'default');
  const manifest = JSON.parse(readFileSync(new URL('../../runtime-manifest.json', import.meta.url), 'utf8'));
  const runtime = createRuntimeManager({ root, manifest });
  const control = createControl(root, { launchExecutable: () => runtime.ensure() });
  ctx.effect(() => {
    const ready = startDesktopBridge(root);
    ready.catch(() => {});
    return async () => { const dispose = await ready.catch(() => undefined); if (dispose) await dispose(); };
  });
  if (control) {
    await mkdir(join(root,'.local/team'),{recursive:true});
    await writeFile(join(root,'.local/team/config.json'),JSON.stringify({members:[],maxParallel:2,timeoutMs:600000,maxOutputBytes:1048576}),{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const team = await createTeam(ctx,root);
    const usage = createUsageReader(ctx);
    const companion = ctx.agents ? createCompanion(ctx, root) : undefined;
    const continuation = createContinuation(ctx.sessionController, root);
    const importModels = createModelImporter(ctx, root);
    const plugins = createPluginManagement(ctx);
    const generation = randomUUID();
    const filename = join(root, '.local/dsh-desktop-connection.json');
    // Authentication URL is main-process-only and remains in the ignored local directory.
    ctx.effect(() => {
      let disposed = false;
      const ready = (async () => {
        await mkdir(join(root, '.local'), { recursive: true });
        const url = ctx.connection.authenticatedUrl(ctx.webServer.getOrigin());
        const temporary = `${filename}.${generation}.tmp`;
        await writeFile(temporary, JSON.stringify({ protocol: 1, generation, url }), { mode: 0o600, flag: 'wx' });
        if (!disposed) {
          await rename(temporary, filename);
          // A restarted DSH refreshes the already-running companion's catalog.
          await control.syncModels().catch(() => {});
        }
        else await unlink(temporary);
      })();
      ready.catch(() => {});
      return async () => {
        disposed = true;
        await ready.catch(() => {});
        try { if (JSON.parse(await readFile(filename, 'utf8')).generation === generation) await unlink(filename); }
        catch { /* Never remove a different runtime's connection. */ }
      };
    });
    ctx.connection.fetch.register({ path: '/api/ruwo-suoxie/session', methods: ['POST'], requestBody: 'buffered',
      fetch: request => sessionResponse(ctx.sessionController, request, companion, continuation, importModels, plugins, team, usage) });
  }
  ctx.connection.fetch.register({
    path: '/api/ruwo-suoxie/control', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const respond = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
      // Custom header prevents cross-site form submissions; the Host authenticates the caller.
      if (request.headers.get('x-cyrene-control') !== '1') return respond({ error: 'forbidden' }, 403);

      try {
        if (Number(request.headers.get('content-length') ?? 0) > 1024) return respond({ error: 'invalid' }, 400);
        const body = await request.text();
        if (body.length > 1024) return respond({ error: 'invalid' }, 400);
        const { action, id } = JSON.parse(body);
        if (action === 'prepare') { void runtime.ensure().catch(() => {}); return respond(runtime.status()); }
        if (action === 'preparation') return respond(runtime.status());
        if (!['status', 'open', 'switch', 'quit', 'conversations', 'history', 'resolve'].includes(action)) return respond({ error: 'invalid' }, 400);
        return respond({ configured: true, ...await control[action](id, request.signal) });
      } catch { return respond({ error: 'Cyrene 尚未就绪，请稍后重试。' }, 503); }
    },
  });
}
