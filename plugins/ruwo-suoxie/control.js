import { readFile, access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { hideConfiguredDesktop } from './desktop-window.js';
import { selectTrayDesktop } from './tray-route.js';

/** Credentials remain in the host. Client receives only lifecycle status. */
export function createControl(root, dependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  const launch = dependencies.spawn ?? spawn;
  const read = dependencies.readFile ?? readFile;
  let launching;
  async function call(action, id) {
    const record = JSON.parse(await read(join(root, '.local/desktop-control.json'), 'utf8'));
    if (record.protocol !== 1 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
      || !/^[a-f0-9]{64}$/.test(record.token) || !Number.isInteger(record.pid)) throw new Error('Invalid control descriptor');
    const query = id === undefined ? '' : `?id=${encodeURIComponent(id)}`;
    const response = await fetcher(`http://127.0.0.1:${record.port}/${action}${query}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(['open', 'conversations', 'history', 'resolve', 'models-sync'].includes(action) ? 30000 : 2000),
      headers: { authorization: `Bearer ${record.token}` },
    });
    if (!response.ok) throw new Error('Control unavailable');
    const state = await response.json();
    if (action === 'conversations' || action === 'history' || action === 'resolve' || action === 'models-sync') return state;
    if (state.protocol !== 1 || state.pid !== record.pid || state.running !== true) throw new Error('Control identity mismatch');
    return { running: true };
  }
  return {
    async switch(_id, signal, options = {}) {
      let state = await this.open();
      const deadline = Date.now() + 30000;
      while (!state.running) {
        if (signal?.aborted || Date.now() >= deadline) throw new Error('Cyrene startup not ready');
        await new Promise(resolve => setTimeout(resolve, 500));
        state = await this.status();
        if (state.running) state = await call('open');
      }
      if (signal?.aborted) throw new Error('Switch cancelled');
      if (options.selectTray !== false) await (dependencies.selectTray ?? selectTrayDesktop)(root, 'cyrene');
      const desktopHidden = await (dependencies.hideDesktop ?? hideConfiguredDesktop)(signal);
      return { running: true, desktopHidden };
    },
    async syncModels() { return call("models-sync"); },
    async conversations() { return call('conversations'); },
    async resolve(id) {
      if (typeof id !== "string" || !id || id.length > 256) throw new Error("Invalid conversation identity");
      return call("resolve", id);
    },
    async history(id) {
      if (typeof id !== 'string' || !id || id.length > 256) throw new Error('Invalid conversation identity');
      return call('history', id);
    },
    async status() {
      try { return await call('status'); } catch { return { running: false }; }
    },
    async open() {
      if ((await this.status()).running) return call('open');
      if (launching) return launching;
      launching = (async () => {
        if (!isAbsolute(root)) throw new Error('请配置本机集成目录');
        const executable = join(root, 'cyrene/node_modules/electron/dist/electron.exe');
        await (dependencies.access ?? access)(executable);
        const env = { ...process.env, CYRENE_NEXT_ROOT: root, CYRENE_DSH_MANAGED: '1',
          CYRENE_USER_DATA: join(root, '.local/cyrene'), DSH_HOME: join(root, '.local/dsh') };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = launch(executable, [join(root, 'cyrene')], { cwd: join(root, 'cyrene'), env,
          detached: true, windowsHide: false, stdio: 'ignore', shell: false });
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
        child.unref();
        return { running: false, starting: true };
      })().finally(() => { launching = undefined; });
      return launching;
    },
    async quit() {
      if (!(await this.status()).running) return { running: false };
      await call('quit');
      return { running: true, stopping: true };
    },
  };
}
