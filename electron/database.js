const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function initDatabase(dataDir) {
  if (db) return db;

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'network_monitor.db');
  db = new Database(dbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    -- Ping results table (time_ms can be NULL for timeout/gap markers)
    CREATE TABLE IF NOT EXISTS pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT (datetime('now', 'localtime')),
      time_ms REAL,
      seq INTEGER,
      ttl INTEGER,
      is_timeout INTEGER DEFAULT 0
    );

    -- Create index for timestamp queries
    CREATE INDEX IF NOT EXISTS idx_pings_timestamp ON pings(timestamp);

    -- Speedtest results table
    CREATE TABLE IF NOT EXISTS speedtests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT (datetime('now', 'localtime')),
      server TEXT,
      latency_ms REAL,
      download_mbps REAL,
      upload_mbps REAL,
      ping_avg_ms REAL
    );

    CREATE INDEX IF NOT EXISTS idx_speedtests_timestamp ON speedtests(timestamp);

    -- Gap/timeout events table
    CREATE TABLE IF NOT EXISTS gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT (datetime('now', 'localtime')),
      gap_seconds INTEGER NOT NULL,
      seq_from INTEGER,
      seq_to INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_gaps_timestamp ON gaps(timestamp);

    -- Network issues log table
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT (datetime('now', 'localtime')),
      type TEXT NOT NULL,
      message TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_issues_timestamp ON issues(timestamp);
  `);

  // Migration: Add is_timeout column if it doesn't exist
  try {
    db.exec(`ALTER TABLE pings ADD COLUMN is_timeout INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists, ignore error
  }

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// Ping operations
function insertPing(timeMs, seq, ttl, isTimeout = false) {
  const stmt = getDb().prepare('INSERT INTO pings (time_ms, seq, ttl, is_timeout) VALUES (?, ?, ?, ?)');
  return stmt.run(timeMs, seq, ttl, isTimeout ? 1 : 0);
}

// Insert timeout marker (for realtime chart gaps)
function insertTimeout() {
  const stmt = getDb().prepare('INSERT INTO pings (time_ms, seq, ttl, is_timeout) VALUES (NULL, NULL, NULL, 1)');
  return stmt.run();
}

function getPingStats(minutes) {
  const stmt = getDb().prepare(`
    SELECT
      AVG(time_ms) as avg,
      MIN(time_ms) as min,
      MAX(time_ms) as max,
      COUNT(*) as count
    FROM pings
    WHERE timestamp >= datetime('now', 'localtime', '-' || ? || ' minutes')
      AND is_timeout = 0
  `);
  const row = stmt.get(minutes);

  if (!row || row.count === 0) {
    return { avg: 'N/A', med: 'N/A', std: 'N/A', min: 'N/A', max: 'N/A', count: 0 };
  }

  // Calculate median
  const medianStmt = getDb().prepare(`
    SELECT time_ms FROM pings
    WHERE timestamp >= datetime('now', 'localtime', '-' || ? || ' minutes')
      AND is_timeout = 0
    ORDER BY time_ms
    LIMIT 1 OFFSET (
      SELECT COUNT(*) / 2 FROM pings
      WHERE timestamp >= datetime('now', 'localtime', '-' || ? || ' minutes')
        AND is_timeout = 0
    )
  `);
  const medianRow = medianStmt.get(minutes, minutes);
  const median = medianRow ? medianRow.time_ms : row.avg;

  // Calculate standard deviation
  const stdStmt = getDb().prepare(`
    SELECT AVG((time_ms - ?) * (time_ms - ?)) as variance
    FROM pings
    WHERE timestamp >= datetime('now', 'localtime', '-' || ? || ' minutes')
      AND is_timeout = 0
  `);
  const stdRow = stdStmt.get(row.avg, row.avg, minutes);
  const std = stdRow && stdRow.variance ? Math.sqrt(stdRow.variance) : 0;

  return {
    avg: row.avg ? row.avg.toFixed(1) : 'N/A',
    med: median ? median.toFixed(1) : 'N/A',
    std: std.toFixed(1),
    min: row.min ? row.min.toFixed(0) : 'N/A',
    max: row.max ? row.max.toFixed(0) : 'N/A',
    count: row.count
  };
}

