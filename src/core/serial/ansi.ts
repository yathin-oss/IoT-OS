/**
 * Minimal ANSI SGR parser for serial output: supports reset, bold, the 8/16
 * standard colors (foreground/background). Other escape sequences are stripped.
 */

export interface AnsiSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

const COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

// eslint-disable-next-line no-control-regex
const ESC = /\u001b\[([0-9;]*)([A-Za-z])/g;

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let state: Omit<AnsiSpan, 'text'> = {};
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    spans.push({ text, ...state });
  };
  for (let m = ESC.exec(input); m; m = ESC.exec(input)) {
    push(input.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== 'm') continue;
    const codes = m[1] === '' ? [0] : m[1]!.split(';').map(Number);
    for (const c of codes) {
      if (c === 0) state = {};
      else if (c === 1) state = { ...state, bold: true };
      else if (c === 22) state = { ...state, bold: false };
      else if (c >= 30 && c <= 37) state = { ...state, fg: COLORS[c - 30] };
      else if (c >= 90 && c <= 97) state = { ...state, fg: `bright-${COLORS[c - 90]}` };
      else if (c === 39) state = { ...state, fg: undefined };
      else if (c >= 40 && c <= 47) state = { ...state, bg: COLORS[c - 40] };
      else if (c === 49) state = { ...state, bg: undefined };
    }
  }
  ESC.lastIndex = 0;
  push(input.slice(last));
  // Strip any remaining control characters except tab.
  // eslint-disable-next-line no-control-regex
  return spans.map((s) => ({ ...s, text: s.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') })).filter((s) => s.text.length > 0);
}

export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}
