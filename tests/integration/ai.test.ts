import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AICompletionRequest, AIProvider } from '../../src/core/ai/types';
import { AnthropicProvider, GeminiProvider, OpenAIProvider } from '../../src/main/ai/providers';
import { testServices } from './helpers';

/* ------------------- providers against a local fake API ------------------- */

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let base = '';
const captured: Captured[] = [];
let respond: (c: Captured) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const c: Captured = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
      captured.push(c);
      const r = respond(c);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  captured.length = 0;
});

const REQ: AICompletionRequest = { system: 'SYS', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1000, temperature: 0.2, json: true };

describe('Anthropic provider (official SDK)', () => {
  it('sends a Messages API request without sampling params and with refusal fallbacks', async () => {
    respond = () => ({
      status: 200,
      body: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    });
    const p = new AnthropicProvider({ apiKey: 'sk-ant-test-key-123456', model: 'claude-opus-5-5', baseUrl: base });
    const r = await p.complete(REQ);
    expect(r).toMatchObject({ text: 'Hello world', model: 'claude-opus-5-5', usage: { inputTokens: 12, outputTokens: 3 }, stopReason: 'end_turn' });
    const c = captured[0]!;
    expect(c.url).toMatch(/^\/v1\/messages/);
    expect(c.headers['x-api-key']).toBe('sk-ant-test-key-123456');
    expect(c.headers['anthropic-version']).toBeTruthy();
    expect(String(c.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(c.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 1000, system: 'SYS', messages: [{ role: 'user', content: 'hi' }], fallbacks: 'default' });
    expect(c.body).not.toHaveProperty('temperature');
  });

  it('maps refusals and HTTP errors', async () => {
    respond = () => ({ status: 200, body: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' }, usage: { input_tokens: 1, output_tokens: 0 } } });
    const p = new AnthropicProvider({ apiKey: 'k-1234567890', model: 'claude-opus-5-5', baseUrl: base });
    await expect(p.complete(REQ)).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR', message: expect.stringMatching(/declined/) });
    respond = () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    await expect(p.complete(REQ)).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR', hint: expect.stringMatching(/API key/) });
  });
});

describe('OpenAI provider (official SDK)', () => {
  it('sends chat completions with a system message and JSON mode', async () => {
    respond = () => ({ status: 200, body: { id: 'c', object: 'chat.completion', created: 0, model: 'gpt-test', choices: [{ index: 0, message: { role: 'assistant', content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } });
    const p = new OpenAIProvider({ apiKey: 'sk-test-openai', model: 'gpt-test', baseUrl: `${base}/v1` });
    const r = await p.complete(REQ);
    expect(r).toMatchObject({ text: '{"a":1}', usage: { inputTokens: 5, outputTokens: 2 } });
    const c = captured[0]!;
    expect(c.url).toBe('/v1/chat/completions');
    expect(c.headers['authorization']).toBe('Bearer sk-test-openai');
    expect(c.body).toMatchObject({ model: 'gpt-test', max_completion_tokens: 1000, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] });
  });
});

describe('Gemini provider (official SDK)', () => {
  it('sends generateContent with system instruction', async () => {
    respond = () => ({ status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text: 'Hi there' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } });
    const p = new GeminiProvider({ apiKey: 'gem-key-123456', model: 'gemini-test', baseUrl: base });
    const r = await p.complete(REQ);
    expect(r).toMatchObject({ text: 'Hi there', usage: { inputTokens: 3, outputTokens: 2 } });
    const c = captured[0]!;
    expect(c.url).toMatch(/models\/gemini-test:generateContent/);
    expect(JSON.stringify(c.body)).toContain('SYS');
    expect(c.body).toMatchObject({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
  });
});

/* -------------------- AI service through the API router ------------------- */

class ScriptedProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  readonly model = 'scripted-test-double';
  readonly requests: AICompletionRequest[] = [];
  constructor(public replies: string[]) {}
  async complete(req: AICompletionRequest) {
    this.requests.push(req);
    const text = this.replies.shift();
    if (text === undefined) throw new Error('no scripted reply');
    return { text, model: this.model };
  }
}

describe('AI service (scripted provider test double)', () => {
  let t: ReturnType<typeof testServices>;
  let provider: ScriptedProvider;
  afterEach(async () => {
    await t?.dispose();
  });
  function setup() {
    provider = new ScriptedProvider([]);
    t = testServices({ providerFactory: () => provider });
  }

  it('reports not-configured without a key and works once a key is set', async () => {
    setup();
    await t.call('project.create', { name: 'AI', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    expect((await t.call('ai.status')).configured).toBe(false);
    const turn = await t.call('ai.chat', { message: 'hello' });
    expect(turn.error?.code).toBe('AI_NOT_CONFIGURED');
    await t.call('settings.setApiKey', { provider: 'anthropic', key: 'sk-ant-xxxxxxxxxxxx' });
    provider.replies.push('The LED is on GPIO25.');
    const ok = await t.call('ai.chat', { message: 'Which pin is the LED on?', options: { activeFile: 'src/main.cpp' } });
    expect(ok.content).toBe('The LED is on GPIO25.');
    expect(ok.context!.map((s) => s.id)).toEqual(expect.arrayContaining(['project', 'hardware', 'circuit', 'active-file']));
    expect(provider.requests[0]!.messages.at(-1)!.content).toContain('LED1.A -> GPIO25');
    expect((await t.call('ai.history')).length).toBe(4);
  });

  it('turns code edits into a reviewable proposal and applies a partial selection', async () => {
    setup();
    await t.call('settings.setApiKey', { provider: 'anthropic', key: 'sk-ant-xxxxxxxxxxxx' });
    await t.call('project.create', { name: 'AI', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    const before = (await t.call('fs.read', { path: 'src/main.cpp' })).content;
    const after = before.replace('delay(500);\n  digitalWrite(LED1_PIN, LOW);', 'delay(250);\n  digitalWrite(LED1_PIN, LOW);').replace('Serial.println("LED off");\n  delay(500);', 'Serial.println("LED off");\n  delay(250);');
    // First reply tries to edit the generated config (rejected → repair request), second complies.
    provider.replies.push(JSON.stringify({ summary: 'Blink twice as fast', edits: [{ path: 'src/main.cpp', content: after }, { path: 'include/config.h', content: 'hacked' }], notes: [] }));
    provider.replies.push(JSON.stringify({ summary: 'Blink twice as fast', edits: [{ path: 'src/main.cpp', content: after }], notes: [] }));
    const turn = await t.call('ai.editCode', { instruction: 'blink faster' });
    expect(turn.proposalId, turn.content).toBeDefined();
    expect(provider.requests[1]!.messages.at(-1)!.content).toMatch(/include\/config\.h is generated/);
    const proposal = await t.call('proposals.get', { id: turn.proposalId! });
    expect(proposal.changes.map((c) => c.path)).toEqual(['src/main.cpp']);
    expect(proposal.changes[0]!.blocks.length).toBe(2);
    // Nothing written until accepted.
    expect((await t.call('fs.read', { path: 'src/main.cpp' })).content).toBe(before);
    const applied = await t.call('proposals.apply', { id: proposal.id, selection: { 'src/main.cpp': [0] } });
    expect(applied.proposal.status).toBe('partially-applied');
    const now = (await t.call('fs.read', { path: 'src/main.cpp' })).content;
    expect(now.match(/delay\(250\)/g)?.length).toBe(1);
    expect(now.match(/delay\(500\)/g)?.length).toBe(1);
  });

  it('refuses to apply a proposal after the file changed', async () => {
    setup();
    await t.call('settings.setApiKey', { provider: 'anthropic', key: 'sk-ant-xxxxxxxxxxxx' });
    await t.call('project.create', { name: 'AI', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    provider.replies.push(JSON.stringify({ summary: 's', edits: [{ path: 'src/main.cpp', content: '// replaced\n' }], notes: [] }));
    const turn = await t.call('ai.editCode', { instruction: 'replace' });
    await t.call('fs.write', { path: 'src/main.cpp', content: '// user edit\n' });
    await expect(t.call('proposals.apply', { id: turn.proposalId!, selection: {} })).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT' });
  });

  it('proposes a validated circuit change with a regenerated pin config', async () => {
    setup();
    await t.call('settings.setApiKey', { provider: 'anthropic', key: 'sk-ant-xxxxxxxxxxxx' });
    await t.call('project.create', { name: 'AI', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    provider.replies.push(
      JSON.stringify({ summary: 'Add a button on GPIO27', components: [{ id: 'btn1', type: 'push-button' }], connections: [{ from: 'board.GPIO27', to: 'btn1.1' }, { from: 'btn1.2', to: 'board.GND' }], remove: [], notes: ['Use INPUT_PULLUP'] }),
    );
    const turn = await t.call('ai.planCircuit', { request: 'add a button' });
    const p = await t.call('proposals.get', { id: turn.proposalId! });
    expect(p.changes.map((c) => c.path).sort()).toEqual(['.iotos/circuit.json', 'include/config.h']);
    expect(p.changes.find((c) => c.path === '.iotos/circuit.json')!.summary).toEqual(['Add BTN1 (push-button)', 'Connect board.GPIO27 ↔ btn1.1', 'Connect board.GND ↔ btn1.2']);
    await t.call('proposals.apply', { id: p.id, selection: {} });
    const snap = (await t.call('project.current'))!;
    expect(snap.circuit.components.map((c) => c.id)).toContain('btn1');
    expect((await t.call('fs.read', { path: 'include/config.h' })).content).toMatch(/BTN1_PIN\s+27/);
    expect(await t.call('project.diagnostics')).toEqual([]);
  });

  it('rejects partial selections that would corrupt project model files', async () => {
    setup();
    const snap = await t.call('project.create', { name: 'AI', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    // Rename r1 -> r2 and add a new r1: valid together, but accepting only the
    // addition would duplicate the id "r1".
    const r1 = snap.circuit.components.find((c) => c.id === 'r1')!;
    const next = {
      ...snap.circuit,
      components: [...snap.circuit.components.map((c) => (c.id === 'r1' ? { ...c, id: 'r2' } : c)), { ...r1, x: 500 }],
    };
    const before = (await t.services.projects.require().fs.read('.iotos/circuit.json')).content;
    const after = JSON.stringify(next, null, 2) + '\n';
    const p = (await t.services.proposals.create({ title: 't', description: '', origin: 'generator', files: { '.iotos/circuit.json': after } }))!;
    const blocks = p.changes[0]!.blocks;
    expect(blocks.length).toBeGreaterThan(1);
    const additionOnly = blocks.filter((b) => b.added.some((l) => l.includes('"x": 500'))).map((b) => b.id);
    await expect(t.call('proposals.apply', { id: p.id, selection: { '.iotos/circuit.json': additionOnly } })).rejects.toMatchObject({ code: 'AI_INVALID_PROPOSAL' });
    // Nothing was written.
    expect((await t.services.projects.require().fs.read('.iotos/circuit.json')).content).toBe(before);
    await t.call('proposals.apply', { id: p.id, selection: { '.iotos/circuit.json': 'all' } });
    expect((await t.call('project.current'))!.circuit.components.map((c) => c.id).sort()).toEqual(['led1', 'r1', 'r2']);
  });

  it('builds a new project from an AI plan only after explicit creation', async () => {
    setup();
    await t.call('settings.setApiKey', { provider: 'anthropic', key: 'sk-ant-xxxxxxxxxxxx' });
    provider.replies.push(
      JSON.stringify({
        name: 'Night Light',
        summary: 'LDR turns an LED on in the dark',
        requirements: ['LED on when dark'],
        language: 'arduino-cpp',
        board: { id: 'arduino-uno-r3', reason: 'simple, 5 V' },
        wifi: false,
        bluetooth: false,
        components: [
          { id: 'ldr1', type: 'ldr-module' },
          { id: 'led1', type: 'led' },
          { id: 'r1', type: 'resistor', props: { resistance: 220 } },
        ],
        connections: [
          { from: 'board.5V', to: 'ldr1.VCC' },
          { from: 'ldr1.GND', to: 'board.GND' },
          { from: 'ldr1.AO', to: 'board.A0' },
          { from: 'board.D9', to: 'r1.1' },
          { from: 'r1.2', to: 'led1.A' },
          { from: 'led1.K', to: 'board.GND' },
        ],
        firmware: { files: [{ path: 'src/main.cpp', content: '#include <Arduino.h>\n#include "config.h"\nvoid setup(){pinMode(LED1_PIN, OUTPUT);}\nvoid loop(){digitalWrite(LED1_PIN, analogRead(LDR1_PIN) < 300);}\n' }] },
        dependencies: [],
        overview: 'Calibrate the threshold.',
        assumptions: ['Room light gives > 300 counts'],
      }),
    );
    const before = (await t.call('project.list')).length;
    const preview = await t.call('ai.planProject', { idea: 'night light' });
    expect(preview.problems).toEqual([]);
    expect(preview.files['include/config.h']).toMatch(/LDR1_PIN\s+A0/);
    expect((await t.call('project.list')).length).toBe(before);
    const snap = await t.call('ai.createProjectFromPlan', { planId: preview.planId });
    expect(snap.manifest.name).toBe('Night Light');
    expect(snap.manifest.tags).toContain('ai-generated');
    expect(snap.circuit.components).toHaveLength(3);
    expect(await t.call('project.diagnostics')).toEqual([]);
  });
});
