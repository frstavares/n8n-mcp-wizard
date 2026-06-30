import { Command } from 'commander';
import { c, symbols } from './lib/util/colors.js';
import { WizardError, toWizardError } from './lib/errors.js';
import { checkInstance, ensureValidKey } from './lib/flow.js';
import {
  ALL_CLIENTS,
  clientUsage,
  configureClients,
  detectClients,
  getClient,
  manualSnippet,
  removeFromClients,
  type ClientDef,
  type ClientId,
  type ClientWriteResult,
} from './lib/clients/index.js';
import { resolveProvider, runDemo, suggestPrompts, SAMPLE_PROMPTS, type DemoEvent } from './lib/demo/index.js';
import { renderMarkdown } from './lib/util/markdown.js';
import { runInk } from './ui/app.js';

const VERSION = '0.1.0';

const BANNER = c.pink(`         ___
 _ __   ( _ )  _ __
| '_ \\  / _ \\ | '_ \\
| | | || (_) || | | |
|_| |_| \\___/ |_| |_|`);

interface Options {
  apiKey?: string;
  client?: string[];
  yes?: boolean;
  demo: boolean;
}

function isInteractive(opts: Options): boolean {
  if (opts.yes) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}

function line(s = '') {
  process.stdout.write(s + '\n');
}

async function main() {
  const program = new Command();
  program
    .name('@n8n/mcp-wizard')
    .description('Connect your n8n instance to your AI tools in one command.')
    .version(VERSION)
    .argument('[url]', 'your n8n instance URL (e.g. acme.app.n8n.cloud)')
    .option('--api-key <key>', 'MCP API key (written as Bearer into every client config)')
    .option('--client <ids...>', `only configure these clients (${ALL_CLIENTS.map((x) => x.id).join(', ')})`)
    .option('-y, --yes', 'accept defaults, no prompts (CI / scripted)')
    .option('--no-demo', 'skip the first-message demo')
    .addHelpText(
      'after',
      `
Examples:
  npx @n8n/mcp-wizard                                  interactive — asks for everything
  npx @n8n/mcp-wizard acme.app.n8n.cloud               start from your instance URL
  npx @n8n/mcp-wizard acme.app.n8n.cloud --api-key K   non-interactive (every tool works at once)
  npx @n8n/mcp-wizard <url> --client cursor claude-code   only these tools
  npx @n8n/mcp-wizard remove                           uninstall the n8n MCP server from your tools
`,
    )
    .action((url, opts) => run(url, opts as Options));

  await program.parseAsync();
}

async function runRemove(clientIds?: string[]) {
  line();
  line(BANNER);
  line();
  const targets = clientIds?.length
    ? clientIds.map((id) => {
        const def = getClient(id as ClientId);
        if (!def) throw new WizardError('MISSING_INPUT', `Unknown client "${id}".`, { suggestion: `Valid: ${ALL_CLIENTS.map((x) => x.id).join(', ')}` });
        return def;
      })
    : await detectClients();
  if (!targets.length) {
    line(`  ${c.yellow('No AI clients detected.')}`);
    line();
    return;
  }
  line(`  ${c.dim('Removing the n8n MCP server…')}`);
  const results = await removeFromClients(targets);
  for (const r of results) {
    if (r.ok) line(`  ${symbols.ok} ${pad(r.label, 16)}${c.dim(r.detail ?? 'removed')}`);
    else if (r.detail === 'not configured') line(`  ${c.gray('○')} ${pad(r.label, 16)}${c.dim('not configured')}`);
    else line(`  ${symbols.fail} ${pad(r.label, 16)}${c.dim(r.error ?? 'failed')}`);
  }
  line();
}

async function run(urlArg: string | undefined, opts: Options) {
  if (urlArg === 'remove') {
    await runRemove(opts.client);
    return;
  }
  if (isInteractive(opts)) {
    // The TUI asks for the URL itself (first Connect step) when not provided.
    const code = await runInk({ initialUrl: urlArg ?? '', apiKeyArg: opts.apiKey, clientIds: opts.client, demo: opts.demo });
    process.exit(code);
  }
  await runNonInteractive(urlArg, opts);
}

