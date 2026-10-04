import { mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { autoDetect } from '@serialport/bindings-cpp';
import { AiService, type ProviderFactory } from './ai/aiService';
import { createProvider } from './ai/providers';
import { BuildPipeline } from './build/buildPipeline';
import { DeviceManager, type PortLister } from './devices/deviceManager';
import { DriverHub, LinuxUsbEnumerator, MacUsbEnumerator, WindowsUsbEnumerator, type UsbEnumerator } from './drivers/driverHub';
import { EventBus } from './events';
import { ArduinoCliUploadAdapter, FlashPipeline, MpremoteDeployAdapter } from './flash/flashPipeline';
import { ArduinoLibraryProvider, LibraryManager, MipLibraryProvider } from './libraries/libraryManager';
import { Logger } from './logging/logger';
import { ProcessRunner } from './process/runner';
import { ToolResolver } from './process/tools';
import { ProjectService } from './project/projectService';
import { ProposalStore } from './proposals/proposalStore';
import { SerialManager, type SerialBinding } from './serial/serialManager';
import { EnvOverrideSecretStore, FileSecretStore, type SecretStore } from './settings/secrets';
import { SECRET_ENV, SettingsService } from './settings/settings';
import { SetupService } from './setup/setupService';
import { ToolchainManager } from './toolchain/toolchainManager';
import { IotosError } from '../core/errors';

export interface ServiceOptions {
  /** Per-user data directory (settings, logs, workspace index). */
  dataDir: string;
  /** Default projects folder. */
  defaultWorkspaceDir?: string;
  runtime: { kind: 'electron' | 'browser-host'; version: string; electronVersion: string | null };
  /** Secret store; defaults to a 0600 file in dataDir (overridden by env vars). */
  secretStore?: SecretStore;
  /** Move a path to the OS trash; defaults to an IoT-OS trash folder in dataDir. */
  trash?: (abs: string) => Promise<void>;
  /** Test seams. */
  serialBinding?: SerialBinding;
  portLister?: PortLister;
  usbEnumerator?: UsbEnumerator | null;
  providerFactory?: ProviderFactory;
  env?: NodeJS.ProcessEnv;
  startDevicePolling?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export type Services = ReturnType<typeof createServices>;

export function createServices(opts: ServiceOptions) {
  const bus = new EventBus();
  const logger = new Logger(join(opts.dataDir, 'logs', 'iotos.log'), opts.logLevel ?? 'info');
  logger.onEntry((e) => bus.emit('log.entry', e));
  const log = (s: string) => logger.scope(s);

  const secrets = new EnvOverrideSecretStore(opts.secretStore ?? new FileSecretStore(join(opts.dataDir, 'secrets.json')), opts.env ?? process.env, SECRET_ENV);
  const settings = new SettingsService(join(opts.dataDir, 'settings.json'), secrets, { workspaceDir: opts.defaultWorkspaceDir ?? join(homedir(), 'IoT-OS Projects') }, (v) => logger.registerSecret(v));

  const resolver = new ToolResolver((id) => settings.toolPath(id), opts.env ?? process.env);
  const runner = new ProcessRunner(resolver, bus, logger);

  const trash =
    opts.trash ??
    (async (abs: string) => {
      const dir = join(opts.dataDir, 'trash');
      await mkdir(dir, { recursive: true });
      await rename(abs, join(dir, `${Date.now()}-${basename(abs)}`));
    });

  const projects = new ProjectService(join(opts.dataDir, 'workspace.json'), () => settings.raw.workspaceDir, bus, log('project'), { trash, runner });
  const proposals = new ProposalStore(projects, bus, log('proposals'));
  bus.on('project.changed', (snap) => {
    if (!snap) proposals.clear();
  });

  const binding = opts.serialBinding ?? (autoDetect() as unknown as SerialBinding);
  const portLister: PortLister = opts.portLister ?? { list: () => binding.list() };
  const devices = new DeviceManager(portLister, bus, log('devices'), runner);
  const serial = new SerialManager(binding, bus, devices, log('serial'), settings.raw.serial.maxLines);

  const toolchains = new ToolchainManager(runner, resolver, log('toolchain'));
  const resolveDevicePort = (): string => {
    const p = projects.openProject?.model.manifest.runtime.port;
    const connected = devices.list().filter((d) => d.state === 'CONNECTED');
    if (p && connected.some((d) => d.port === p)) return p;
    if (connected.length === 1) return connected[0]!.port;
    throw new IotosError('DEVICE_NOT_FOUND', connected.length ? 'Several boards are connected; upload once to choose the project port' : 'Connect the MicroPython board first', {
      hint: 'MicroPython packages are installed onto the device.',
    });
  };
  const libraries = new LibraryManager(
    { arduino: new ArduinoLibraryProvider(toolchains.arduino), 'micropython-mip': new MipLibraryProvider(runner, resolveDevicePort) },
    projects,
    toolchains.arduino,
    log('libraries'),
  );
  const build = new BuildPipeline(projects, toolchains, libraries, runner, bus, log('build'));
  const flash = new FlashPipeline(projects, build, devices, serial, runner, [new ArduinoCliUploadAdapter(toolchains), new MpremoteDeployAdapter(runner)], bus, log('flash'));

  const usbEnumerator =
    opts.usbEnumerator !== undefined
      ? opts.usbEnumerator
      : process.platform === 'darwin'
        ? new MacUsbEnumerator(runner)
        : process.platform === 'linux'
          ? new LinuxUsbEnumerator()
          : process.platform === 'win32'
            ? new WindowsUsbEnumerator(runner)
            : null;
  const drivers = new DriverHub(usbEnumerator, portLister, log('drivers'));
  // Optional per-provider endpoint override (proxies/gateways): IOTOS_ANTHROPIC_BASE_URL etc.
  const env = opts.env ?? process.env;
  const providerFactory: ProviderFactory =
    opts.providerFactory ??
    ((id, cfg) => {
      const baseUrl = env[`IOTOS_${id.toUpperCase()}_BASE_URL`];
      return createProvider(id, baseUrl ? { ...cfg, baseUrl } : cfg);
    });
  const ai = new AiService(settings, projects, proposals, build, serial, devices, toolchains, bus, log('ai'), providerFactory);
  const setup = new SetupService(toolchains, drivers, ai, () => settings.raw.workspaceDir, { name: opts.runtime.kind === 'electron' ? 'Electron' : 'Node.js', version: opts.runtime.electronVersion ?? process.versions.node });

  if (opts.startDevicePolling !== false) devices.start();
  log('app').info('services started', { runtime: opts.runtime.kind, dataDir: opts.dataDir, secretStorage: secrets.kind });

  return {
    opts,
    trash,
    bus,
    logger,
    settings,
    resolver,
    runner,
    projects,
    proposals,
    devices,
    serial,
    toolchains,
    libraries,
    build,
    flash,
    drivers,
    ai,
    setup,
    async dispose(): Promise<void> {
      devices.stop();
      await serial.close().catch(() => undefined);
      build.cancel();
      flash.cancel();
      ai.cancel();
      projects.close();
    },
  };
}
