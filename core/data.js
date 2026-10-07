import { fileURLToPath } from 'node:url';
import { resolve, join, relative, isAbsolute } from 'node:path';

export const DATA_ROOT = resolve(process.env.RJ_DATA || fileURLToPath(new URL('../data', import.meta.url)));
// Internal store names only. Request parameters must never select filesystem paths.
export function dataPath(...parts) {
  const path = join(DATA_ROOT, ...parts);
  const rel = relative(DATA_ROOT, path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('data path outside root');
  return path;
}
