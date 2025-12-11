const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const db = require('./database');

const isDev = !app.isPackaged;
let mainWindow;

// Data directory
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, '..', 'data');

// Initialize database
db.initDatabase(DATA_DIR);

// ============================================================================
// Ping Monitoring
// ============================================================================
let pingProcess = null;
let lastPingTime = 0;
let lastSeq = 0;
let lastPingReceivedAt = 0; // Track when last ping was received
let pingWatchdog = null; // Timer to detect timeouts
const TIMEOUT_THRESHOLD = 2;

function startPing() {
  if (pingProcess) return;

  lastPingTime = Math.floor(Date.now() / 1000);
  lastSeq = 0;
  lastPingReceivedAt = Date.now();

  pingProcess = spawn('ping', ['google.com']);

  // Start watchdog timer to detect timeouts (check every second)
  pingWatchdog = setInterval(() => {
    const now = Date.now();
    const timeSinceLastPing = now - lastPingReceivedAt;

    // If no ping received for more than 1.5 seconds, record a timeout marker
    if (timeSinceLastPing > 1500 && pingProcess) {
      db.insertTimeout();

      // Format local time for display
      const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace('T', ' ').substring(0, 19);
      sendToRenderer('ping-result', { ts, time: 0, seq: null, ttl: null, timeout: true });
    }
  }, 1000);

  pingProcess.stdout.on('data', (data) => {
    const line = data.toString();
    const match = line.match(/icmp_seq=(\d+).*ttl=(\d+).*time=([\d.]+)/);

    if (match) {
      const currentTime = Math.floor(Date.now() / 1000);
      const seq = parseInt(match[1]);
      const ttl = parseInt(match[2]);
      const time = parseFloat(match[3]);

      // Update last ping received time
      lastPingReceivedAt = Date.now();

      // Save to database
      db.insertPing(time, seq, ttl);

      // Detect timeout/gap
      if (lastPingTime > 0) {
        const gap = currentTime - lastPingTime;
        if (gap > TIMEOUT_THRESHOLD) {
          db.logIssue('TIMEOUT', `Gap ${gap}s (seq ${lastSeq}->${seq})`);
          db.insertGap(gap, lastSeq, seq);
          sendToRenderer('ping-timeout', { gap, seqFrom: lastSeq, seqTo: seq });
        }
      }

      // Detect packet loss
      if (lastSeq > 0) {
        const expected = lastSeq + 1;
        if (seq > expected) {
          const lost = seq - expected;
          db.logIssue('PACKET_LOSS', `${lost} packets lost (seq ${lastSeq}->${seq})`);
          sendToRenderer('packet-loss', { lost, seqFrom: lastSeq, seqTo: seq });
        }
      }

      lastPingTime = currentTime;
      lastSeq = seq;

      // Format local time for display
      const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace('T', ' ').substring(0, 19);
      sendToRenderer('ping-result', { ts, time, seq, ttl });
    }
  });

  pingProcess.on('close', () => {
    pingProcess = null;
    if (pingWatchdog) {
      clearInterval(pingWatchdog);
      pingWatchdog = null;
    }
  });

  pingProcess.on('error', (err) => {
    db.logIssue('PING_ERROR', err.message);
    pingProcess = null;
    if (pingWatchdog) {
      clearInterval(pingWatchdog);
      pingWatchdog = null;
    }
  });
}

function stopPing() {
  if (pingProcess) {
    pingProcess.kill();
    pingProcess = null;
  }
  if (pingWatchdog) {
    clearInterval(pingWatchdog);
    pingWatchdog = null;
  }
}

// ============================================================================
// Speedtest
// ============================================================================
let speedtestRunning = false;

