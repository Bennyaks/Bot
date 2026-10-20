"use strict";

// electron/preload.ts
var import_electron = require("electron");
var listenerCleanups = [];
function on(channel, cb) {
  const handler = (_event, data) => cb(data);
  import_electron.ipcRenderer.on(channel, handler);
  listenerCleanups.push(() => import_electron.ipcRenderer.removeListener(channel, handler));
}
var bridge = {
  connect: (args) => import_electron.ipcRenderer.invoke("mt5:connect", args),
  disconnect: () => import_electron.ipcRenderer.invoke("mt5:disconnect"),
  approve: (candidateId, overrides) => import_electron.ipcRenderer.invoke("mt5:approve", { candidateId, overrides }),
  skip: (candidateId) => import_electron.ipcRenderer.invoke("mt5:skip", { candidateId }),
  closePosition: (tradeId) => import_electron.ipcRenderer.invoke("mt5:closePosition", { tradeId }),
  status: () => import_electron.ipcRenderer.invoke("mt5:status"),
  positions: () => import_electron.ipcRenderer.invoke("mt5:positions"),
  history: () => import_electron.ipcRenderer.invoke("mt5:history"),
  onLog: (cb) => on("mt5:log", cb),
  onStatus: (cb) => on("mt5:statusUpdate", cb),
  onCandidate: (cb) => on("mt5:candidate", cb),
  onCandidateExpired: (cb) => on("mt5:candidateExpired", cb),
  onPositions: (cb) => on("mt5:positionsUpdate", cb),
  removeAllListeners: () => {
    for (const cleanup of listenerCleanups.splice(0)) cleanup();
  }
};
import_electron.contextBridge.exposeInMainWorld("mt5", bridge);
