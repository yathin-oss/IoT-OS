import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const E2E = {
  root,
  port: 5199,
  aiPort: 5198,
  token: 'e2e-token-0123456789abcdef',
  fakeCli: resolve(root, 'tests/fixtures/fake-arduino-cli.mjs'),
};
