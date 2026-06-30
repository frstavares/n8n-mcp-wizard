import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/**
 * Cross-platform check for whether an executable is on PATH.
 * Avoids spawning the process (fast, safe).
 */
export async function commandExists(cmd: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        await access(candidate, constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}
