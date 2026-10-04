import { access, constants, mkdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import type { SetupCheck, SetupReport } from '../../core/ipc/contract';
import { getRegistry } from '../../core/registry/registry';
import type { AiService } from '../ai/aiService';
import type { DriverHub } from '../drivers/driverHub';
import type { ToolchainManager } from '../toolchain/toolchainManager';

/**
 * First-run / environment verification: runtime, toolchains, board packages,
 * serial access, drivers and AI configuration — each with a concrete fix.
 */
export class SetupService {
  constructor(
    private readonly toolchains: ToolchainManager,
    private readonly drivers: DriverHub,
    private readonly ai: AiService,
    private readonly workspaceDir: () => string,
    private readonly runtime: { name: string; version: string },
  ) {}

  async check(): Promise<SetupReport> {
    const checks: SetupCheck[] = [];
    checks.push({ id: 'runtime', title: 'Application runtime', status: 'ok', detail: `${this.runtime.name} ${this.runtime.version} on ${process.platform}/${process.arch}`, fix: null, action: null });

    const ws = this.workspaceDir();
    try {
      await mkdir(ws, { recursive: true });
      await access(ws, constants.W_OK);
      checks.push({ id: 'workspace', title: 'Projects folder', status: 'ok', detail: ws, fix: null, action: null });
    } catch {
      checks.push({ id: 'workspace', title: 'Projects folder', status: 'error', detail: `${ws} is not writable`, fix: 'Choose another projects folder in Settings.', action: { kind: 'open-settings', section: 'general' } });
    }

    const tools = await this.toolchains.status(true);
    const importance: Record<string, string> = {
      'arduino-cli': 'Required to build and upload Arduino C++ / ESP32 C++ projects.',
      mpremote: 'Required to deploy MicroPython projects.',
      esptool: 'Optional: identifies ESP chips and installs MicroPython firmware.',
      'mpy-cross': 'Optional: exact MicroPython syntax checking (Python 3 is used otherwise).',
      python3: 'Needed by esptool and mpremote.',
      avrdude: 'Installed automatically with the Arduino AVR board package.',
      git: 'Optional: version control for new projects.',
    };
    for (const t of tools) {
      const required = t.id === 'arduino-cli' || t.id === 'mpremote';
      const status: SetupCheck['status'] = t.state === 'installed' ? 'ok' : t.state === 'missing' ? (required ? 'missing' : 'warning') : t.state === 'unsupported' ? 'ok' : 'error';
      checks.push({
        id: `tool:${t.id}`,
        title: t.name,
        status,
        detail: t.state === 'installed' ? `${t.version ?? ''} ${t.path ?? ''}`.trim() : `${t.message} ${importance[t.id] ?? ''}`.trim(),
        fix: t.fix,
        action: t.docsUrl && t.state !== 'installed' ? { kind: 'open-url', url: t.docsUrl } : null,
      });
    }

    const cliReady = tools.find((t) => t.id === 'arduino-cli')?.state === 'installed';
    for (const core of await this.toolchains.cores()) {
      const boards = core.boards.map((b) => getRegistry().getBoard(b)?.name ?? b).join(', ');
      checks.push({
        id: `core:${core.core}`,
        title: `Board package ${core.core}`,
        status: core.installed ? 'ok' : cliReady ? 'missing' : 'warning',
        detail: core.installed ? `Installed ${core.installed} (${boards})` : `Needed for: ${boards}${cliReady ? '' : ' — install Arduino CLI first'}`,
        fix: core.installed ? null : `arduino-cli core install ${core.core}${core.indexUrl ? ` --additional-urls ${core.indexUrl}` : ''}`,
        action: !core.installed && cliReady ? { kind: 'install-core', boardId: core.boards[0]! } : null,
      });
    }

    checks.push(await this.serialAccess());

    const scan = await this.drivers.scan();
    const missing = scan.devices.filter((d) => d.driverState === 'missing');
    checks.push({
      id: 'drivers',
      title: 'USB-serial drivers',
      status: !scan.supported ? 'warning' : missing.length ? 'missing' : 'ok',
      detail: scan.supported ? `${scan.message}${scan.devices.length ? ` (${scan.devices.map((d) => d.chip ?? d.name).join(', ')})` : ''}` : scan.message,
      fix: missing.length ? missing.map((m) => `${m.chip ?? m.name}: ${m.driver.guidance}`).join(' ') : null,
      action: missing[0]?.driver.downloadUrl ? { kind: 'open-url', url: missing[0].driver.downloadUrl } : null,
    });

    const ai = this.ai.status();
    checks.push({
      id: 'ai',
      title: 'AI provider',
      status: ai.configured ? 'ok' : 'warning',
      detail: ai.message,
      fix: ai.configured ? null : 'Add an API key in Settings → AI. All non-AI features work without one.',
      action: ai.configured ? null : { kind: 'open-settings', section: 'ai' },
    });
    return { checks, generatedAt: new Date().toISOString() };
  }

  private async serialAccess(): Promise<SetupCheck> {
    if (process.platform !== 'linux') {
      return { id: 'serial-access', title: 'Serial port access', status: 'ok', detail: 'No special permissions are required on this OS.', fix: null, action: null };
    }
    const user = userInfo().username;
    const groups = await readFile('/etc/group', 'utf8').catch(() => '');
    const member = groups.split('\n').some((l) => /^(dialout|uucp):/.test(l) && (l.split(':')[3] ?? '').split(',').includes(user));
    return member
      ? { id: 'serial-access', title: 'Serial port access', status: 'ok', detail: `${user} is in the dialout/uucp group.`, fix: null, action: null }
      : { id: 'serial-access', title: 'Serial port access', status: 'warning', detail: `${user} is not in the dialout/uucp group; opening ports may fail.`, fix: `sudo usermod -aG dialout ${user} (then log out and back in)`, action: null };
  }
}
