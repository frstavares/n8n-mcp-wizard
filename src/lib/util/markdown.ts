import cliMd from 'cli-markdown';

/** Render markdown to terminal-friendly ANSI. Falls back to the raw text. */
export function renderMarkdown(text: string): string {
  try {
    return cliMd(text).trimEnd();
  } catch {
    return text;
  }
}

/** Light strip of markdown syntax — for streamed narration chunks (keep it readable inline). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '') // code fences
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/^\s*[-*]\s+/gm, '• ') // bullets
    .trim();
}
