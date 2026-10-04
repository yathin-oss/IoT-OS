/**
 * Shared diagnostic model used by hardware validation, the compiler error parser,
 * firmware/circuit sync checks and project loading. Every subsystem reports problems
 * in this one shape so the Problems panel, the build pipeline and the AI context can
 * consume them uniformly.
 */

export const SEVERITIES = ['info', 'warning', 'error', 'blocking'] as const;
export type Severity = (typeof SEVERITIES)[number];

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2, blocking: 3 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

export function maxSeverity(diags: readonly { severity: Severity }[]): Severity | null {
  let max: Severity | null = null;
  for (const d of diags) {
    if (max === null || SEVERITY_RANK[d.severity] > SEVERITY_RANK[max]) max = d.severity;
  }
  return max;
}

export type DiagnosticSource = 'hardware' | 'compiler' | 'linker' | 'sync' | 'project' | 'toolchain' | 'runtime' | 'simulator';

/** Where a diagnostic points. Any combination may be set. */
export interface DiagnosticTarget {
  /** Project-relative file path. */
  file?: string;
  line?: number;
  column?: number;
  componentId?: string;
  /** Pin id on a component (when componentId set) */
  componentPin?: string;
  /** Pin id on the board */
  boardPin?: string;
  wireId?: string;
}

export interface Diagnostic {
  /** Stable machine-readable code, e.g. PIN_INPUT_ONLY or GCC_ERROR. */
  code: string;
  severity: Severity;
  source: DiagnosticSource;
  message: string;
  /** Longer explanation, rendered under the message. */
  detail?: string;
  /** Concrete human-actionable remedy. */
  hint?: string;
  target?: DiagnosticTarget;
}

export function countBySeverity(diags: readonly Diagnostic[]): Record<Severity, number> {
  const out: Record<Severity, number> = { info: 0, warning: 0, error: 0, blocking: 0 };
  for (const d of diags) out[d.severity]++;
  return out;
}

/**
 * Operation gating policy (documented in docs/HARDWARE_REGISTRY.md):
 *  - Build is blocked only by BLOCKING diagnostics (an unusable project model).
 *    Compiling is harmless, so wiring ERRORs are reported but do not stop it.
 *  - Flash is blocked by ERROR and BLOCKING. ERROR may be overridden with explicit
 *    user confirmation because the user may know their physical wiring differs.
 */
export function blocksBuild(diags: readonly Diagnostic[]): boolean {
  return diags.some((d) => d.severity === 'blocking');
}

export function blocksFlash(diags: readonly Diagnostic[]): { blocked: boolean; overridable: boolean } {
  const hasBlocking = diags.some((d) => d.severity === 'blocking');
  const hasError = diags.some((d) => d.severity === 'error');
  return { blocked: hasBlocking || hasError, overridable: !hasBlocking && hasError };
}
