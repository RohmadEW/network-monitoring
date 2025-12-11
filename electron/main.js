const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

const isDev = !app.isPackaged;
let mainWindow;

// ============================================================================
// Data Directory & File Paths
// ============================================================================
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getPingLog() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(DATA_DIR, `ping_${date}.csv`);
}

function getSpeedtestLog() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(DATA_DIR, `speedtest_${date}.csv`);
}

function getGapLog() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(DATA_DIR, `ping_gaps_${date}.csv`);
}

function getIssueLog() {
  return path.join(DATA_DIR, 'network_issues.log');
}

// ============================================================================
// Ping Monitoring (runs continuously)
// ============================================================================
let pingProcess = null;
let lastPingTime = 0;
let lastSeq = 0;
const TIMEOUT_THRESHOLD = 2;

function logIssue(type, message) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const logLine = `[${ts}] ${type}: ${message}\n`;
  fs.appendFileSync(getIssueLog(), logLine);
}

function logGap(gapSeconds, seqFrom, seqTo) {
  const gapLog = getGapLog();
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);

  if (!fs.existsSync(gapLog)) {
    fs.writeFileSync(gapLog, 'Timestamp,Gap (detik),Seq From,Seq To\n');
  }

  fs.appendFileSync(gapLog, `${ts},${gapSeconds},${seqFrom},${seqTo}\n`);
}

function startPing() {
  if (pingProcess) return;

  lastPingTime = Math.floor(Date.now() / 1000);
  lastSeq = 0;

  pingProcess = spawn('ping', ['google.com']);

  pingProcess.stdout.on('data', (data) => {
    const line = data.toString();

    // Parse ping response: "64 bytes from ... icmp_seq=X ttl=X time=X ms"
    const match = line.match(/icmp_seq=(\d+).*ttl=(\d+).*time=([\d.]+)/);
    if (match) {
      const currentTime = Math.floor(Date.now() / 1000);
      const seq = parseInt(match[1]);
      const ttl = parseInt(match[2]);
      const time = parseFloat(match[3]);
      const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);

      // Log to CSV
      const pingLog = getPingLog();
      fs.appendFileSync(pingLog, `${ts},${time},${seq},${ttl}\n`);

      // Detect timeout/gap
      if (lastPingTime > 0) {
        const gap = currentTime - lastPingTime;
        if (gap > TIMEOUT_THRESHOLD) {
          logIssue('TIMEOUT', `Gap ${gap}s (seq ${lastSeq}->${seq})`);
          logGap(gap, lastSeq, seq);
          sendToRenderer('ping-timeout', { gap, seqFrom: lastSeq, seqTo: seq });
        }
      }

      // Detect packet loss
      if (lastSeq > 0) {
        const expected = lastSeq + 1;
        if (seq > expected) {
          const lost = seq - expected;
          logIssue('PACKET_LOSS', `${lost} paket hilang (seq ${lastSeq}->${seq})`);
          sendToRenderer('packet-loss', { lost, seqFrom: lastSeq, seqTo: seq });
        }
      }

      lastPingTime = currentTime;
      lastSeq = seq;

      // Send realtime ping to renderer
      sendToRenderer('ping-result', { ts, time, seq, ttl });
    }
  });

  pingProcess.on('close', () => {
    pingProcess = null;
  });

  pingProcess.on('error', (err) => {
    logIssue('PING_ERROR', err.message);
    pingProcess = null;
  });
}

function stopPing() {
  if (pingProcess) {
    pingProcess.kill();
    pingProcess = null;
  }
}

