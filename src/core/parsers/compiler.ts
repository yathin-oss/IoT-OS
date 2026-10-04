import type { Diagnostic, Severity } from '../diagnostics';

/**
 * Parser for GCC/Clang-style compiler and GNU ld linker output, as produced by
 * arduino-cli (avr-gcc, xtensa/riscv gcc, arm-none-eabi-gcc).
 */

export interface PathMapping {
  /** Absolute path prefix as it appears in compiler output (e.g. the staged sketch dir). */
  from: string;
  /** Project-relative replacement prefix (may be empty). */
  to: string;
}

const GCC_LINE = /^(?<file>(?:[A-Za-z]:)?[^:\n]+?):(?<line>\d+)(?::(?<col>\d+))?:\s+(?<sev>fatal error|error|warning|note):\s+(?<msg>.*)$/;
const LINKER_UNDEF = /^(?<file>(?:[A-Za-z]:)?[^:\n]+?):(?:\((?<section>[^)]+)\)|(?<line>\d+)):\s+(?:\((?<sec2>[^)]+)\):\s+)?undefined reference to [`'](?<sym>[^'`]+)'/;
const LINKER_GENERIC = /^(?:.*\/)?(?:ld|collect2)(?:\.exe)?:\s+(?:error:\s+)?(?<msg>.*)$/;
const WARNING_FLAG = /\s*\[(-W[\w=-]+)\]\s*$/;
const MISSING_HEADER = /^(?<header>[\w./+-]+):\s+No such file or directory$/;

export interface CompilerParseOptions {
  pathMappings?: PathMapping[];
  /** Include "note:" lines as separate info diagnostics. */
  includeNotes?: boolean;
}

export function remapPath(file: string, mappings: PathMapping[] = []): string {
  const norm = file.replace(/\\/g, '/');
  for (const m of mappings) {
    const from = m.from.replace(/\\/g, '/').replace(/\/$/, '');
    if (norm === from) return m.to;
    if (norm.startsWith(from + '/')) {
      const rest = norm.slice(from.length + 1);
      return m.to ? `${m.to.replace(/\/$/, '')}/${rest}` : rest;
    }
  }
  return norm;
}

function mapSeverity(s: string): Severity {
  if (s === 'fatal error' || s === 'error') return 'error';
  if (s === 'warning') return 'warning';
  return 'info';
}

export function parseCompilerOutput(output: string, opts: CompilerParseOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '');
    const g = GCC_LINE.exec(line);
    if (g?.groups) {
      const sev = g.groups['sev']!;
      if (sev === 'note' && !opts.includeNotes) continue;
      let msg = g.groups['msg']!.trim();
      let code = sev === 'warning' ? 'GCC_WARNING' : sev === 'note' ? 'GCC_NOTE' : 'GCC_ERROR';
      const flag = WARNING_FLAG.exec(msg);
      if (flag) {
        code = `GCC${flag[1]!.replace(/^-W/, '_W').replace(/[=-]/g, '_').toUpperCase()}`;
        msg = msg.replace(WARNING_FLAG, '');
      }
      let hint: string | undefined;
      const header = MISSING_HEADER.exec(msg);
      if (header) {
        code = 'MISSING_HEADER';
        hint = `Header "${header.groups!['header']}" was not found. Install the library that provides it.`;
      } else if (/was not declared in this scope/.test(msg)) {
        code = 'UNDECLARED_IDENTIFIER';
      } else if (/expected .* before/.test(msg)) {
        code = 'SYNTAX_ERROR';
      }
      const file = remapPath(g.groups['file']!, opts.pathMappings);
      const diag: Diagnostic = {
        code,
        severity: mapSeverity(sev),
        source: 'compiler',
        message: msg,
        target: { file, line: Number(g.groups['line']), ...(g.groups['col'] ? { column: Number(g.groups['col']) } : {}) },
      };
      if (hint) diag.hint = hint;
      out.push(diag);
      continue;
    }
    const u = LINKER_UNDEF.exec(line);
    if (u?.groups) {
      const sym = u.groups['sym']!;
      const fileRaw = u.groups['file']!;
      const file = remapPath(fileRaw.replace(/\.o$/, ''), opts.pathMappings);
      out.push({
        code: 'LINKER_UNDEFINED_REFERENCE',
        severity: 'error',
        source: 'linker',
        message: `undefined reference to '${sym}'`,
        hint: 'The function is declared but not defined, or the library that defines it is not linked. Check spelling and installed libraries.',
        target: { file, ...(u.groups['line'] ? { line: Number(u.groups['line']) } : {}) },
      });
      continue;
    }
    const lg = LINKER_GENERIC.exec(line);
    if (lg?.groups && /returned \d+ exit status|cannot find|region .* overflowed|multiple definition/.test(lg.groups['msg']!)) {
      const msg = lg.groups['msg']!.trim();
      if (/returned \d+ exit status/.test(msg) && out.some((d) => d.source === 'linker')) continue;
      out.push({
        code: /overflowed/.test(msg) ? 'LINKER_MEMORY_OVERFLOW' : /multiple definition/.test(msg) ? 'LINKER_MULTIPLE_DEFINITION' : 'LINKER_ERROR',
        severity: 'error',
        source: 'linker',
        message: msg,
        ...(/overflowed/.test(msg) ? { hint: 'The program or data does not fit in the MCU memory. Reduce code size or move constants to flash (PROGMEM/F()).' } : {}),
      });
    }
  }
  return out;
}

export interface SizeReport {
  programBytes: number;
  programMax?: number;
  dataBytes?: number;
  dataMax?: number;
}

/** Parses arduino-cli's "Sketch uses N bytes (P%) of program storage space. Maximum is M bytes." lines. */
export function parseSizeReport(output: string): SizeReport | null {
  const prog = /Sketch uses (\d+) bytes(?: \(\d+%\))? of program storage space\.(?: Maximum is (\d+) bytes\.)?/.exec(output);
  if (!prog) return null;
  const data = /Global variables use (\d+) bytes(?: \(\d+%\))? of dynamic memory(?:, leaving \d+ bytes for local variables)?\.(?: Maximum is (\d+) bytes\.)?/.exec(output);
  const r: SizeReport = { programBytes: Number(prog[1]) };
  if (prog[2]) r.programMax = Number(prog[2]);
  if (data) {
    r.dataBytes = Number(data[1]);
    if (data[2]) r.dataMax = Number(data[2]);
  }
  return r;
}
