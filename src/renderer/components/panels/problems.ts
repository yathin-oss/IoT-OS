import { useMemo } from 'react';
import { severityRank, type Diagnostic } from '../../../core/diagnostics';
import { validateHardware } from '../../../core/validation/engine';
import { useCircuit } from '../../state/circuit';
import { useProject } from '../../state/project';
import { useBuild } from '../../state/runtime';

/**
 * All problems for the open project: backend diagnostics (hardware validation,
 * firmware/circuit sync, project warnings), live validation of unsaved circuit
 * edits, and compiler/linker/toolchain diagnostics from the last build.
 */
export function useAllProblems(): Diagnostic[] {
  const backend = useProject((s) => s.diagnostics);
  const snapshot = useProject((s) => s.snapshot);
  const history = useCircuit((s) => s.history);
  const hardware = useCircuit((s) => s.hardware);
  const savedCircuit = useCircuit((s) => s.savedCircuit);
  const savedHardware = useCircuit((s) => s.savedHardware);
  const last = useBuild((s) => s.last);
  return useMemo(() => {
    if (!snapshot) return [];
    const editing = history && hardware && (history.present !== savedCircuit || hardware !== savedHardware);
    const hw = editing ? validateHardware(hardware!, history!.present).diagnostics : backend.filter((d) => d.source === 'hardware');
    const rest = backend.filter((d) => d.source !== 'hardware');
    const build = last && last.boardId === snapshot.hardware.boardId ? last.diagnostics.filter((d) => d.source === 'compiler' || d.source === 'linker' || d.source === 'toolchain') : [];
    const seen = new Set<string>();
    return [...hw, ...rest, ...build]
      .filter((d) => {
        const k = `${d.source}|${d.code}|${d.message}|${d.target?.file ?? ''}|${d.target?.line ?? ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  }, [backend, snapshot, history, hardware, savedCircuit, savedHardware, last]);
}
