import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Static, Text, render, useApp, useInput } from 'ink';
import { Spinner, MultiSelect, TextInput } from '@inkjs/ui';
import { toWizardError, type WizardError } from '../lib/errors.js';
import { checkInstance, ensureValidKey, type CheckedInstance } from '../lib/flow.js';
import {
  ALL_CLIENTS,
  clientUsage,
  configureClients,
  detectClients,
  getClient,
  manualSnippet,
  type ClientDef,
  type ClientId,
  type ClientWriteResult,
} from '../lib/clients/index.js';
import { authorize } from '../lib/auth/oauth.js';
import { availableAgents, runDemo, suggestPrompts, type DemoAgent, type DemoEvent, type DemoProvider } from '../lib/demo/index.js';
import { c, symbols } from '../lib/util/colors.js';
import { stripMarkdown } from '../lib/util/markdown.js';

const PINK = '#FF5C8A';
const GREEN = '#46D160';
const BLUE = '#74A7FF';
const PURPLE = '#C3A6FF';

// Reserved body height so short steps don't collapse the layout.
const BODY_MIN_HEIGHT = 10;

/** Display names for the demo agents. */
const AGENT_LABELS: Record<DemoAgent, string> = { claude: 'Claude', codex: 'Codex' };

interface SelOption {
  label: string;
  description?: string;
  value: string;
  recommended?: boolean;
}

/**
 * Custom single-select so we control coloring: focused label is bright, the
 * description is always dim (never the same white), with a "- description" tail.
 */
