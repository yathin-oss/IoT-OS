import { severityRank, type Diagnostic } from '../diagnostics';
import { buildGraph, componentSupplyVoltage, derivePinMap, type CircuitGraph, type PinBinding } from '../circuit/graph';
import { getRegistry, type HardwareRegistry } from '../registry/registry';
import type { BoardDefinition } from '../registry/types';
import type { Circuit, HardwareModel } from '../project/schema';
import { RULES } from './rules';

export interface ValidationContext {
  hardware: HardwareModel;
  circuit: Circuit;
  board: BoardDefinition;
  graph: CircuitGraph;
  pinMap: PinBinding[];
  registry: HardwareRegistry;
  supplyOf(componentId: string): number | null;
}

export interface ValidationRule {
  id: string;
  description: string;
  check(ctx: ValidationContext): Diagnostic[];
}

export interface ValidationResult {
  diagnostics: Diagnostic[];
  pinMap: PinBinding[];
  graph: CircuitGraph | null;
}

/**
 * Deterministic hardware validation. Independent of any AI: AI proposals are
 * validated by exactly the same engine as manual edits.
 */
export function validateHardware(
  hardware: HardwareModel,
  circuit: Circuit,
  registry: HardwareRegistry = getRegistry(),
  rules: ValidationRule[] = RULES,
): ValidationResult {
  const board = registry.getBoard(hardware.boardId);
  if (!board) {
    return {
      diagnostics: [
        {
          code: 'BOARD_UNKNOWN',
          severity: 'blocking',
          source: 'hardware',
          message: `Unknown board "${hardware.boardId}"`,
          hint: `Choose one of: ${registry
            .listBoards()
            .map((b) => b.id)
            .join(', ')}`,
        },
      ],
      pinMap: [],
      graph: null,
    };
  }
  const graph = buildGraph(circuit, board.id, registry);
  const pinMap = derivePinMap(graph);
  const ctx: ValidationContext = {
    hardware,
    circuit,
    board,
    graph,
    pinMap,
    registry,
    supplyOf: (id) => {
      const inst = graph.instances.get(id);
      const def = graph.defs.get(id);
      return inst && def ? componentSupplyVoltage(graph, inst, def) : null;
    },
  };
  const diagnostics: Diagnostic[] = [];
  for (const rule of rules) {
    try {
      diagnostics.push(...rule.check(ctx));
    } catch (err) {
      diagnostics.push({
        code: 'VALIDATION_RULE_FAILED',
        severity: 'warning',
        source: 'hardware',
        message: `Validation rule "${rule.id}" failed: ${(err as Error).message}`,
      });
    }
  }
  return { diagnostics: sortDiagnostics(dedupe(diagnostics)), pinMap, graph };
}

function dedupe(diags: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diags.filter((d) => {
    const k = `${d.code}|${d.message}|${JSON.stringify(d.target ?? {})}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function sortDiagnostics(diags: Diagnostic[]): Diagnostic[] {
  return [...diags].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.code.localeCompare(b.code) ||
      (a.target?.componentId ?? '').localeCompare(b.target?.componentId ?? '') ||
      a.message.localeCompare(b.message),
  );
}