function getRecentPings(count) {
  const stmt = getDb().prepare(`
    SELECT
      strftime('%Y-%m-%d %H:%M:%S', timestamp) as ts,
      time_ms as time,
      seq,
      ttl,
      is_timeout
    FROM pings
    ORDER BY id DESC
    LIMIT ?
  `);
  return stmt.all(count).reverse();
}

function getPingHistory(minutes, intervalSec) {
  // For realtime mode (1 second interval), return individual pings
  if (intervalSec <= 1) {
    const stmt = getDb().prepare(`
      SELECT
        strftime('%H:%M:%S', timestamp) as time,
        strftime('%s', timestamp) * 1000 as timestamp,
        COALESCE(time_ms, 0) as avg,
        COALESCE(time_ms, 0) as min,
        COALESCE(time_ms, 0) as max,
        is_timeout as timeout
      FROM pings
      WHERE timestamp >= datetime('now', 'localtime', '-' || ? || ' minutes')
      ORDER BY timestamp DESC
      LIMIT 120
    `);
    const rows = stmt.all(minutes);
    return rows.reverse().map(r => ({
      time: r.time,
      timestamp: r.timestamp,
      avg: r.timeout ? 0 : Math.round(r.avg),
      min: r.timeout ? 0 : Math.round(r.min),
      max: r.timeout ? 0 : Math.round(r.max),
      timeout: r.timeout === 1
    }));
  }

  // For aggregated mode, group by interval
  const stmt = getDb().prepare(`
    SELECT
      strftime('%H:%M:%S', datetime(
        (strftime('%s', timestamp) / ?) * ?, 'unixepoch', 'localtime'
      )) as time,
      (strftime('%s', timestamp) / ?) * ? * 1000 as timestamp,
      AVG(CASE WHEN is_timeout = 0 THEN time_ms ELSE NULL END) as avg,
      MIN(CASE WHEN is_timeout = 0 THEN time_ms ELSE NULL END) as min,
      MAX(CASE WHEN is_timeout = 0 THEN time_ms ELSE NULL END) as max,
      SUM(is_timeout) as timeouts,
      COUNT(*) as count
    FROM pings
    WHERE timestamp >= datetime('now', 'localtime', '-' || ? || ' minutes')
    GROUP BY strftime('%s', timestamp) / ?
    ORDER BY timestamp
    LIMIT 120
  `);
  const rows = stmt.all(intervalSec, intervalSec, intervalSec, intervalSec, minutes, intervalSec);
  return rows.map(r => ({
    time: r.time,
    timestamp: r.timestamp,
    avg: r.avg ? Math.round(r.avg) : 0,
    min: r.min ? Math.round(r.min) : 0,
    max: r.max ? Math.round(r.max) : 0,
    timeouts: r.timeouts || 0
  }));
}

function getPacketLoss() {
  const stmt = getDb().prepare(`
    SELECT MIN(seq) as first_seq, MAX(seq) as last_seq, COUNT(*) as actual_count
    FROM pings
    WHERE timestamp >= datetime('now', 'localtime', 'start of day')
      AND is_timeout = 0
  `);
  const row = stmt.get();

  if (!row || row.actual_count === 0) {
    return { percent: '0', lost: 0, total: 0 };
  }

  const expected = row.last_seq - row.first_seq + 1;
  const lost = Math.max(0, expected - row.actual_count);

  return {
    percent: ((lost / expected) * 100).toFixed(1),
    lost,
    total: expected
  };
}

// Gap operations
function insertGap(gapSeconds, seqFrom, seqTo) {
  const stmt = getDb().prepare('INSERT INTO gaps (gap_seconds, seq_from, seq_to) VALUES (?, ?, ?)');
  return stmt.run(gapSeconds, seqFrom, seqTo);
}

