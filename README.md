# @n8n/mcp

Connect your n8n instance to your AI tools in **one command** — and start building workflows by chatting.

```bash
# Beta (runs straight from this repo, no install):
npx github:frstavares/n8n-mcp-wizard acme.app.n8n.cloud

# Future (npm):
npx @n8n/mcp acme.app.n8n.cloud
```

## What it does

1. **Verifies** your instance is reachable and that the MCP server is enabled.
2. **Authenticates** once — paste an API key (written into every tool, no copy-paste) or use per-tool browser OAuth.
3. **Configures all your AI clients** at once: Claude Code, Cursor, Claude Desktop, VS Code, Codex, Zed.
4. **Shows you what's possible** — sample prompts to send your first message.

## Usage

```
npx @n8n/mcp [url] [options]

Arguments:
  url                  your n8n instance URL (e.g. acme.app.n8n.cloud)

Options:
  --api-key <key>      MCP API key — written as Bearer into every client config
  --client <ids...>    only configure these (claude-code, cursor, claude-desktop, vscode, codex, zed)
  -y, --yes            accept defaults, no prompts (CI / scripted)
  --no-demo            skip the first-message demo
  -h, --help           show help
```

**Non-interactive example** (CI / scripted):

```bash
npx @n8n/mcp https://acme.app.n8n.cloud --api-key "$N8N_MCP_KEY" --yes
```

**Uninstall** — remove the n8n MCP server from your tools:

```bash
npx @n8n/mcp remove                 # all detected tools
npx @n8n/mcp remove --client cursor # just one
```

## Requirements

- Node.js ≥ 18
- An n8n instance with the **MCP server enabled** (`N8N_MCP_ACCESS_ENABLED=true`, or enabled by an admin in Settings).
- Get an API key at `https://<your-instance>/settings/mcp`.

## Auth modes

- **API key (recommended):** one key, written as `Authorization: Bearer` into every client config — everything works immediately, no per-tool copy-paste.
- **OAuth:** the wizard writes only the URL; each tool runs its own n8n login on first use. The wizard prints per-client instructions.

## Status

Early beta. Working today: instance checks, API-key auth + validation, config writers for the four clients, the discovery/sample-prompt step, and full error handling (MCP-not-enabled, unreachable, no clients detected, per-client write failures). In progress: the full-screen interactive TUI, browser OAuth, and the live LLM-driven demo. Telemetry is planned but not yet shipped.

## Develop

```bash
npm install
npm run build      # bundle to dist/cli.js
npm run typecheck
npm test
node dist/cli.js --help
```

## License

MIT
