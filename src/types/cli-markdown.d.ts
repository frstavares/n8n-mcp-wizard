declare module 'cli-markdown' {
  /** Render a markdown string to terminal-friendly ANSI. */
  const cliMarkdown: (markdown: string) => string;
  export default cliMarkdown;
}