function getGapStats() {
  const stmt = getDb().prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(gap_seconds), 0) as total_sec,
      COALESCE(AVG(gap_seconds), 0) as avg,
      COALESCE(MIN(gap_seconds), 0) as min,
      COALESCE(MAX(gap_seconds), 0) as max
    FROM gaps
    WHERE timestamp >= datetime('now', 'localtime', 'start of day')
  `);
  const row = stmt.get();

  return {
    count: row.count || 0,
    totalSec: row.total_sec || 0,
    avg: row.avg ? row.avg.toFixed(1) : '0',
    min: row.min || 0,
    max: row.max || 0
  };
}

function getGapHistory(minutes, groupBy) {
  const interval = groupBy === 'hour' ? 3600 : 60;
  const timeFormat = groupBy === 'hour' ? '%H:00' : '%H:%M';

  const stmt = getDb().prepare(`
    SELECT
      strftime('${timeFormat}', datetime(
        (strftime('%s', timestamp) / ?) * ?, 'unixepoch', 'localtime'
      )) as time,
      (strftime('%s', timestamp) / ?) * ? * 1000 as timestamp,
      COUNT(*) as count,
      COALESCE(SUM(gap_seconds), 0) as totalSec
    FROM gaps
    WHERE timestamp >= datetime('now', 'localtime', '-' || ? || ' minutes')
    GROUP BY strftime('%s', timestamp) / ?
    ORDER BY timestamp
    LIMIT 60
  `);

  return stmt.all(interval, interval, interval, interval, minutes, interval);
}

// Speedtest operations
function insertSpeedtest(server, latency, download, upload, pingAvg) {
  const stmt = getDb().prepare(`
    INSERT INTO speedtests (server, latency_ms, download_mbps, upload_mbps, ping_avg_ms)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(server, latency, download, upload, pingAvg);
}

function getSpeedtestStats(minutes) {
  const stmt = getDb().prepare(`
    SELECT
      AVG(download_mbps) as download,
      AVG(upload_mbps) as upload,
      AVG(latency_ms) as latency,
      COUNT(*) as count
    FROM speedtests
    WHERE timestamp >= datetime('now', 'localtime', '-' || ? || ' minutes')
      AND download_mbps IS NOT NULL
  `);
  const row = stmt.get(minutes);

  if (!row || row.count === 0) {
    return { download: 'N/A', upload: 'N/A', latency: 'N/A', count: 0 };
  }

  return {
    download: row.download ? row.download.toFixed(1) : 'N/A',
    upload: row.upload ? row.upload.toFixed(1) : 'N/A',
    latency: row.latency ? row.latency.toFixed(1) : 'N/A',
    count: row.count
  };
}

function getSpeedtestHistory(minutes) {
  const stmt = getDb().prepare(`
    SELECT
      strftime('%H:%M', timestamp) as time,
      strftime('%s', timestamp) * 1000 as timestamp,
      download_mbps as download,
      upload_mbps as upload,
      latency_ms as latency
    FROM speedtests
    WHERE timestamp >= datetime('now', 'localtime', '-' || ? || ' minutes')
      AND download_mbps IS NOT NULL
    ORDER BY timestamp
    LIMIT 20
  `);
  return stmt.all(minutes);
}

function getLastSpeedtest() {
  const stmt = getDb().prepare(`
    SELECT
      server,
      latency_ms as latency,
      download_mbps as download,
      upload_mbps as upload,
      strftime('%Y-%m-%d %H:%M:%S', timestamp) as timestamp
    FROM speedtests
    WHERE download_mbps IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `);
  return stmt.get();
}

// Issues log
function logIssue(type, message) {
  const stmt = getDb().prepare('INSERT INTO issues (type, message) VALUES (?, ?)');
  return stmt.run(type, message);
}

// Cleanup old data (keep last 7 days)
function cleanupOldData() {
  getDb().exec(`
    DELETE FROM pings WHERE timestamp < datetime('now', 'localtime', '-7 days');
    DELETE FROM gaps WHERE timestamp < datetime('now', 'localtime', '-7 days');
    DELETE FROM speedtests WHERE timestamp < datetime('now', 'localtime', '-30 days');
    DELETE FROM issues WHERE timestamp < datetime('now', 'localtime', '-30 days');
  `);
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDatabase,
  getDb,
  insertPing,
  insertTimeout,
  getPingStats,
  getRecentPings,
  getPingHistory,
  getPacketLoss,
  insertGap,
  getGapStats,
  getGapHistory,
  insertSpeedtest,
  getSpeedtestStats,
  getSpeedtestHistory,
  getLastSpeedtest,
  logIssue,
  cleanupOldData,
  closeDatabase
};
