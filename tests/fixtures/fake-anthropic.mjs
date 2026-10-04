#!/usr/bin/env node
// TEST DOUBLE — a local stand-in for the Anthropic Messages API used by the E2E
// suite (IoT-OS is pointed at it with IOTOS_ANTHROPIC_BASE_URL). It returns
// deterministic replies derived from the request so UI flows can be verified.
import { createServer } from 'node:http';

const port = Number(process.env.FAKE_AI_PORT ?? 5198);

function message(text) {
  return { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake-claude', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: 100, output_tokens: 20 } };
}

/** Rebuild a file from the numbered listing in the IoT-OS context ("   1| code"). */
function fileFromContext(prompt, path) {
  const start = prompt.indexOf(`File: ${path}\n`);
  if (start < 0) return null;
  const body = prompt.slice(start).split('\n```')[1] ?? '';
  return body
    .split('\n')
    .slice(1)
    .filter((l) => /^\s*\d+\| /.test(l) || /^\s*\d+\|$/.test(l))
    .map((l) => l.replace(/^\s*\d+\| ?/, ''))
    .join('\n') + '\n';
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (!req.url?.startsWith('/v1/messages')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw || '{}');
    const last = body.messages?.at(-1)?.content ?? '';
    let text;
    if (last.includes('"edits": [{"path"')) {
      const main = fileFromContext(last, 'src/main.cpp') ?? '';
      text = JSON.stringify({ summary: 'Shortened the debounce delay to 10 ms.', edits: [{ path: 'src/main.cpp', content: main.replace('delay(20);', 'delay(10);') }], notes: ['Assumes a clean push button.'] });
    } else {
      const pin = /BTN1\.1 -> (\w+)/.exec(last)?.[1] ?? 'unknown';
      text = `The button BTN1 is wired to **${pin}** and read through \`BTN1_PIN\` from config.h.`;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message(text)));
  });
}).listen(port, '127.0.0.1', () => console.log(`fake anthropic on ${port}`));
