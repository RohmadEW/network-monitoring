const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods for the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // Ping controls
  pingStart: () => ipcRenderer.invoke('ping-start'),
  pingStop: () => ipcRenderer.invoke('ping-stop'),
  pingStatus: () => ipcRenderer.invoke('ping-status'),

  // Speedtest controls
  speedtestRun: () => ipcRenderer.invoke('speedtest-run'),
  speedtestStatus: () => ipcRenderer.invoke('speedtest-status'),

  // Statistics
  getPingStats: (minutes) => ipcRenderer.invoke('get-ping-stats', minutes),
  getPacketLoss: () => ipcRenderer.invoke('get-packet-loss'),
  getGapStats: () => ipcRenderer.invoke('get-gap-stats'),
  getSpeedtestStats: (minutes) => ipcRenderer.invoke('get-speedtest-stats', minutes),
  getRecentPings: (count) => ipcRenderer.invoke('get-recent-pings', count),

  // History for charts
  getPingHistory: (minutes, intervalSec) => ipcRenderer.invoke('get-ping-history', minutes, intervalSec),
  getSpeedtestHistory: (minutes) => ipcRenderer.invoke('get-speedtest-history', minutes),
  getGapHistory: (minutes, groupBy) => ipcRenderer.invoke('get-gap-history', minutes, groupBy),

  // Event listeners
  onPingResult: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ping-result', listener);
    return () => ipcRenderer.removeListener('ping-result', listener);
  },

  onPingTimeout: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ping-timeout', listener);
    return () => ipcRenderer.removeListener('ping-timeout', listener);
  },

  onPacketLoss: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('packet-loss', listener);
    return () => ipcRenderer.removeListener('packet-loss', listener);
  },

  onSpeedtestStatus: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('speedtest-status', listener);
    return () => ipcRenderer.removeListener('speedtest-status', listener);
  }
});
