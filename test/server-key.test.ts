import { describe, it, expect } from 'vitest';
import { isN8nServerKey } from '../src/lib/clients/types.js';

describe('isN8nServerKey', () => {
  it('matches the default and legacy per-instance keys, with a boundary', () => {
    expect(isN8nServerKey('n8n')).toBe(true);
    expect(isN8nServerKey('n8n-acme')).toBe(true);
    expect(isN8nServerKey('n8n-internal-users-n8n-cloud')).toBe(true);
    expect(isN8nServerKey('n8nfoo')).toBe(false);
    expect(isN8nServerKey('other')).toBe(false);
  });
});
