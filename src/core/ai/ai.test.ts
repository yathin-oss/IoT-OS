import { describe, expect, it } from 'vitest';
import { buildProject } from '../project/factory';
import { templateSpec } from '../templates/templates';
import { validateHardware } from '../validation/engine';
import { buildContext, estimateTokens } from './context';
import { extractJsonObject } from './json';
import { analyze, editCode, planCircuit, planProject } from './tasks';
import type { AICompletionRequest, AIProvider } from './types';

/** Test double: returns scripted responses in order and records requests. */
class ScriptedProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  readonly model = 'scripted';
  readonly requests: AICompletionRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async complete(req: AICompletionRequest) {
    this.requests.push(req);
    const text = this.replies.shift();
    if (text === undefined) throw new Error('no scripted reply left');
    return { text, model: this.model };
  }
}

const project = buildProject(templateSpec('blink', 'Blink', 'esp32-devkit-v1', 'arduino-cpp'), { id: 'ai-test-0001', now: '2026-01-01T00:00:00Z' });
const files = Object.entries(project.files).map(([path, content]) => ({ path, content }));
const ctxInput = {
  manifest: project.manifest,
  hardware: project.hardware,
  circuit: project.circuit,
  diagnostics: validateHardware(project.hardware, project.circuit).diagnostics,
  activeFile: files.find((f) => f.path === 'src/main.cpp')!,
};

describe('context engine', () => {
  it('builds prioritized sections and reports them', () => {
    const c = buildContext(ctxInput, 'chat');
    expect(c.sections.map((s) => s.id)).toEqual(['project', 'hardware', 'circuit', 'active-file', 'dependencies']);
    expect(c.text).toContain('LED1.A -> GPIO25 (GPIO 25, via r1)');
    expect(c.text).toContain('digitalWrite(LED1_PIN, HIGH)');
  });

  it('keeps the tail of serial output when over budget and drops low-priority sections', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const c = buildContext({ ...ctxInput, serial: { port: '/dev/x', baud: 115200, lines, runtimeIssues: [] } }, 'debug-serial', 2000);
    const serial = c.sections.find((s) => s.id === 'serial')!;
    expect(serial.truncated).toBe(true);
    expect(c.text).toContain('line 2999');
    expect(c.text).not.toContain('line 10\n');
    expect(c.tokens).toBeLessThanOrEqual(2000 + 50);
    expect(c.sections.some((s) => !s.included)).toBe(true);
  });

  it('focuses source windows around error lines', () => {
    const big = Array.from({ length: 400 }, (_, i) => `// line ${i + 1}`).join('\n');
    const c = buildContext({ ...ctxInput, activeFile: { path: 'src/main.cpp', content: big, focus: [200] } }, 'fix-build');
    expect(c.text).toContain(' 200| // line 200');
    expect(c.text).not.toContain('// line 50\n');
    expect(estimateTokens(c.text)).toBeLessThan(2000);
  });

  it('is deterministic', () => {
    expect(buildContext(ctxInput, 'chat')).toEqual(buildContext(ctxInput, 'chat'));
  });
});

describe('JSON extraction', () => {
  it('handles fenced, bare and embedded JSON with braces in strings', () => {
    expect(extractJsonObject('```json\n{"a": "}"}\n```')).toEqual({ a: '}' });
    expect(extractJsonObject('Sure! {"a": {"b": 1}} hope that helps')).toEqual({ a: { b: 1 } });
    expect(() => extractJsonObject('no json here')).toThrow(/valid JSON/);
  });
});

const GOOD_PLAN = {
  name: 'Desk Lamp',
  summary: 'Button toggles an LED.',
  requirements: ['toggle LED with a button'],
  language: 'arduino-cpp',
  board: { id: 'esp32-devkit-v1', reason: 'Wi-Fi capable' },
  wifi: false,
  bluetooth: false,
  components: [
    { id: 'led1', type: 'led', reason: 'lamp' },
    { id: 'r1', type: 'resistor', props: { resistance: 220 } },
    { id: 'btn1', type: 'push-button' },
  ],
  connections: [
    { from: 'board.GPIO25', to: 'r1.1' },
    { from: 'r1.2', to: 'led1.A' },
    { from: 'led1.K', to: 'board.GND' },
    { from: 'board.GPIO27', to: 'btn1.1' },
    { from: 'btn1.2', to: 'board.GND' },
  ],
  firmware: { files: [{ path: 'src/main.cpp', content: '#include <Arduino.h>\n#include "config.h"\nvoid setup(){pinMode(LED1_PIN, OUTPUT); pinMode(BTN1_PIN, INPUT_PULLUP);}\nvoid loop(){}\n' }] },
  dependencies: [],
  overview: '',
  assumptions: ['Button is momentary'],
};