// ============================================================================
// Speedtest (runs separately, doesn't stop ping)
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

    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const speedtestLog = getSpeedtestLog();

    // Create header if file doesn't exist
    if (!fs.existsSync(speedtestLog)) {
      fs.writeFileSync(speedtestLog, 'Timestamp,Ping Avg (ms),Server,Latency (ms),Download (Mbit/s),Upload (Mbit/s)\n');
    }

    // Get average ping from last 100 entries
    let pingAvg = 'N/A';
    const pingLog = getPingLog();
    if (fs.existsSync(pingLog)) {
      try {
        const lines = fs.readFileSync(pingLog, 'utf8').trim().split('\n').slice(-100);
        const pings = lines.map(l => parseFloat(l.split(',')[1])).filter(p => !isNaN(p));
        if (pings.length > 0) {
          pingAvg = (pings.reduce((a, b) => a + b, 0) / pings.length).toFixed(2);
        }
      } catch (e) {}
    }

    exec('speedtest-cli --csv', { timeout: 120000 }, (error, stdout, stderr) => {
      speedtestRunning = false;

      if (error) {
        fs.appendFileSync(speedtestLog, `${ts},${pingAvg},N/A,N/A,N/A,N/A\n`);
        logIssue('SPEEDTEST_FAIL', error.message);
        sendToRenderer('speedtest-status', { status: 'failed', error: error.message });
        resolve({ success: false, error: error.message });
        return;
      }

      try {
        const parts = stdout.trim().split(',');
        const server = parts[2] || 'Unknown';
        const latency = parts[5] || '0';
        const download = (parseFloat(parts[6] || 0) / 1000000).toFixed(2);
        const upload = (parseFloat(parts[7] || 0) / 1000000).toFixed(2);

        fs.appendFileSync(speedtestLog, `${ts},${pingAvg},${server},${latency},${download},${upload}\n`);

        const result = { server, latency, download, upload, timestamp: ts };
        sendToRenderer('speedtest-status', { status: 'completed', result });
        resolve({ success: true, result });
      } catch (e) {
        fs.appendFileSync(speedtestLog, `${ts},${pingAvg},N/A,N/A,N/A,N/A\n`);
        logIssue('SPEEDTEST_PARSE_ERROR', e.message);
        sendToRenderer('speedtest-status', { status: 'failed', error: e.message });
        resolve({ success: false, error: e.message });
      }
    });
  });
}

// ============================================================================
// Statistics Calculation
// ============================================================================
function calcPingStats(minutes) {
  const pingLog = getPingLog();
  if (!fs.existsSync(pingLog)) return { avg: 'N/A', med: 'N/A', std: 'N/A', min: 'N/A', max: 'N/A', count: 0 };

  const since = new Date(Date.now() - minutes * 60 * 1000);
  const sinceStr = since.toISOString().replace('T', ' ').substring(0, 19);

  try {
    const lines = fs.readFileSync(pingLog, 'utf8').trim().split('\n');
    const pings = [];

    for (const line of lines) {
      const parts = line.split(',');
      if (parts[0] >= sinceStr && parts[1]) {
        const ping = parseFloat(parts[1]);
        if (!isNaN(ping)) pings.push(ping);
      }
    }

    if (pings.length === 0) return { avg: 'N/A', med: 'N/A', std: 'N/A', min: 'N/A', max: 'N/A', count: 0 };

    pings.sort((a, b) => a - b);
    const sum = pings.reduce((a, b) => a + b, 0);
    const avg = sum / pings.length;
    const med = pings.length % 2 === 1
      ? pings[Math.floor(pings.length / 2)]
      : (pings[pings.length / 2 - 1] + pings[pings.length / 2]) / 2;
    const variance = pings.reduce((acc, p) => acc + Math.pow(p - avg, 2), 0) / pings.length;
    const std = Math.sqrt(variance);

    return {
      avg: avg.toFixed(1),
      med: med.toFixed(1),
      std: std.toFixed(1),
      min: Math.min(...pings).toFixed(0),
      max: Math.max(...pings).toFixed(0),
      count: pings.length
    };
  } catch (e) {
    return { avg: 'N/A', med: 'N/A', std: 'N/A', min: 'N/A', max: 'N/A', count: 0 };
  }
}

function calcPacketLoss() {
  const pingLog = getPingLog();
  if (!fs.existsSync(pingLog)) return { percent: 0, lost: 0, total: 0 };

  try {
    const lines = fs.readFileSync(pingLog, 'utf8').trim().split('\n').filter(l => l);
    if (lines.length === 0) return { percent: 0, lost: 0, total: 0 };

    const seqs = lines.map(l => parseInt(l.split(',')[2])).filter(s => !isNaN(s));
    if (seqs.length === 0) return { percent: 0, lost: 0, total: 0 };

    const firstSeq = seqs[0];
    const lastSeq = seqs[seqs.length - 1];
    const expected = lastSeq - firstSeq + 1;
    const lost = Math.max(0, expected - seqs.length);

    return {
      percent: ((lost / expected) * 100).toFixed(1),
      lost,
      total: expected
    };
  } catch (e) {
    return { percent: 0, lost: 0, total: 0 };
  }
}

