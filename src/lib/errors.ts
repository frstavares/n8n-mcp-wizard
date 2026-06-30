/**
 * Typed, user-facing errors. Every failure carries a short message, an
 * actionable suggestion, and a process exit code for non-interactive runs.
 */
export type ErrorCode =
  | 'INVALID_URL'
  | 'UNREACHABLE'
  | 'MCP_DISABLED'
  | 'INVALID_API_KEY'
  | 'OAUTH_FAILED'
  | 'NO_CLIENTS'
  | 'CLIENT_WRITE_FAILED'
  | 'DEMO_FAILED'
  | 'MISSING_INPUT'
  | 'ABORTED'
  | 'UNKNOWN';

export class WizardError extends Error {
  readonly code: ErrorCode;
  /** One-line, actionable next step shown to the user. */
  readonly suggestion?: string;
  /** Process exit code for non-interactive mode. */
  readonly exitCode: number;
  /** Extra structured context (never contains secrets). */
  readonly context?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { suggestion?: string; exitCode?: number; context?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'WizardError';
    this.code = code;
    this.suggestion = opts.suggestion;
    this.exitCode = opts.exitCode ?? 1;
    this.context = opts.context;
  }
}

export function isWizardError(e: unknown): e is WizardError {
  return e instanceof WizardError;
}

/** Reduce any thrown value to a WizardError for uniform handling. */
export function toWizardError(e: unknown): WizardError {
  if (isWizardError(e)) return e;
  if (e instanceof Error) {
    return new WizardError('UNKNOWN', e.message);
  }
  return new WizardError('UNKNOWN', String(e));
}
