/** Zero-dependency ANSI colors. Disabled when not a TTY or NO_COLOR is set. */
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ESC = '\x1b';

function wrap(open: number, close: number) {
  return (s: string) => (enabled ? `${ESC}[${open}m${s}${ESC}[${close}m` : s);
}

export const c = {
  enabled,
  // n8n brand pink via 256-color (≈ #FF5C8A → 204).
  pink: (s: string) => (enabled ? `${ESC}[38;5;204m${s}${ESC}[39m` : s),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  green: wrap(32, 39),
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  white: wrap(97, 39),
  gray: wrap(90, 39),
};

export const symbols = {
  ok: c.green('✓'),
  fail: c.red('✗'),
  dot: c.pink('•'),
  arrow: c.dim('↳'),
  bullet: c.dim('○'),
};