function calcGapStats() {
  const gapLog = getGapLog();
  if (!fs.existsSync(gapLog)) return { count: 0, totalSec: 0, avg: 0, min: 0, max: 0 };

  try {
    const lines = fs.readFileSync(gapLog, 'utf8').trim().split('\n').slice(1); // Skip header
    if (lines.length === 0) return { count: 0, totalSec: 0, avg: 0, min: 0, max: 0 };

    const gaps = lines.map(l => parseInt(l.split(',')[1])).filter(g => !isNaN(g));
    if (gaps.length === 0) return { count: 0, totalSec: 0, avg: 0, min: 0, max: 0 };

    const totalSec = gaps.reduce((a, b) => a + b, 0);

    return {
      count: gaps.length,
      totalSec,
      avg: (totalSec / gaps.length).toFixed(1),
      min: Math.min(...gaps),
      max: Math.max(...gaps)
    };
  } catch (e) {
    return { count: 0, totalSec: 0, avg: 0, min: 0, max: 0 };
  }
}

function calcSpeedtestStats(minutes) {
  const speedtestLog = getSpeedtestLog();
  if (!fs.existsSync(speedtestLog)) return { download: 'N/A', upload: 'N/A', latency: 'N/A', count: 0 };

  const since = new Date(Date.now() - minutes * 60 * 1000);
  const sinceStr = since.toISOString().replace('T', ' ').substring(0, 19);

  try {
    const lines = fs.readFileSync(speedtestLog, 'utf8').trim().split('\n').slice(1); // Skip header
    const results = [];

    for (const line of lines) {
      const parts = line.split(',');
      if (parts[0] >= sinceStr && parts[4] !== 'N/A') {
        results.push({
          latency: parseFloat(parts[3]) || 0,
          download: parseFloat(parts[4]) || 0,
          upload: parseFloat(parts[5]) || 0
        });
      }
    }

    if (results.length === 0) return { download: 'N/A', upload: 'N/A', latency: 'N/A', count: 0 };

    const avgDl = results.reduce((a, r) => a + r.download, 0) / results.length;
    const avgUl = results.reduce((a, r) => a + r.upload, 0) / results.length;
    const avgLat = results.reduce((a, r) => a + r.latency, 0) / results.length;

    return {
      download: avgDl.toFixed(1),
      upload: avgUl.toFixed(1),
      latency: avgLat.toFixed(1),
      count: results.length
    };
  } catch (e) {
    return { download: 'N/A', upload: 'N/A', latency: 'N/A', count: 0 };
  }
}

function getRecentPings(count = 10) {
  const pingLog = getPingLog();
  if (!fs.existsSync(pingLog)) return [];

  try {
    const lines = fs.readFileSync(pingLog, 'utf8').trim().split('\n').slice(-count);
    return lines.map(line => {
      const parts = line.split(',');
      return {
        ts: parts[0],
        time: parseFloat(parts[1]),
        seq: parseInt(parts[2]),
        ttl: parseInt(parts[3])
      };
    }).filter(p => !isNaN(p.time));
  } catch (e) {
    return [];
  }
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
    width: 700,
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
  return calcPingStats(minutes);
});

ipcMain.handle('get-packet-loss', () => {
  return calcPacketLoss();
});

ipcMain.handle('get-gap-stats', () => {
  return calcGapStats();
});

ipcMain.handle('get-speedtest-stats', (event, minutes) => {
  return calcSpeedtestStats(minutes);
});

ipcMain.handle('get-recent-pings', (event, count) => {
  return getRecentPings(count);
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
const SPEEDTEST_INTERVAL = 15 * 60 * 1000; // 15 minutes
let speedtestTimer = null;

function startSpeedtestScheduler() {
  // Run initial speedtest after 10 seconds
  setTimeout(() => {
    runSpeedtest();
  }, 10000);

  // Schedule periodic speedtest
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

// ============================================================================
// App Lifecycle
// ============================================================================
app.whenReady().then(() => {
  createWindow();

  // Auto-start ping monitoring
  startPing();

  // Auto-start speedtest scheduler
  startSpeedtestScheduler();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopPing();
  stopSpeedtestScheduler();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopPing();
  stopSpeedtestScheduler();
});
