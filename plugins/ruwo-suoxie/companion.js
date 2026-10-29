import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** Session-scoped persona; native DSH still owns history, tools, approvals, and its loop. */
export function createCompanion(ctx, root) {
  const directory = join(root, '.local');
  const filename = join(directory, 'desktop-personas.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Companion configuration unavailable'); }
  const installed = new WeakSet();
  function install(agent) {
    if (!settings[agent.id] || installed.has(agent)) return;
    const context = agent.ctx;
    ctx.effect(() => context.systemPrompt.section({ name: 'CYRENE_DESKTOP_PERSONA', order: 100,
      text: () => settings[agent.id]?.persona ?? '', interpolate: false }));
    ctx.effect(() => context.systemPrompt.context({ name: 'CYRENE_DESKTOP_CONTEXT', order: 100,
      text: () => settings[agent.id]?.context ?? '', interpolate: false }));
    // Chat remains companion-only; Work/Code/Learn use DSH's configured tool pipeline.
    if (settings[agent.id].mode === 'chat') ctx.effect(() => context.tools.restrict({ allow: [] }));
    installed.add(agent);
  }
  ctx.on('agent/created', ({ agent }) => install(agent));
  return {
    configure(params) {
      const { sessionId, mode, persona, context } = params;
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256
        || !['chat', 'work', 'code', 'learn'].includes(mode)
        || typeof persona !== 'string' || persona.length > 1024 * 1024
        || typeof context !== 'string' || context.length > 1024 * 1024) throw new Error('Invalid companion configuration');
      const old = settings[sessionId];
      if (old && old.mode !== mode) throw new Error('Conversation mode is immutable');
      const agent = ctx.agents.get(sessionId);
      if (agent && agent.status !== 'idle') throw new Error('Session is busy');
      const next = { ...settings, [sessionId]: { mode, persona, context } };
      mkdirSync(directory, { recursive: true });
      const temporary = `${filename}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      renameSync(temporary, filename);
      settings = next;
      if (agent) install(agent);
      return { configured: true };
    },
  };
}
