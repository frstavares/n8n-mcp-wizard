import React from 'react';
import { writeFileSync } from 'node:fs';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App, SelectList, TypewriterLines } from '../src/ui/app.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TUI layout', () => {
  it('asks for the host in-TUI when no URL is provided (full-screen, centered)', () => {
    const { lastFrame, unmount } = render(<App initialUrl="" demo={false} onExit={() => {}} />);
    const frame = stripAnsi(lastFrame() ?? '');
    writeFileSync('/tmp/n8n-ui-askurl.txt', frame);
    expect(frame).toContain('Connect');
    expect(frame).toMatch(/instance URL/i);
    unmount();
  });

  it('auth select: browser login is first + recommended, description uses "- "', () => {
    const { lastFrame, unmount } = render(
      <SelectList
        options={[
          { label: 'Browser login', value: 'oauth', recommended: true, description: 'OAuth, no copy-paste' },
          { label: 'Paste an API key', value: 'api-key', description: 'works in every tool right away' },
        ]}
        onSelect={() => {}}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    writeFileSync('/tmp/n8n-ui-auth.txt', frame);
    const lines = frame.split('\n').filter((l) => l.trim());
    expect(lines[0]).toMatch(/Browser login/);
    expect(lines[0]).toMatch(/\(recommended\)/);
    expect(lines[0]).toMatch(/- OAuth, no copy-paste/);
    expect(lines[1]).toMatch(/Paste an API key/);
    unmount();
  });
});

describe('TypewriterLines', () => {
  it('types every line out and fires onDone once it finishes', async () => {
    let done = 0;
    const { lastFrame, unmount } = render(
      <TypewriterLines
        lines={[{ text: 'first line' }, { text: 'second line' }]}
        speed={2}
        linePause={2}
        onDone={() => (done += 1)}
      />,
    );
    await wait(250);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('first line');
    expect(frame).toContain('second line');
    expect(done).toBe(1);
    unmount();
  });

  it('skips to the full text on any keypress', async () => {
    let done = 0;
    const { lastFrame, stdin, unmount } = render(
      <TypewriterLines lines={[{ text: 'capabilities here' }]} speed={5000} onDone={() => (done += 1)} />,
    );
    await wait(10); // let the input handler mount
    stdin.write('x'); // any key reveals everything immediately
    await wait(60);
    expect(stripAnsi(lastFrame() ?? '')).toContain('capabilities here');
    expect(done).toBe(1);
    unmount();
  });
});
