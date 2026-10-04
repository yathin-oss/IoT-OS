import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { createApi } from '../api';
import { createServices, type Services } from '../services';
import { FileSecretStore, SafeStorageSecretStore } from '../settings/secrets';

/**
 * Electron entry point. The renderer is sandboxed (contextIsolation, no Node
 * integration) and reaches services only through the preload bridge, which
 * exposes exactly one generic call function plus event subscription.
 */

const DEV_URL = process.env['IOTOS_DEV_SERVER_URL'];
const RENDERER_INDEX = join(__dirname, '../renderer/index.html');
let services: Services | null = null;
let win: BrowserWindow | null = null;

function isTrustedSender(url: string): boolean {
  if (DEV_URL) return url.startsWith(DEV_URL);
  return url.startsWith(pathToFileURL(RENDERER_INDEX).toString().replace(/index\.html$/, ''));
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#14161a',
    title: 'IoT-OS',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  w.once('ready-to-show', () => w.show());
  // No navigation away from the app and no new windows; external links go through the allowlisted API.
  w.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedSender(url)) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (DEV_URL) void w.loadURL(DEV_URL);
  else void w.loadFile(RENDERER_INDEX);
  return w;
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  const secretFile = join(dataDir, 'secrets.enc.json');
  const secretStore = safeStorage.isEncryptionAvailable() ? new SafeStorageSecretStore(secretFile, safeStorage) : new FileSecretStore(join(dataDir, 'secrets.json'));
  services = createServices({
    dataDir,
    defaultWorkspaceDir: join(app.getPath('documents'), 'IoT-OS Projects'),
    runtime: { kind: 'electron', version: app.getVersion(), electronVersion: process.versions.electron ?? null },
    secretStore,
    trash: (abs) => shell.trashItem(abs),
  });
  const api = createApi(services, {
    info: () => ({ version: app.getVersion(), runtime: 'electron', platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, electronVersion: process.versions.electron ?? null, canPickDirectories: true }),
    pickDirectory: async (title) => {
      const r = win ? await dialog.showOpenDialog(win, { title: title ?? 'Choose folder', properties: ['openDirectory', 'createDirectory'] }) : null;
      return r && !r.canceled && r.filePaths[0] ? r.filePaths[0] : null;
    },
    openExternal: (url) => shell.openExternal(url),
  });

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          DEV_URL
            ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ws:"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'",
        ],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  ipcMain.handle('iotos:call', async (event, msg: { method?: unknown; args?: unknown }) => {
    if (!event.senderFrame || !isTrustedSender(event.senderFrame.url)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Untrusted sender' } };
    if (typeof msg?.method !== 'string') return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'method required' } };
    return api.call(msg.method, msg.args);
  });
  services.bus.onAny((topic, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('iotos:event', topic, payload);
  });

  win = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
}).catch((err: unknown) => {
  console.error('IoT-OS failed to start', err);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void services?.dispose();
});
