/**
 * electron/main.ts
 * ------------------
 * Thin IPC wiring around LiveTradingManager (electron/main/liveTradingManager.ts),
 * which holds all the actual trading logic — this file's only job is to
 * create the BrowserWindow and translate LiveTradingManager's callbacks and
 * ipcMain handlers to/from the renderer.
 *
 * Built with esbuild into dist-electron/main.cjs (see package.json
 * "electron:build-main") — Electron loads that compiled file, not this
 * TypeScript source directly.
 */
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import * as path from 'node:path';
import { LiveTradingManager, type LiveConnectOptions } from './main/liveTradingManager';

let mainWindow: BrowserWindow | null = null;
let manager: LiveTradingManager | null = null;

function send(channel: string, payload: unknown) {
  mainWindow?.webContents.send(channel, payload);
}

function getManager(): LiveTradingManager {
  if (!manager) {
    manager = new LiveTradingManager(
      {
        onLog: (entry) => send('mt5:log', entry),
        onStatus: (status) => send('mt5:statusUpdate', status),
        onCandidate: (candidate) => send('mt5:candidate', candidate),
        onCandidateExpired: (candidateId) => send('mt5:candidateExpired', candidateId),
        onPositions: (positions) => send('mt5:positionsUpdate', positions),
      },
      app.getPath('userData')
    );
  }
  return manager;
}

ipcMain.handle(
  'mt5:connect',
  async (
    _event: IpcMainInvokeEvent,
    args: LiveConnectOptions & { watchlist?: string[]; pollSeconds?: number }
  ) => {
    const m = getManager();
    if (args.watchlist) m.setWatchlist(args.watchlist);
    if (args.pollSeconds) m.setPollSeconds(args.pollSeconds);
    return m.connect(args);
  }
);

ipcMain.handle('mt5:disconnect', () => {
  getManager().disconnect();
  return { ok: true };
});

ipcMain.handle(
  'mt5:approve',
  async (_event: IpcMainInvokeEvent, args: { candidateId: string; overrides?: { stop?: number; target?: number } }) => {
    await getManager().approve(args.candidateId, args.overrides);
    return { ok: true };
  }
);

ipcMain.handle('mt5:skip', (_event: IpcMainInvokeEvent, args: { candidateId: string }) => {
  getManager().skip(args.candidateId);
  return { ok: true };
});

ipcMain.handle('mt5:closePosition', async (_event: IpcMainInvokeEvent, args: { tradeId: string }) => {
  await getManager().closePosition(args.tradeId);
  return { ok: true };
});

ipcMain.handle('mt5:status', () => getManager().status());
ipcMain.handle('mt5:positions', () => getManager().positions());
ipcMain.handle('mt5:history', () => getManager().getHistory());

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  manager?.disconnect();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