/* ------------- non-interactive (CI / scripted / piped) ------------- */
async function runNonInteractive(urlArg: string | undefined, opts: Options) {
  line();
  line(BANNER);
  line(`${c.dim(`@n8n/mcp-wizard v${VERSION}`)} ${c.dim('· connect n8n to your AI tools')}`);
  line();

  if (!urlArg) {
    throw new WizardError('MISSING_INPUT', 'No instance URL provided.', {
      suggestion: 'Pass it as an argument: npx @n8n/mcp-wizard <your-instance-url>',
    });
  }

  line(`  ${c.dim('Checking')} ${c.blue(urlArg)} …`);
  const { url, mcpUrl } = await checkInstance(urlArg);
  line(`  ${symbols.ok} Reachable, MCP server enabled`);

  const writeKey = opts.apiKey;
  const demoToken = opts.apiKey;
  const authMode: 'api-key' | 'oauth' = writeKey ? 'api-key' : 'oauth';
  if (writeKey) {
    await ensureValidKey(url, writeKey);
    line(`  ${symbols.ok} API key accepted`);
  }

  const targets = await resolveTargets(opts);
  let okClients: ClientWriteResult[] = [];
  if (targets.length === 0) {
    line();
    line(`  ${c.yellow('No supported AI client detected.')}`);
    line(`  ${c.dim('Add this MCP server manually:')}`);
    line(indent(manualSnippet({ mcpUrl, apiKey: writeKey })));
  } else {
    line();
    line(`  ${c.dim(`Configuring ${targets.length} client${targets.length > 1 ? 's' : ''}…`)}`);
    const results = await configureClients(targets, { mcpUrl, apiKey: writeKey });
    reportResults(results);
    // already-configured (re-run) counts as connected, not "no client".
    okClients = results.filter((r) => r.ok || r.error === 'already-exists');
  }

  if (opts.demo) {
    line();
    line(`  ${c.pink('─── First message ───')}`);
    const provider = await resolveProvider(demoToken);
    const prompts = await suggestPrompts(url, demoToken);
    const prompt = (prompts[0] ?? SAMPLE_PROMPTS[0])!.text;
    await runDemo({ provider, instanceBaseUrl: url, token: demoToken, prompt, onEvent: printDemoEvent });
  }

  printOnboarding(okClients, authMode);
  printNextSteps();
}

async function resolveTargets(opts: Options): Promise<ClientDef[]> {
  if (opts.client && opts.client.length) {
    return opts.client.map((id) => {
      const def = getClient(id as ClientId);
      if (!def) {
        throw new WizardError('MISSING_INPUT', `Unknown client "${id}".`, {
          suggestion: `Valid: ${ALL_CLIENTS.map((x) => x.id).join(', ')}`,
        });
      }
      return def;
    });
  }
  // Auto-configure detected clients, but not opt-in browser connectors (claude.ai).
  return (await detectClients()).filter((d) => d.autoSelect !== false);
}

function reportResults(results: ClientWriteResult[]) {
  for (const r of results) {
    if (r.ok) line(`  ${symbols.ok} ${pad(r.label, 16)}${c.dim(r.detail ?? '')}`);
    else if (r.error === 'already-exists') line(`  ${c.yellow('•')} ${pad(r.label, 16)}${c.dim('already configured (skipped)')}`);
    else {
      line(`  ${symbols.fail} ${pad(r.label, 16)}${c.dim(r.error ?? 'failed')}`);
      if (r.manual) line(indent(c.dim(r.manual)));
    }
  }
}

function printOnboarding(ok: ClientWriteResult[], authMode: 'api-key' | 'oauth') {
  if (!ok.length) return;
  line();
  line(`  ${c.bold(authMode === 'oauth' ? 'Sign in to n8n the first time you open each tool:' : 'Ready to use — just start chatting in:')}`);
  for (const r of ok) line(`  ${symbols.dot} ${c.white(r.label)} ${c.dim('— ' + clientUsage(r.id, true))}`);
}

function printDemoEvent(e: DemoEvent) {
  switch (e.type) {
    case 'prompt':
      return line(`  ${c.blue('›')} ${c.white(`"${e.text}"`)}`);
    case 'tool':
      return line(`  ${symbols.arrow} ${c.pink(e.name)}`);
    case 'tool-done':
      return line(`  ${symbols.arrow} ${c.pink(e.name)} ${symbols.ok}`);
    case 'text':
      return line(`  ${c.dim(e.text)}`);
    case 'result':
      return line(indent(renderMarkdown(e.text)));
    case 'error':
      return line(`  ${c.yellow(e.message)}`);
  }
}

function printNextSteps() {
  line();
  line(`  ${c.green("You're connected.")} ${c.dim('Docs:')} https://docs.n8n.io/mcp`);
  line();
}

function pad(s: string, n: number): string {
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}
function indent(s: string): string {
  return s.split('\n').map((l) => '    ' + l).join('\n');
}

main().catch((e) => {
  const err = toWizardError(e);
  line();
  line(`  ${symbols.fail} ${c.red(err.message)}`);
  if (err.suggestion) line(`    ${c.dim(err.suggestion)}`);
  line();
  process.exit(err.exitCode);
});
