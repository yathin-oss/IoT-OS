import { expect, test, type Page } from '@playwright/test';
import { E2E } from './constants';

async function api(page: Page, method: string, args?: unknown) {
  const r = await page.request.post('/api/rpc', { headers: { 'x-iotos-token': E2E.token }, data: { method, args: args ?? null } });
  const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { message: string } };
  if (!j.ok) throw new Error(j.error?.message);
  return j.result as Record<string, unknown>;
}

test.describe.configure({ mode: 'serial' });

test('create → edit → validate → build → simulate → AI chat → AI edit proposal', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The arduino-cli used here is a TEST DOUBLE (tests/fixtures/fake-arduino-cli.mjs).
  await api(page, 'settings.update', { toolPaths: { 'arduino-cli': E2E.fakeCli } });
  await page.goto(`/#token=${E2E.token}`);
  await expect(page.getByTestId('home')).toBeVisible();

  // Create project from the dialog.
  await page.getByTestId('home-create').click();
  await page.getByTestId('project-name').fill('E2E Button');
  await page.getByTestId('board-select').selectOption('arduino-uno-r3');
  await page.getByText('Button + LED', { exact: true }).click();
  await page.getByTestId('create-project-submit').click();
  await expect(page.locator('[data-testid="code-editor"] .monaco-editor')).toBeVisible();

  // Edit in Monaco and save.
  await page.locator('[data-testid="code-editor"] .view-lines').click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// edited by e2e\n');
  await page.keyboard.press('Meta+S');
  await page.keyboard.press('Control+S');
  await expect.poll(async () => ((await api(page, 'fs.read', { path: 'src/main.cpp' })).content as string).includes('// edited by e2e')).toBe(true);

  // Validation: no problems for the template wiring.
  await page.getByTestId('panel-problems').click();
  await expect(page.getByTestId('status-problems')).toHaveText(/0\s*0/);

  // Build (test-double compiler emits real AVR firmware).
  await page.getByTestId('build-button').click();
  await expect(page.getByTestId('build-step-artifact')).toContainText('Firmware artifact');
  await expect(page.getByText('Build succeeded', { exact: false }).first()).toBeVisible();

  // Simulate: the AVR emulator runs the firmware; the button controls the LED.
  await page.getByTestId('activity-simulator').click();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-serial')).toContainText('Hi');
  const led = page.getByTestId('led-led1');
  await expect(led).toHaveAttribute('data-lit', '0');
  const button = page.getByTestId('button-btn1');
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(led).toHaveAttribute('data-lit', '1');
  await page.screenshot({ path: 'test-results/e2e-sim-led-on.png' });
  await page.mouse.up();
  await expect(led).toHaveAttribute('data-lit', '0');

  // AI chat with project context (fake Anthropic-compatible server).
  await page.getByTestId('copilot-input').fill('Which pin is the button on?');
  await page.getByTestId('copilot-input').press('Enter');
  await expect(page.getByTestId('copilot-chat')).toContainText('wired to D2');

  // AI code edit → reviewable proposal → accept.
  await page.getByRole('button', { name: 'Edit code' }).click();
  await page.getByTestId('copilot-input').fill('make the debounce faster');
  await page.getByTestId('copilot-input').press('Enter');
  await expect(page.getByTestId('apply-all')).toBeVisible();
  expect((await api(page, 'fs.read', { path: 'src/main.cpp' })).content as string).toContain('delay(20);');
  await page.getByTestId('apply-all').click();
  await expect.poll(async () => (await api(page, 'fs.read', { path: 'src/main.cpp' })).content as string).toContain('delay(10);');

  await page.screenshot({ path: 'test-results/e2e-final.png' });
  expect(errors).toEqual([]);
});

test('wiring errors appear in Problems and block upload', async ({ page }) => {
  await page.goto(`/#token=${E2E.token}`);
  const snap = (await api(page, 'project.current')) as { circuit: { wires: { id: string; from: { node: string; pin: string }; to: { node: string; pin: string } }[] } };
  // Short 5V to GND in the saved model -> blocking.
  await api(page, 'project.saveModel', { circuit: { ...snap.circuit, wires: [...snap.circuit.wires, { id: 'wshort', from: { node: 'board', pin: '5V' }, to: { node: 'board', pin: 'GND' } }] } });
  await page.reload();
  await page.getByTestId('panel-problems').click();
  await expect(page.getByTestId('problems-list')).toContainText('Short circuit');
  const build = (await api(page, 'build.run')) as { status: string };
  expect(build.status).toBe('blocked');
});
