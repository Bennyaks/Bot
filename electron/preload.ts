/**
 * electron/preload.ts
 * ----------------------
 * Runs in a privileged-but-isolated context between the renderer (the React
 * dashboard) and the main process. contextIsolation is on and
 * nodeIntegration is off in main.ts's BrowserWindow, so the renderer has
 * zero direct access to Node or Electron APIs — this is the only door, and
 * it only exposes exactly the methods below. The MetaApi token never
 * touches this file except as a parameter passed straight through to the
 * main process over IPC.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { MT5Bridge } from '../src/types/electron';

const listenerCleanups: Array<() => void> = [];

function on<T>(channel: string, cb: (data: T) => void) {
  const handler = (_event: Electron.IpcRendererEvent, data: T) => cb(data);
  ipcRenderer.on(channel, handler);
  listenerCleanups.push(() => ipcRenderer.removeListener(channel, handler));
}

const bridge: MT5Bridge = {
  connect: (args) => ipcRenderer.invoke('mt5:connect', args),
  disconnect: () => ipcRenderer.invoke('mt5:disconnect'),
  approve: (candidateId, overrides) => ipcRenderer.invoke('mt5:approve', { candidateId, overrides }),
  skip: (candidateId) => ipcRenderer.invoke('mt5:skip', { candidateId }),
  closePosition: (tradeId) => ipcRenderer.invoke('mt5:closePosition', { tradeId }),
  status: () => ipcRenderer.invoke('mt5:status'),
  positions: () => ipcRenderer.invoke('mt5:positions'),
  history: () => ipcRenderer.invoke('mt5:history'),
  onLog: (cb) => on('mt5:log', cb),
  onStatus: (cb) => on('mt5:statusUpdate', cb),
  onCandidate: (cb) => on('mt5:candidate', cb),
  onCandidateExpired: (cb) => on('mt5:candidateExpired', cb),
  onPositions: (cb) => on('mt5:positionsUpdate', cb),
  removeAllListeners: () => {
    for (const cleanup of listenerCleanups.splice(0)) cleanup();
  },
};

contextBridge.exposeInMainWorld('mt5', bridge);
