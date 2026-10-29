import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function installationRoot(profile = 'default', env = process.env) {
  const id = createHash('sha256').update(String(profile)).digest('hex').slice(0,16);
  return join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'CyreneDSH',id);
}
