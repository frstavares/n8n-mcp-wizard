import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const APPDATA = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
const XDG = process.env.XDG_CONFIG_HOME ?? join(home, '.config');

type OS = 'darwin' | 'win32' | 'linux';
function os(): OS {
  const p = platform();
  if (p === 'darwin') return 'darwin';
  if (p === 'win32') return 'win32';
  return 'linux';
}

function pick(map: Record<OS, string>): string {
  return map[os()];
}

/** Cursor — ~/.cursor/mcp.json (same on every OS). */
export function cursorConfigPath(): string {
  return join(home, '.cursor', 'mcp.json');
}

/** VS Code user MCP config. */
export function vscodeConfigPath(): string {
  return pick({
    darwin: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    win32: join(APPDATA, 'Code', 'User', 'mcp.json'),
    linux: join(XDG, 'Code', 'User', 'mcp.json'),
  });
}

/** Zed settings (no official Windows build). */
export function zedConfigPath(): string {
  return pick({
    darwin: join(home, '.config', 'zed', 'settings.json'),
    win32: join(APPDATA, 'Zed', 'settings.json'),
    linux: join(XDG, 'zed', 'settings.json'),
  });
}

/** Claude Desktop config (no official Linux build). */
export function claudeDesktopConfigPath(): string {
  return pick({
    darwin: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    win32: join(APPDATA, 'Claude', 'claude_desktop_config.json'),
    linux: join(XDG, 'Claude', 'claude_desktop_config.json'),
  });
}