export function SelectList({ options, onSelect }: { options: SelOption[]; onSelect: (value: string) => void }) {
  const [i, setI] = useState(0);
  useInput((_input, key) => {
    if (key.downArrow) setI((p) => (p + 1) % options.length);
    else if (key.upArrow) setI((p) => (p - 1 + options.length) % options.length);
    else if (key.return) {
      const o = options[i];
      if (o) onSelect(o.value);
    }
  });
  return (
    <Box flexDirection="column">
      {options.map((o, idx) => {
        const focused = idx === i;
        return (
          <Box key={o.value}>
            <Text color={PINK}>{focused ? '❯ ' : '  '}</Text>
            <Text color={focused ? 'white' : undefined} bold={focused}>
              {o.label}
            </Text>
            {o.recommended ? <Text color={GREEN}> (recommended)</Text> : null}
            {o.description ? <Text color="gray"> - {o.description}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

const STEPS = ['Connect', 'Authorize', 'Clients', 'Build', 'Done'] as const;
const BANNER = `         ___
 _ __   ( _ )  _ __
| '_ \\  / _ \\ | '_ \\
| | | || (_) || | | |
|_| |_| \\___/ |_| |_|`;

type Stage =
  | 'askUrl'
  | 'connecting'
  | 'authChoice'
  | 'apiKeyInput'
  | 'oauthRunning'
  | 'validating'
  | 'detecting'
  | 'selectClients'
  | 'configuring'
  | 'demoSelect'
  | 'demoPrompts'
  | 'demoRunning'
  | 'demoFollowup'
  | 'done'
  | 'error';

const STEP_OF: Record<Stage, number> = {
  askUrl: 0,
  connecting: 0,
  authChoice: 1,
  apiKeyInput: 1,
  oauthRunning: 1,
  validating: 1,
  detecting: 2,
  selectClients: 2,
  configuring: 2,
  demoSelect: 3,
  demoPrompts: 3,
  demoRunning: 3,
  demoFollowup: 3,
  done: 4,
  error: 4,
};

const EYEBROW: Partial<Record<Stage, string>> = {
  askUrl: 'STEP 1 / 5 · CONNECT',
  connecting: 'STEP 1 / 5 · CONNECT',
  authChoice: 'STEP 2 / 5 · AUTHORIZE',
  apiKeyInput: 'STEP 2 / 5 · AUTHORIZE',
  oauthRunning: 'STEP 2 / 5 · AUTHORIZE',
  validating: 'STEP 2 / 5 · AUTHORIZE',
  detecting: 'STEP 3 / 5 · CLIENTS',
  selectClients: 'STEP 3 / 5 · CLIENTS',
  configuring: 'STEP 3 / 5 · CLIENTS',
  demoSelect: 'STEP 4 / 5 · YOUR FIRST AUTOMATION',
  demoPrompts: 'STEP 4 / 5 · YOUR FIRST AUTOMATION',
  demoRunning: 'STEP 4 / 5 · YOUR FIRST AUTOMATION',
  demoFollowup: 'STEP 4 / 5 · YOUR FIRST AUTOMATION',
  done: 'ALL SET',
};

function StepTracker({ active, done }: { active: number; done: boolean }) {
  return (
    <Box>
      {STEPS.map((s, i) => {
        const isDone = done || i < active;
        const isActive = !done && i === active;
        const color = isActive ? PINK : isDone ? GREEN : 'gray';
        return (
          <Text key={s} color={color}>
            {i > 0 ? <Text color="gray"> ── </Text> : ''}
            {isDone ? '✓' : i + 1} {s}
          </Text>
        );
      })}
    </Box>
  );
}

interface AppProps {
  initialUrl: string;
  apiKeyArg?: string;
  clientIds?: string[];
  demo: boolean;
  /** summary is printed to the normal buffer after the alt-screen is torn down. */
  onExit: (code: number, summary: string) => void;
}

export function App({ initialUrl, apiKeyArg, clientIds, demo, onExit }: AppProps) {
  const { exit } = useApp();

  const [stage, setStage] = useState<Stage>(initialUrl ? 'connecting' : 'askUrl');
  const [url, setUrl] = useState(initialUrl);
  const [checked, setChecked] = useState<CheckedInstance | null>(null);
  const [writeKey, setWriteKey] = useState<string | undefined>(apiKeyArg);
  const [demoToken, setDemoToken] = useState<string | undefined>(apiKeyArg);
  const [authMode, setAuthMode] = useState<'api-key' | 'oauth'>(apiKeyArg ? 'api-key' : 'oauth');
  const [detected, setDetected] = useState<ClientDef[]>([]);
  const [installed, setInstalled] = useState<ClientDef[]>([]);
  const [results, setResults] = useState<ClientWriteResult[]>([]);
  const [suggestions, setSuggestions] = useState<{ id: string; text: string }[]>([]);
  const [provider, setProvider] = useState<DemoProvider>({ kind: 'none' });
  const [agents, setAgents] = useState<DemoAgent[]>([]); // agents available to drive the demo
  const [demoPrompt, setDemoPrompt] = useState('');
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [continueSession, setContinueSession] = useState(false); // follow-up turn in the chat
  // Live text buffer for the agent's currently-streaming reply (committed on flush).
  const liveRef = useRef('');
  const [live, setLive] = useState('');
  const [oauthUrl, setOauthUrl] = useState('');
  const [lines, setLines] = useState<ReactNode[]>([]);
  const [error, setError] = useState<WizardError | null>(null);

  const addLine = (n: ReactNode) => setLines((l) => [...l, n]);
  const fail = (e: unknown) => {
    setError(toWizardError(e));
    setStage('error');
  };
  const goto = (s: Stage) => {
    setLines([]);
    setStage(s);
  };

  // 1 — connect
  useEffect(() => {
    if (stage !== 'connecting') return;
    let off = false;
    (async () => {
      try {
        const c = await checkInstance(url);
        if (off) return;
        setChecked(c);
        addLine(<Text key="r"><Text color={GREEN}>✓</Text> Reachable, MCP server enabled</Text>);
        setTimeout(() => !off && goto(apiKeyArg ? 'validating' : 'authChoice'), 700);
      } catch (e) {
        if (!off) fail(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [stage]);

  // 2 — validate key
  useEffect(() => {
    if (stage !== 'validating' || !checked || !demoToken) return;
    let off = false;
    (async () => {
      try {
        await ensureValidKey(checked.url, demoToken);
        if (off) return;
        addLine(<Text key="k"><Text color={GREEN}>✓</Text> API key accepted</Text>);
        setTimeout(() => !off && goto('detecting'), 600);
      } catch (e) {
        if (!off) fail(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [stage, checked, demoToken]);

  // 2 — oauth
  useEffect(() => {
    if (stage !== 'oauthRunning' || !checked) return;
    let off = false;
    (async () => {
      try {
        const res = await authorize(checked.url, {
          onUrl: (u) => setOauthUrl(u),
          openBrowser: (u) => import('open').then((m) => m.default(u)),
        });
        if (off) return;
        // OAuth mode is token-less in the written configs: an OAuth access token
        // expires and can't be refreshed from a static header, so each tool runs
        // its own (refresh-capable) n8n sign-in on first connect. We keep the token
        // only in-memory, to drive the live demo this session.
        setDemoToken(res.accessToken);
        setAuthMode('oauth');
        addLine(<Text key="o"><Text color={GREEN}>✓</Text> Authorized in browser</Text>);
        setTimeout(() => !off && goto('detecting'), 600);
      } catch (e) {
        if (!off) fail(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [stage, checked]);

  // 3 — detect
  useEffect(() => {
    if (stage !== 'detecting') return;
    let off = false;
    (async () => {
      try {
        if (clientIds && clientIds.length) {
          setDetected(clientIds.map((id) => getClient(id as ClientId)).filter(Boolean) as ClientDef[]);
          if (!off) goto('configuring');
          return;
        }
        const found = await detectClients();
        if (off) return;
        setInstalled(found);
        // Always show the picker with ALL clients — detected ones pre-checked, the
        // rest available (so detection misses / not-yet-installed tools aren't hidden).
        goto('selectClients');
      } catch (e) {
        if (!off) fail(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [stage]);

  // 3 — configure
  useEffect(() => {
    if (stage !== 'configuring' || !checked) return;
    let off = false;
    // After writing configs, offer the live demo ONLY if an agent (Claude Code or
    // Codex) is installed — it drives the user's own agent. Otherwise skip to Done.
    const advance = async () => {
      const ags = await availableAgents(demoToken).catch(() => [] as DemoAgent[]);
      if (off) return;
      setAgents(ags);
      if (ags[0]) setProvider({ kind: 'agent-sdk', agent: ags[0] });
      goto(demo && ags.length ? 'demoSelect' : 'done');
    };
    (async () => {
      try {
        if (detected.length === 0) {
          // The manual config snippet is shown on the Done screen — don't duplicate it here.
          addLine(<Text key="nc" color="yellow">No supported AI client detected — I'll show the manual setup at the end.</Text>);
          setTimeout(() => !off && advance(), 1500);
          return;
        }
        const res = await configureClients(detected, { mcpUrl: checked.mcpUrl, apiKey: writeKey });
        if (off) return;
        setResults(res);
        res.forEach((r) => addLine(resultLine(r)));
        setTimeout(() => !off && advance(), 1100);
      } catch (e) {
        if (!off) fail(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [stage, checked, detected]);

  // 4 — adaptive sample prompts (provider was resolved in the configure step)
  useEffect(() => {
    if (stage !== 'demoSelect' || !checked) return;
    let off = false;
    (async () => {
      const prompts = await suggestPrompts(checked.url, demoToken).catch(() => []);
      if (!off) setSuggestions(prompts);
    })();
    return () => {
      off = true;
    };
  }, [stage, checked, demoToken]);

  // 4 — run the demo turn (drive the user's agent, stream the reply)
  useEffect(() => {
    if (stage !== 'demoRunning' || !checked) return;
    let off = false;
    if (!continueSession) setEvents([]); // first turn clears; follow-ups keep the transcript
    liveRef.current = '';
    setLive('');
    const commitLive = () => {
      const t = liveRef.current.trim();
      if (t) setEvents((ev) => [...ev, { type: 'text', text: t }]);
      liveRef.current = '';
      setLive('');
    };
    const handle = (e: DemoEvent) => {
      if (off) return;
      if (e.type === 'delta') {
        if (e.kind === 'text') {
          liveRef.current += e.text;
          setLive(liveRef.current);
        }
        return; // thinking deltas are dropped — keep the demo output clean
      }
      if (e.type === 'flush') {
        commitLive();
        return;
      }
      commitLive(); // any concrete event ends the current streaming block
      setEvents((ev) => [...ev, e]);
    };

    (async () => {
      try {
        await runDemo({ provider, instanceBaseUrl: checked.url, token: demoToken, prompt: demoPrompt, continueSession, onEvent: handle });
      } catch {
        if (!off) setEvents((prev) => [...prev, { type: 'error', message: 'That run could not finish, but your tools are configured.' }]);
      } finally {
        if (off) return;
        commitLive();
        // Hand back to the user: reply to keep going, or finish. We only reach Done
        // when they choose to (in demoFollowup) — never auto-advance over the answer.
        setStage('demoFollowup');
      }
    })();
    return () => {
      off = true;
    };
  }, [stage, checked]);

  // chat follow-up — esc finishes the conversation and moves to the wrap-up.
  useInput(
    (_input, key) => {
      if (key.escape) setStage('done');
    },
    { isActive: stage === 'demoFollowup' },
  );

  // done / error — wait for Enter, then tear down the alt-screen and hand a
  // persistent summary back to the normal buffer (so onboarding/errors survive).
  const finalize = (code: number) => {
    onExit(code, code === 0 ? buildDoneSummary() : buildErrorSummary());
    exit();
  };
  useInput(
    (_input, key) => {
      if (key.return) finalize(stage === 'error' ? (error?.exitCode ?? 1) : 0);
    },
    { isActive: stage === 'done' || stage === 'error' },
  );

  function buildDoneSummary(): string {
    const ok = results.filter(isConfigured);
    const oauth = authMode === 'oauth';
    const out = [`  ${c.green("🎉 You're connected.")}`];
    if (ok.length) {
      // API key is written into every config (works immediately). OAuth mode is
      // token-less, so each tool runs its own n8n sign-in the first time you open it.
      out.push('', `  ${oauth ? 'Sign in to n8n the first time you open each tool:' : 'Ready to use — just start chatting in:'}`);
      for (const r of ok) out.push(`  ${c.pink('•')} ${c.white(r.label)} ${c.dim('— ' + clientUsage(r.id, !oauth))}`);
    } else if (checked) {
      const snippet = manualSnippet({ mcpUrl: checked.mcpUrl, apiKey: writeKey });
      out.push('', `  ${c.yellow('No AI client detected — add the n8n MCP server manually:')}`, c.dim(snippet.split('\n').map((l) => '  ' + l).join('\n')));
    }
    out.push('', `  ${c.dim('Docs:')} https://docs.n8n.io/connect/connect-to-n8n-mcp-server`);
    return out.join('\n');
  }
  function buildErrorSummary(): string {
    const out = [`  ${symbols.fail} ${c.red(error?.message ?? 'Setup failed')}`];
    if (error?.suggestion) out.push(`    ${c.dim(error.suggestion)}`);
    return out.join('\n');
  }

  const active = STEP_OF[stage];
  const showTracker = stage !== 'error'; // keep the tracker on the "ALL SET" / Done step too

  // Demo + wrap-up are one persistent chat: the transcript lives in <Static> (never
  // cleared), and we advance to the wrap-up only when the user finishes.
  if (stage === 'demoRunning' || stage === 'demoFollowup' || stage === 'done') {
    const running = stage === 'demoRunning';
    const onDone = stage === 'done';
    const oauth = authMode === 'oauth';
    const ok = results.filter(isConfigured);
    const host = (() => {
      try {
        return checked ? new URL(checked.url).host : '';
      } catch {
        return checked?.url ?? '';
      }
    })();
    const header = (
      <Box key="__chat-header" flexDirection="column" alignItems="center" paddingX={2}>
        <Text color={PINK}>{BANNER}</Text>
        <Box marginTop={1}>
          <StepTracker active={STEP_OF[stage]} done={onDone} />
        </Box>
        <Box marginTop={1}>
          <Text color="gray">{`n8n MCP · n8n @ ${host}`}</Text>
        </Box>
      </Box>
    );
    const items: ReactNode[] = [header, ...events.map((e, i) => <Box key={i} paddingX={2}>{eventLine(e)}</Box>)];
    return (
      <Box flexDirection="column">
        <Static items={items}>{(item) => item}</Static>
        {live.trim() ? <Box paddingX={2}>{eventLine({ type: 'text', text: live })}</Box> : null}
        {running ? (
          <Box paddingX={2} marginTop={1}>
            <Spinner label={`${AGENT_LABELS[provider.kind === 'agent-sdk' ? provider.agent : 'claude']} is working in your n8n…`} />
          </Box>
        ) : null}
        {!onDone ? (
          // Input is always mounted at the bottom (claude-code style) — just disabled
          // while the agent works, so the box never jumps and stays where you expect it.
          <Box paddingX={2} marginTop={1}>
            <Text color={running ? 'gray' : BLUE} bold>❯ </Text>
            <TextInput
              isDisabled={running}
              placeholder={running ? 'Working… reply when Claude finishes' : 'Reply to keep going, or press esc to finish'}
              onSubmit={(v) => {
                const msg = v.trim();
                if (!msg) return;
                setContinueSession(true);
                setDemoPrompt(msg);
                setStage('demoRunning');
              }}
            />
          </Box>
        ) : null}
        {onDone ? (
          <Box paddingX={2} marginTop={1} flexDirection="column">
            <Text color={GREEN}>🎉 You're connected.</Text>
            {ok.length ? (
              <Box marginTop={1} flexDirection="column">
                <Text color="white">
                  {oauth
                    ? 'Each tool signs in to n8n the first time you use it — your wizard sign-in was just for this demo:'
                    : 'Ready to use — just start chatting in:'}
                </Text>
                {ok.map((r) => (
                  <Text key={r.id}>
                    <Text color={PINK}>• </Text>
                    <Text color="white">{r.label}</Text>
                    <Text color="gray"> — {clientUsage(r.id, !oauth)}</Text>
                  </Text>
                ))}
              </Box>
            ) : checked ? (
              <Box marginTop={1} flexDirection="column">
                <Text color="yellow">No AI client detected — add the n8n MCP server manually:</Text>
                <Text color="gray">{manualSnippet({ mcpUrl: checked.mcpUrl, apiKey: writeKey })}</Text>
              </Box>
            ) : null}
            <Box marginTop={1}>
              <Text color="gray">Docs: https://docs.n8n.io/connect/connect-to-n8n-mcp-server</Text>
            </Box>
          </Box>
        ) : null}
        {hint() ? (
          <Box paddingX={2}>
            <Text color="gray">{hint()}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // Top-aligned, not full-height: a full-height tree makes Ink repaint the whole
  // screen on every spinner tick (flicker); staying compact lets it diff in place.
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Logo + step tracker: centered. */}
      <Box flexDirection="column" alignItems="center">
        <Text color={PINK}>{BANNER}</Text>
        <Text color="gray">@n8n/mcp-wizard · connect n8n to your AI tools</Text>
        {showTracker ? (
          <Box marginTop={1}>
            <StepTracker active={active} done={false} />
          </Box>
        ) : null}
      </Box>

      {/* Step content: left-aligned, full width (the live build step needs room). */}
      <Box flexDirection="column" marginTop={1} minHeight={BODY_MIN_HEIGHT}>
        {EYEBROW[stage] ? <Text color={PINK}>{EYEBROW[stage]}</Text> : null}
        <Box marginTop={1} flexDirection="column">
          {content()}
          {lines.length ? (
            <Box marginTop={1} flexDirection="column">
              {lines.map((l, i) => (
                <Box key={i}>{l}</Box>
              ))}
            </Box>
          ) : null}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color="gray">{hint()}</Text>
      </Box>
    </Box>
  );

  function content(): ReactNode {
    switch (stage) {
      case 'askUrl':
        return (
          <Box flexDirection="column">
            <Text color="white">What's your n8n instance URL?</Text>
            <Box marginTop={1}>
              <Text color={BLUE}>› </Text>
              <TextInput
                placeholder="acme.app.n8n.cloud"
                onSubmit={(v) => {
                  const next = v.trim();
                  if (!next) return;
                  setUrl(next);
                  goto('connecting');
                }}
              />
            </Box>
          </Box>
        );
      case 'connecting':
        return <Spinner label={`Reaching ${url}…`} />;
      case 'validating':
        return <Spinner label="Validating API key…" />;
      case 'detecting':
        return <Spinner label="Scanning for installed AI clients…" />;
      case 'configuring':
        return <Spinner label="Writing configuration…" />;
      case 'oauthRunning':
        return (
          <Box flexDirection="column">
            <Spinner label="Waiting for browser authorization…" />
            {oauthUrl ? <Text color="gray">{oauthUrl}</Text> : null}
          </Box>
        );
      case 'authChoice':
        return (
          <Box flexDirection="column">
            <Text color="white">How do you want to sign in?</Text>
            <Box marginTop={1}>
              <SelectList
                options={[
                  { label: 'Browser login', value: 'oauth', recommended: true, description: 'OAuth, no copy-paste' },
                  { label: 'Paste an API key', value: 'api-key', description: 'works in every tool right away' },
                ]}
                onSelect={(v) => goto(v === 'api-key' ? 'apiKeyInput' : 'oauthRunning')}
              />
            </Box>
          </Box>
        );
      case 'apiKeyInput':
        return (
          <Box flexDirection="column">
            <Text color="white">Paste your MCP API key</Text>
            <Text color="gray">Get one at {checked?.url}/settings/mcp</Text>
            <Box marginTop={1}>
              <Text color={BLUE}>› </Text>
              <TextInput
                placeholder="eyJ…"
                onSubmit={(v) => {
                  const key = v.trim();
                  if (!key) return;
                  setWriteKey(key);
                  setDemoToken(key);
                  setAuthMode('api-key');
                  goto('validating');
                }}
              />
            </Box>
          </Box>
        );
      case 'selectClients': {
        const installedIds = new Set(installed.map((d) => d.id));
        return (
          <Box flexDirection="column">
            <Text color="white">Which clients should I configure?</Text>
            <Text color="gray">Detected ones are pre-selected; pick others to set them up too.</Text>
            <Box marginTop={1}>
              <MultiSelect
                options={ALL_CLIENTS.map((d) => ({
                  label: installedIds.has(d.id) ? d.label : `${d.label} (not detected)`,
                  value: d.id,
                }))}
                defaultValue={installed.filter((d) => d.autoSelect !== false).map((d) => d.id)}
                onSubmit={(values) => {
                  setDetected(ALL_CLIENTS.filter((d) => values.includes(d.id)));
                  goto('configuring');
                }}
              />
            </Box>
          </Box>
        );
      }
      case 'demoSelect': {
        const single = agents.length <= 1;
        const only: DemoAgent = agents[0] ?? 'claude';
        const runOptions: SelOption[] = single
          ? [
              { label: 'Run a live demo', value: `run:${only}`, recommended: true, description: `${AGENT_LABELS[only]} answers a real prompt using your n8n tools` },
              { label: "Skip — I'm all set", value: 'skip', description: 'jump straight to the finish' },
            ]
          : [
              ...agents.map((a, idx) => ({
                label: `Run with ${AGENT_LABELS[a]}`,
                value: `run:${a}`,
                recommended: idx === 0,
                description: `${AGENT_LABELS[a]} answers a real prompt using your n8n tools`,
              })),
              { label: "Skip — I'm all set", value: 'skip', description: 'jump straight to the finish' },
            ];
        return (
          <Box flexDirection="column">
            <Text color="white">With n8n MCP, your AI tools can:</Text>
            <Box marginTop={1} flexDirection="column">
              <Text color="gray">  • Build workflows from a plain-English description</Text>
              <Text color="gray">  • Run &amp; inspect executions</Text>
              <Text color="gray">  • Find &amp; fix errors in your workflows</Text>
              <Text color="gray">  • List &amp; manage what you already have</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color="white">Want to see it live against your instance?</Text>
              <Text color="gray">
                Runs on your own {single ? AGENT_LABELS[only] : 'AI tools'} (your login &amp; usage) — it'll ask n8n to sign in.
              </Text>
              <Box marginTop={1}>
                <SelectList
                  options={runOptions}
                  onSelect={(v) => {
                    if (v === 'skip') return goto('done');
                    setProvider({ kind: 'agent-sdk', agent: v.slice('run:'.length) as DemoAgent });
                    goto('demoPrompts');
                  }}
                />
              </Box>
            </Box>
          </Box>
        );
      }
      case 'demoPrompts':
        if (!suggestions.length) return <Spinner label="Tailoring prompts for your instance…" />;
        return (
          <Box flexDirection="column">
            <Text color="white">Try one now, against your instance:</Text>
            <Box marginTop={1}>
              <SelectList
                options={suggestions.map((p) => ({ label: p.text, value: p.text }))}
                onSelect={(v) => {
                  setContinueSession(false); // first turn of the chat
                  setDemoPrompt(v);
                  setStage('demoRunning');
                }}
              />
            </Box>
          </Box>
        );
      // demoRunning / demoFollowup / done are handled by the chat-view early return.
      case 'error':
        return (
          <Box flexDirection="column">
            <Text color="red">✗ {error?.message}</Text>
            {error?.suggestion ? <Text color="gray">{error.suggestion}</Text> : null}
          </Box>
        );
      default:
        return null;
    }
  }

  function hint(): string {
    switch (stage) {
      case 'askUrl':
        return 'type your instance URL · enter';
      case 'authChoice':
        return '↑↓ move · enter select';
      case 'apiKeyInput':
        return 'paste your key · enter';
      case 'selectClients':
        return '↑↓ move · space toggle · enter confirm';
      case 'demoSelect':
        return '↑↓ move · enter select';
      case 'demoPrompts':
        return '↑↓ move · enter run';
      case 'demoRunning':
        return ''; // the spinner already says the agent is working…
      case 'demoFollowup':
        return 'reply to keep going · esc to finish';
      case 'done':
        return 'press enter to finish';
      case 'error':
        return 'press enter to exit';
      default:
        return 'working…';
    }
  }
}

/** A client counts as connected if we just wrote it OR it was already configured (re-run). */
const isConfigured = (r: ClientWriteResult) => r.ok || r.error === 'already-exists';

function resultLine(r: ClientWriteResult): ReactNode {
  if (r.ok) return <Text key={r.id}><Text color={GREEN}>✓</Text> {r.label} <Text color="gray">{r.detail ?? ''}</Text></Text>;
  if (r.error === 'already-exists') return <Text key={r.id}><Text color="yellow">•</Text> {r.label} <Text color="gray">already configured</Text></Text>;
  return <Text key={r.id}><Text color="red">✗</Text> {r.label} <Text color="gray">{r.error ?? 'failed'}</Text></Text>;
}

function eventLine(e: DemoEvent): ReactNode {
  switch (e.type) {
    case 'header':
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={PINK}>◆ n8n</Text> <Text color="gray">· build · your first automation</Text>
          </Text>
          <Text color="gray">
            {e.agent} · {e.host}
          </Text>
          <Text color="gray">────────────────────────────────────</Text>
        </Box>
      );
    case 'prompt':
      return (
        <Box marginTop={1}>
          <Text color={BLUE} bold>❯ </Text>
          <Text color="white" bold>{e.text}</Text>
        </Box>
      );
    case 'tool':
      return (
        <Text>
          <Text color="gray">↳</Text> <Text color={PURPLE}>{e.name}</Text>
          {e.input ? <Text color="gray" dimColor>{`(${e.input})`}</Text> : null}
        </Text>
      );
    case 'tool-done':
      return (
        <Text>
          {'  '}
          <Text color="gray">⎿ </Text>
          <Text color={e.isError ? 'yellow' : 'gray'} dimColor={!e.isError}>{e.output ?? 'done'}</Text>
        </Text>
      );
    case 'thinking':
      return <Text color="gray" dimColor>{stripMarkdown(e.text)}</Text>;
    case 'text':
      return <Text color="white">{stripMarkdown(e.text)}</Text>;
    case 'result':
      return <Box marginTop={1}><Text color="white">{stripMarkdown(e.text)}</Text></Box>;
    case 'error':
      return <Text color="yellow">{e.message}</Text>;
    default:
      return null;
  }
}

/** Render the interactive wizard; resolves with the process exit code. */
export async function runInk(props: Omit<AppProps, 'onExit'>): Promise<number> {
  let code = 0;
  let summary = '';
  // Alternate screen buffer: own the full terminal (full-screen, centered),
  // then restore the user's scrollback on exit and print a persistent summary
  // (otherwise the onboarding/error vanishes with the alt-screen).
  const out = process.stdout;
  const restore = () => out.write('\x1b[?1049l');
  out.write('\x1b[?1049h\x1b[H');
  process.once('exit', restore);
  try {
    const { waitUntilExit } = render(
      <App
        {...props}
        onExit={(c, s) => {
          code = c;
          summary = s;
        }}
      />,
    );
    await waitUntilExit();
  } finally {
    restore();
  }
  if (summary) out.write('\n' + summary + '\n\n');
  return code;
}
