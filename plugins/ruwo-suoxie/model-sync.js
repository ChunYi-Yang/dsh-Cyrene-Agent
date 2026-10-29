import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const protocols = { openai: 'openai-completions', responses: 'openai-responses', anthropic: 'anthropic-messages' };

/** Only this host receives independent API keys. Responses contain route references only. */
export function createModelImporter(ctx, root) {
  let tail = Promise.resolve();
  return params => {
    const result = tail.then(() => synchronize(params));
    tail = result.catch(() => {});
    return result;
  };
  async function synchronize(params) {
    if (!Array.isArray(params.profiles) || params.profiles.length > 1000) throw Error('invalid models');
    const settings = ctx.get('settings'), credentials = ctx.get('credentials'), editor = ctx.get('configEditor');
    if (!settings || !credentials || !editor) throw Error('native configuration unavailable');
    const entries = editor.entries().filter(entry => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai');
    if (entries.length !== 1) throw Error('native adapter ambiguous or unavailable');
    const ns = entries[0].options.id;
    const file = join(root, '.local/model-sync-ownership.json');
    let owned = {};
    try { owned = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('invalid ownership record'); }
    const routes = [], conflicts = [];
    for (const input of params.profiles) {
      if (!input || typeof input.id !== 'string' || input.id.length > 256 || typeof input.model !== 'string'
        || !input.model.trim() || input.model.length > 512 || typeof input.apiKey !== 'string' || !input.apiKey.trim()
        || input.apiKey.length > 65536 || !Object.hasOwn(protocols, input.transport)) throw Error('invalid model');
      const endpoint = new URL(input.baseUrl);
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('invalid endpoint');
      const api = protocols[input.transport], baseURL = endpoint.href.replace(/\/$/, '');
      const provider = `cyrene-${hash([baseURL, api, input.model]).slice(0, 24)}`;
      const ref = `CYRENE_MODEL_${provider.slice(7).toUpperCase()}`;
      const route = { displayName: typeof input.name === 'string' ? input.name.slice(0, 200) : 'Cyrene',
        api, baseURL, apiKeyEnv: ref, models: [{ id: input.model }] };
      const descriptor = settings.describe({ redactSecrets: true }).find(item => item.ns === ns);
      if (!descriptor) throw Error('native adapter unavailable');
      const current = descriptor.value?.providers?.[provider];
      const existingKey = await credentials.resolve(ref);
      const previous = owned[provider];
      // Compare our prior write with the current values. A native edit wins.
      // Settings add defaults on read, so compare just the fields we own.
      const ownedRoute = current && previous && hash(current) === previous.route;
      const sameRoute = ownedRoute && previous.request === hash(route);
      if ((current && !ownedRoute)
        || (existingKey && existingKey.value !== input.apiKey && (!previous || hash(existingKey.value) !== previous.key))) {
        conflicts.push(input.id); continue;
      }
      // A failed settings write may leave our own credential; retry is safe.
      if (!existingKey || existingKey.value !== input.apiKey) await credentials.set(ref, input.apiKey);
      if (!sameRoute) await settings.mutate(ns, [{ op: 'set', path: ['providers', provider], value: route }], descriptor.revision);
      const saved = settings.describe({ redactSecrets: true }).find(item => item.ns === ns)?.value?.providers?.[provider];
      owned[provider] = { route: hash(saved), request: hash(route), key: hash(input.apiKey) };
      await mkdir(join(root, '.local'), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(owned), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      routes.push({ id: input.id, model: input.model, provider });
    }
    return { routes, conflicts };
  }
}
