// Ping Types
export interface PingResult {
  ts: string;
  time: number;
  seq: number;
  ttl: number;
}

export interface PingStats {
  avg: string;
  med: string;
  std: string;
  min: string;
  max: string;
  count: number;
}

export interface PacketLoss {
  percent: string;
  lost: number;
  total: number;
}

export interface GapStats {
  count: number;
  totalSec: number;
  avg: string;
  min: number;
  max: number;
}

// Speedtest Types
export interface SpeedtestResult {
  server: string;
  latency: string;
  download: string;
  upload: string;
  timestamp: string;
}

export interface SpeedtestStats {
  download: string;
  upload: string;
  latency: string;
  count: number;
}

export interface SpeedtestStatusEvent {
  status: 'running' | 'completed' | 'failed';
  result?: SpeedtestResult;
  error?: string;
}

// App Info
export interface AppInfo {
  version: string;
  platform: string;
  dataDir: string;
}

// Electron API Interface
export interface ElectronAPI {
  // App info
  getAppInfo: () => Promise<AppInfo>;

  // Ping controls
  pingStart: () => Promise<{ success: boolean }>;
  pingStop: () => Promise<{ success: boolean }>;
  pingStatus: () => Promise<{ running: boolean }>;

  // Speedtest controls
  speedtestRun: () => Promise<{ success: boolean; result?: SpeedtestResult; error?: string }>;
  speedtestStatus: () => Promise<{ running: boolean }>;

  // Statistics
  getPingStats: (minutes: number) => Promise<PingStats>;
  getPacketLoss: () => Promise<PacketLoss>;
  getGapStats: () => Promise<GapStats>;
  getSpeedtestStats: (minutes: number) => Promise<SpeedtestStats>;
  getRecentPings: (count: number) => Promise<PingResult[]>;

  // Event listeners (return cleanup function)
  onPingResult: (callback: (data: PingResult) => void) => () => void;
  onPingTimeout: (callback: (data: { gap: number; seqFrom: number; seqTo: number }) => void) => () => void;
  onPacketLoss: (callback: (data: { lost: number; seqFrom: number; seqTo: number }) => void) => () => void;
  onSpeedtestStatus: (callback: (data: SpeedtestStatusEvent) => void) => () => void;
}

// Declare global window interface
declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
