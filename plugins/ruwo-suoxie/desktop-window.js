import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
/** Product window transition: matches only the installed DSH executable, never arbitrary PIDs. */
export async function hideConfiguredDesktop(signal) {
  if (process.platform !== 'win32') return false;
  const { stdout } = await execute('where.exe', ['dsh.cmd'], { windowsHide: true, timeout: 2000, signal });
  const cli = stdout.split(/\r?\n/).find(Boolean);
  if (!cli || !isAbsolute(cli)) throw new Error('Installed DSH not found');
  const executable = resolve(dirname(cli), '../../../../DeepSeek Harness.exe');
  const { stdout: result } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-File', fileURLToPath(new URL('./hide-desktop.ps1', import.meta.url)), '-Executable', executable],
  { windowsHide: true, timeout: 15000, signal });
  return result.trim() === 'hidden';
}
