import { describe, it, expect } from 'vitest';
import { prettyToolName, summarizeInput, summarizeResult, truncate, errorMessage } from '../src/lib/demo/format.js';

describe('prettyToolName', () => {
  it('strips the mcp__server__ prefix', () => {
    expect(prettyToolName('mcp__n8n__search_workflows')).toBe('search_workflows');
  });
  it('leaves a bare name untouched', () => {
    expect(prettyToolName('search_workflows')).toBe('search_workflows');
  });
});

describe('summarizeInput', () => {
  it('renders an object as key: value pairs', () => {
    expect(summarizeInput('{"query":"errors"}')).toBe('query: "errors"');
  });
  it('returns undefined for empty input', () => {
    expect(summarizeInput('   ')).toBeUndefined();
  });
});

describe('summarizeResult', () => {
  it('counts array-shaped results', () => {
    expect(summarizeResult('[]', false)).toBe('0 results');
    expect(summarizeResult('[{"a":1}]', false)).toBe('1 result');
  });
  it('reports errors with a short message', () => {
    expect(summarizeResult('nope', true)).toBe('error: nope');
  });
  it('pulls text from an array of content blocks', () => {
    expect(summarizeResult([{ type: 'text', text: '{"status":"success"}' }], false)).toBe('success');
  });
});

describe('truncate / errorMessage', () => {
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
  it('unwraps Error messages', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('raw')).toBe('raw');
  });
});
