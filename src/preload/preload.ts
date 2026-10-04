import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * The only surface exposed to the renderer: a generic RPC call (validated and
 * dispatched by the main-process router) and event subscription.
 */
contextBridge.exposeInMainWorld('iotosBridge', {
  call: (method: string, args: unknown) => ipcRenderer.invoke('iotos:call', { method, args }),
  onEvent: (cb: (topic: string, payload: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, topic: string, payload: unknown) => cb(topic, payload);
    ipcRenderer.on('iotos:event', listener);
    return () => ipcRenderer.removeListener('iotos:event', listener);
  },
});
