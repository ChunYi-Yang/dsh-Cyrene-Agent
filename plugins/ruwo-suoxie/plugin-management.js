import { createPluginSettings } from './plugin-settings.js';
/** Fixed operations on the existing profile manager; no shell or arbitrary RPC. */
export function createPluginManagement(ctx) {
  const settings = createPluginSettings(ctx);
  const self = plugin => plugin.moduleName === '@cyrene/ruwo-suoxie'
    || plugin.entryId === ctx.fiber?.entry?.id;
  return async params => {
    if (['configCatalog', 'readConfig', 'writeConfig'].includes(params.action)) return settings(params);
    const manager = ctx.get('pluginManager');
    if (!manager) throw Error('plugin management unavailable');
    if (params.action === 'list') {
      const [plugins, bundles] = await Promise.all([manager.listPlugins(), manager.listBundles()]);
      const builtin = b => b.availability === 'installation' || (b.official === true && b.installed !== true && b.availability === 'missing');
      const owner = p => bundles.find(b => (b.rows ?? []).some(row => row.entryId === p.entryId || row.rowId === p.entryId));
      return {
        plugins: plugins.map(p => ({ id: p.entryId, name: p.moduleName, enabled: p.enabled,
          phase: p.fiberPhase, builtin: owner(p) ? builtin(owner(p)) : p.moduleName?.startsWith('@deepseek-ai/'), readOnly: Boolean(p.readOnlyReason) || self(p) })),
        bundles: bundles.map(b => ({ name: b.name, version: b.version, description: b.description,
          builtin: builtin(b), configurationTargets: [...new Set((b.rows ?? []).flatMap(row => [row.entryId, row.rowId, row.moduleName]).filter(Boolean))],
          enabled: b.enabled, available: b.availability !== 'missing', readOnly: Boolean(b.readOnlyReason) || b.name === '@cyrene/ruwo-suoxie' })),
      };
    }
    let result;
    if (['setPluginEnabled', 'setBundleEnabled'].includes(params.action)) {
      if (typeof params.enabled !== 'boolean' || typeof params.id !== 'string' || params.id.length > 512) throw Error('invalid target');
      if (params.action === 'setPluginEnabled') {
        const target = (await manager.listPlugins()).find(p => p.entryId === params.id);
        if (!target || target.readOnlyReason || self(target)) throw Error('protected plugin');
      } else {
        const target = (await manager.listBundles()).find(b => b.name === params.id);
        if (!target || target.readOnlyReason || target.name === '@cyrene/ruwo-suoxie') throw Error('protected bundle');
      }
      result = await manager[params.action](params.id, params.enabled);
    } else if (params.action === 'installBundle') {
      // Registry package names and explicit semver/tag only; no URLs, local paths or executable arguments.
      if (typeof params.spec !== 'string' || params.spec.length > 256
        || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9.+_-]*)?$/.test(params.spec)) throw Error('invalid registry package');
      result = await manager.installBundle(params.spec);
    } else throw Error('unsupported operation');
    // Do not expose native package logs, filesystem paths or external diagnostics.
    return { changed: result.changed, application: result.application,
      error: result.error?.code, restartReason: result.restartReason };
  };
}
