import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Only explicit desktop transitions change the process-owned tray selection. */
export async function selectTrayDesktop(root, desktop) {
  if (!['dsh', 'cyrene'].includes(desktop)) throw Error('Invalid desktop');
  const record = JSON.parse(await readFile(join(root, '.local/tray-control.json'), 'utf8'));
  if (record.protocol !== 1 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
    || !/^[a-f0-9]{64}$/.test(record.token)) throw Error('Invalid tray descriptor');
  const response = await fetch(`http://127.0.0.1:${record.port}/select/${desktop}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${record.token}` },
  });
  if (!response.ok) throw Error('Tray desktop switch unavailable; restart DSH');
}
