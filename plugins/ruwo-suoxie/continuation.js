import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

/** Durable admission receipts; the native controller owns queueing and execution. */
export function createContinuation(controller, root) {
  const locks = new Map();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
  async function read(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('Admission receipt unreadable'); }
  }
  async function write(file, value) {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async function operation(method, params, signal) {
    const sessionId = params?.sessionId;
    if (!id(sessionId)) throw new Error('Invalid session');
    const directory = join(root, '.local/desktop-continuations', hash(sessionId));
    const headFile = join(directory, 'head.json');
    const head = await read(headFile);
    const pending = head && await read(join(directory, `${hash(head.requestId)}.json`));
    if (method === 'continuationStatus') return { unknown: pending?.accepted === false };
    let requestId, text;
    if (method === 'retryContinuation') {
      if (!pending) return { accepted: false };
      if (pending.accepted) return { accepted: true };
      ({ requestId, text } = pending);
    } else {
      ({ requestId, text } = params);
      if (!id(requestId) || typeof text !== 'string' || !text.trim() || text.length > 32768) throw new Error('Invalid prompt');
      if (pending?.accepted === false && pending.requestId !== requestId) throw new Error('Retry the unconfirmed request first');
    }
    const filename = join(directory, `${hash(requestId)}.json`);
    const saved = await read(filename);
    if (saved && (saved.sessionId !== sessionId || saved.text !== text)) throw new Error('Request identity conflict');
    if (saved?.accepted) return { accepted: true };
    const receipt = { sessionId, requestId, text, accepted: false };
    await write(filename, receipt);
    await write(headFile, { requestId });
    // An unknown response is retried only with the same durable identity and body.
    await controller.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }, signal);
    await write(filename, { ...receipt, accepted: true });
    return { accepted: true };
  }
  return {
    async request(method, params, signal) {
      const sessionId = params?.sessionId;
      if (!id(sessionId)) throw new Error('Invalid session');
      const previous = locks.get(sessionId) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(() => operation(method, params, signal));
      locks.set(sessionId, next);
      try { return await next; }
      finally { if (locks.get(sessionId) === next) locks.delete(sessionId); }
    },
  };
}
