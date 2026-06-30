import { describe, it, expect } from 'vitest';
import { serverKeyForInstance, isN8nServerKey, DEFAULT_SERVER_KEY } from '../src/lib/clients/types.js';

describe('serverKeyForInstance', () => {
  it('shortens n8n Cloud to its subdomain', () => {
    expect(serverKeyForInstance('https://acme.app.n8n.cloud')).toBe('n8n-acme');
    expect(serverKeyForInstance('https://acme.n8n.cloud')).toBe('n8n-acme');
    expect(serverKeyForInstance('https://acme-corp.app.n8n.cloud')).toBe('n8n-acme-corp');
  });

  it('uses the full host slug for self-hosted instances', () => {
    expect(serverKeyForInstance('https://n8n.acme.com')).toBe('n8n-acme-com');
    expect(serverKeyForInstance('https://automate.acme.com')).toBe('n8n-automate-acme-com');
  });

  it('keeps the port for localhost / non-standard hosts', () => {
    expect(serverKeyForInstance('http://localhost:5678')).toBe('n8n-localhost-5678');
  });

  it('accepts a bare host without a protocol', () => {
    expect(serverKeyForInstance('acme.app.n8n.cloud')).toBe('n8n-acme');
  });

  it('never double-prefixes when the slug already starts with n8n', () => {
    expect(serverKeyForInstance('https://n8n.example.io')).toBe('n8n-example-io');
    expect(serverKeyForInstance('https://n8n.cloud')).toBe('n8n-cloud');
  });

  it('produces only [a-z0-9-] (safe for Codex TOML / CLI args)', () => {
    expect(serverKeyForInstance('https://My-Instance.EXAMPLE.com')).toMatch(/^[a-z0-9-]+$/);
  });

  it('falls back to the default key for unparseable input', () => {
    expect(serverKeyForInstance('not a url')).toBe(DEFAULT_SERVER_KEY);
  });

  it('always returns a recognizable n8n key', () => {
    for (const url of ['https://acme.app.n8n.cloud', 'https://n8n.acme.com', 'http://localhost:5678']) {
      expect(isN8nServerKey(serverKeyForInstance(url))).toBe(true);
    }
  });
});

describe('isN8nServerKey', () => {
  it('matches the default and per-instance keys, with a boundary', () => {
    expect(isN8nServerKey('n8n')).toBe(true);
    expect(isN8nServerKey('n8n-acme')).toBe(true);
    expect(isN8nServerKey('n8nfoo')).toBe(false);
    expect(isN8nServerKey('other')).toBe(false);
  });
});