function runSpeedtest() {
  return new Promise((resolve) => {
    if (speedtestRunning) {
      resolve({ success: false, error: 'Speedtest already running' });
      return;
    }

    speedtestRunning = true;
    sendToRenderer('speedtest-status', { status: 'running' });

    // Get average ping from recent pings
    const pingStats = db.getPingStats(5);
    const pingAvg = pingStats.avg !== 'N/A' ? parseFloat(pingStats.avg) : null;

    exec('speedtest-cli --csv', { timeout: 120000 }, (error, stdout, stderr) => {
      speedtestRunning = false;

      if (error) {
        db.insertSpeedtest(null, null, null, null, pingAvg);
        db.logIssue('SPEEDTEST_FAIL', error.message);
        sendToRenderer('speedtest-status', { status: 'failed', error: error.message });
        resolve({ success: false, error: error.message });
        return;
      }

      try {
        const parts = stdout.trim().split(',');
        const server = parts[2] || 'Unknown';
        const latency = parseFloat(parts[5]) || 0;
        const download = (parseFloat(parts[6] || 0) / 1000000);
        const upload = (parseFloat(parts[7] || 0) / 1000000);

        db.insertSpeedtest(server, latency, download, upload, pingAvg);

        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const result = {
          server,
          latency: latency.toFixed(1),
          download: download.toFixed(2),
          upload: upload.toFixed(2),
          timestamp: ts
        };

        sendToRenderer('speedtest-status', { status: 'completed', result });
        resolve({ success: true, result });
      } catch (e) {
        db.insertSpeedtest(null, null, null, null, pingAvg);
        db.logIssue('SPEEDTEST_PARSE_ERROR', e.message);
        sendToRenderer('speedtest-status', { status: 'failed', error: e.message });
        resolve({ success: false, error: e.message });
      }
    });
  });
}

// ============================================================================
// Helper: Send to Renderer
// ============================================================================
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ============================================================================
// Window Creation
// ============================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 1000,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icons', 'icon.png'),
    title: 'Network Monitoring',
    backgroundColor: '#0a0a0a',
    show: false
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = path.join(__dirname, '..', 'out', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  Menu.setApplicationMenu(null);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================================
// IPC Handlers
// ============================================================================
ipcMain.handle('ping-start', () => {
  startPing();
  return { success: true };
});

ipcMain.handle('ping-stop', () => {
  stopPing();
  return { success: true };
});

ipcMain.handle('ping-status', () => {
  return { running: pingProcess !== null };
});

ipcMain.handle('speedtest-run', async () => {
  return await runSpeedtest();
});

ipcMain.handle('speedtest-status', () => {
  return { running: speedtestRunning };
});

ipcMain.handle('get-ping-stats', (event, minutes) => {
  return db.getPingStats(minutes);
});

ipcMain.handle('get-packet-loss', () => {
  return db.getPacketLoss();
});

ipcMain.handle('get-gap-stats', () => {
  return db.getGapStats();
});

ipcMain.handle('get-speedtest-stats', (event, minutes) => {
  return db.getSpeedtestStats(minutes);
});

ipcMain.handle('get-recent-pings', (event, count) => {
  return db.getRecentPings(count);
});

ipcMain.handle('get-ping-history', (event, minutes, intervalSec) => {
  return db.getPingHistory(minutes, intervalSec);
});

ipcMain.handle('get-speedtest-history', (event, minutes) => {
  return db.getSpeedtestHistory(minutes);
});

ipcMain.handle('get-gap-history', (event, minutes, groupBy) => {
  return db.getGapHistory(minutes, groupBy);
});

ipcMain.handle('get-app-info', () => {
  return {
    version: app.getVersion(),
    platform: process.platform,
    dataDir: DATA_DIR
  };
});

// ============================================================================
// Auto Speedtest Scheduler (every 15 minutes)
// ============================================================================
const SPEEDTEST_INTERVAL = 15 * 60 * 1000;
let speedtestTimer = null;
let cleanupTimer = null;

function startSpeedtestScheduler() {
  setTimeout(() => {
    runSpeedtest();
  }, 10000);

  speedtestTimer = setInterval(() => {
    runSpeedtest();
  }, SPEEDTEST_INTERVAL);
}

function stopSpeedtestScheduler() {
  if (speedtestTimer) {
    clearInterval(speedtestTimer);
    speedtestTimer = null;
  }
}

function startCleanupScheduler() {
  // Run cleanup every hour
  cleanupTimer = setInterval(() => {
    db.cleanupOldData();
  }, 60 * 60 * 1000);

  // Run initial cleanup
  setTimeout(() => {
    db.cleanupOldData();
  }, 5000);
}

function stopCleanupScheduler() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ============================================================================
// App Lifecycle
// ============================================================================
app.whenReady().then(() => {
  createWindow();
  startPing();
  startSpeedtestScheduler();
  startCleanupScheduler();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopPing();
  stopSpeedtestScheduler();
  stopCleanupScheduler();
  db.closeDatabase();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopPing();
  stopSpeedtestScheduler();
  stopCleanupScheduler();
  db.closeDatabase();
});