describe('AI project builder', () => {
  it('validates a good plan and builds the project', async () => {
    const p = new ScriptedProvider([JSON.stringify(GOOD_PLAN)]);
    const r = await planProject({ provider: p }, { idea: 'lamp with a button' });
    expect(r.problems).toEqual([]);
    expect(r.attempts).toBe(1);
    expect(r.built?.files['include/config.h']).toMatch(/BTN1_PIN\s+27/);
    expect(r.built?.files['docs/HARDWARE.md']).toMatch(/Assumptions/);
    expect(p.requests[0]!.system).toMatch(/OBSERVED/);
  });

  it('feeds deterministic validation failures back to the model and accepts the repair', async () => {
    const bad = {
      ...GOOD_PLAN,
      components: [...GOOD_PLAN.components, { id: 'fan1', type: 'flux-fan' }],
      connections: GOOD_PLAN.connections.map((c) => (c.from === 'board.GPIO25' ? { ...c, from: 'board.GPIO34' } : c)),
    };
    const p = new ScriptedProvider([JSON.stringify(bad), JSON.stringify({ ...bad, components: GOOD_PLAN.components }), JSON.stringify(GOOD_PLAN)]);
    const r = await planProject({ provider: p }, { idea: 'lamp' });
    expect(r.attempts).toBe(3);
    expect(r.problems).toEqual([]);
    const repair1 = p.requests[1]!.messages.at(-1)!.content;
    expect(repair1).toMatch(/Unknown component type "flux-fan"/);
    const repair2 = p.requests[2]!.messages.at(-1)!.content;
    expect(repair2).toMatch(/PIN_INPUT_ONLY/);
  });

  it('reports remaining problems when the model cannot fix them', async () => {
    const usesUndefined = { ...GOOD_PLAN, firmware: { files: [{ path: 'src/main.cpp', content: 'void setup(){ pinMode(LAMP_PIN, OUTPUT); }' }] } };
    const p = new ScriptedProvider([JSON.stringify(usesUndefined), JSON.stringify(usesUndefined)]);
    const r = await planProject({ provider: p, maxAttempts: 2 }, { idea: 'lamp' });
    expect(r.problems).toEqual([expect.stringMatching(/LAMP_PIN/)]);
  });

  it('rejects malformed output after retries', async () => {
    const p = new ScriptedProvider(['not json', '{"name": 1}']);
    await expect(planProject({ provider: p, maxAttempts: 2 }, { idea: 'x' })).rejects.toThrow(/expected structure|valid JSON/);
  });
});

describe('AI circuit planning', () => {
  it('applies a plan on top of the existing circuit and validates it', async () => {
    const plan = {
      summary: 'Add a buzzer',
      components: [{ id: 'buzzer1', type: 'buzzer-active' }],
      connections: [
        { from: 'board.GPIO26', to: 'buzzer1.SIG' },
        { from: 'buzzer1.GND', to: 'board.GND' },
      ],
      remove: [],
      notes: [],
    };
    const p = new ScriptedProvider([JSON.stringify(plan)]);
    const r = await planCircuit({ provider: p }, { context: buildContext(ctxInput, 'hardware'), request: 'add a buzzer', hardware: project.hardware, circuit: project.circuit });
    expect(r.circuit.components.map((c) => c.id).sort()).toEqual(['buzzer1', 'led1', 'r1']);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(p.requests[0]!.messages[0]!.content).toContain('GPIO34 (D34): digital-in,interrupt,i2c,spi,uart,adc [input-only,no-pullup]');
  });
});

describe('AI code edits and debugging', () => {
  it('never returns edits to the generated config file', async () => {
    const reply = { summary: 'x', edits: [{ path: 'include/config.h', content: '' }, { path: 'src/main.cpp', content: '// new' }], notes: [] };
    const p = new ScriptedProvider([JSON.stringify(reply), JSON.stringify(reply)]);
    const r = await editCode({ provider: p, maxAttempts: 2 }, { context: buildContext(ctxInput, 'edit-code'), instruction: 'refactor', editableFiles: ['src/main.cpp'], configFile: 'include/config.h', language: 'arduino-cpp' });
    expect(r.response.edits.map((e) => e.path)).toEqual(['src/main.cpp']);
    expect(r.problems[0]).toMatch(/generated/);
  });

  it('returns structured debug analysis with confidence levels', async () => {
    const reply = { summary: 'Brownout', observations: ['Brownout detector was triggered x3'], likelyCauses: [{ cause: 'Servo stall current', confidence: 'medium', evidence: 'resets when servo moves' }], assumptions: ['USB 2.0 port'], suggestedFixes: ['External 5 V supply'] };
    const p = new ScriptedProvider([JSON.stringify(reply)]);
    const r = await analyze({ provider: p }, { context: buildContext(ctxInput, 'debug-serial'), kind: 'serial', editableFiles: ['src/main.cpp'], configFile: 'include/config.h' });
    expect(r.likelyCauses[0]!.confidence).toBe('medium');
    expect(r.edits).toEqual([]);
  });
});
