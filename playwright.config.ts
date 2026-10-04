import { defineConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E } from './e2e/constants';
import { assemble } from 'avr8js/dist/esm/utils/assembler.js';
import { toIntelHex } from './src/core/sim/hex';

/**
 * E2E tests run the real UI (built renderer) against the real backend services
 * in browser-host mode. External tools are replaced by clearly labelled test
 * doubles: tests/fixtures/fake-arduino-cli.mjs and tests/fixtures/fake-anthropic.mjs.
 * The "firmware" the fake compiler emits is real AVR machine code that the
 * simulator executes (button on D2 drives the LED on D9, prints "Hi").
 */
// The config is also loaded by worker processes; use a per-run directory (the id is
// inherited through the environment) instead of deleting anything here.
process.env['IOTOS_E2E_RUN'] ??= String(Date.now());
const tmp = resolve(E2E.root, '.tmp/e2e', process.env['IOTOS_E2E_RUN']);
mkdirSync(tmp, { recursive: true });
const firmware = `
ldi r16, 0x08
sts 0xC1, r16
ldi r16, 103
sts 0xC4, r16
ldi r17, 72
sts 0xC6, r17
w1:
lds r18, 0xC0
sbrs r18, 5
rjmp w1
ldi r17, 105
sts 0xC6, r17
w2:
lds r18, 0xC0
sbrs r18, 5
rjmp w2
ldi r17, 10
sts 0xC6, r17
ldi r16, 0x04
out 0x0B, r16
ldi r16, 0x02
out 0x04, r16
loop:
sbis 0x09, 2
rjmp on
cbi 0x05, 1
rjmp loop
on:
sbi 0x05, 1
rjmp loop
`;
const hexFile = resolve(tmp, 'firmware.hex');
writeFileSync(hexFile, toIntelHex(assemble(firmware).bytes));

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${E2E.port}`, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node tests/fixtures/fake-anthropic.mjs',
      port: E2E.aiPort,
      env: { ...(process.env as Record<string, string>), FAKE_AI_PORT: String(E2E.aiPort) },
      reuseExistingServer: false,
    },
    {
      command: `node dist/host/host.mjs --port ${E2E.port} --data-dir ${resolve(tmp, 'data')} --workspace ${resolve(tmp, 'projects')}`,
      url: `http://127.0.0.1:${E2E.port}/`,
      reuseExistingServer: false,
      env: {
        ...(process.env as Record<string, string>),
        IOTOS_HOST_TOKEN: E2E.token,
        IOTOS_ANTHROPIC_BASE_URL: `http://127.0.0.1:${E2E.aiPort}`,
        ANTHROPIC_API_KEY: 'e2e-fake-key-not-a-secret',
        FAKE_ARDUINO_HEX: hexFile,
        FAKE_ARDUINO_CORES: 'arduino:avr',
        FAKE_ARDUINO_LIBS: '',
      },
    },
  ],
});
