/** Native configuration port. Reads use DSH's redacted view; writes never replace whole sections. */
export function createPluginSettings(ctx) {
  const controller = () => {
    const service = ctx.get('settingsController');
    if (!service) throw Error('native settings unavailable');
    return service;
  };
  const entries = () => new Map((ctx.get('configEditor')?.entries() ?? []).map(entry => [entry.options.id, entry.options.name]));
  const describe = () => controller().describe();
  const view = (data, namespace) => ({ writable: data.writable, ...namespace, schema: configurationSchema(namespace.schema) });
  return async params => {
    const data = describe();
    const names = entries();
    const editor=ctx.get('configEditor');
    const profileEntries=(editor?.entries()??[]).filter(entry=>entry.options.name!=='@cyrene/ruwo-suoxie'&&entry.options.id!==ctx.fiber?.entry?.options?.id);
    const profiles=profileEntries.flatMap(entry=>{try{const item=profileConfiguration(entry);return item?[item]:[];}catch{return[];}});
    const namespaces = [...data.namespaces.filter(item => names.get(item.ns) !== '@cyrene/ruwo-suoxie').map(item=>({...item,mode:'live'})),...profiles];
    if (params.action === 'configCatalog') return { writable: data.writable, items: namespaces.map(item => ({
      id: item.ns, name: names.get(item.ns.replace(/^profile:/,'')) ?? item.ns, revision: item.revision, customPage: !item.autoGenerate, mode:item.mode,
    })) };
    if (typeof params.id !== 'string' || params.id.length > 512) throw Error('invalid configuration');
    const current = namespaces.find(item => item.ns === params.id);
    if (!current) throw Error('configuration unavailable');
    if (params.action === 'readConfig') return view(data, current);
    if (params.action !== 'writeConfig' || !data.writable || !Number.isSafeInteger(params.revision)
      || !Array.isArray(params.ops) || !params.ops.length || params.ops.length > 200) throw Error('invalid edits');
    if(current.revision!==params.revision)return {saved:false,error:'conflict'};
    for (const op of params.ops) {
      if (!['set', 'unset'].includes(op?.op) || !Array.isArray(op.path) || !op.path.length || op.path.length > 32
        || op.path.some(key => typeof key !== 'string' || !key.length || key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key))) throw Error('invalid edit path');
      // A redacted parent cannot be sent back wholesale: it would delete the secrets we never read.
      for (const secret of current.secrets ?? []) {
        if (op.path.length < secret.path.length && op.path.every((key, index) => secret.path[index] === key)) throw Error('secret parent replacement refused');
      }
    }
    if (JSON.stringify(params.ops).length > 512 * 1024) throw Error('edits too large');
    if(current.mode==='reload')return {writable:data.writable,...await writeProfileConfiguration(editor,profileEntries.find(entry=>'profile:'+entry.options.id===current.ns),params.revision,params.ops)};
    try {
      const result = await controller().mutate(params.id, params.ops, params.revision);
      return { saved: true, ...view(data, result) };
    } catch (error) {
      // Host validation errors may contain a submitted secret. Return a fixed vocabulary only.
      return { saved: false, error: error?.code === 'settings/conflict' || error?.code === 'SETTINGS_CONFLICT' ? 'conflict' : 'rejected' };
    }
  };
}
import { profileConfiguration, writeProfileConfiguration } from './profile-settings.js';
import { configurationSchema } from './schema-bridge.js';
