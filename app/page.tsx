"use client";

import { useEffect, useState, useCallback } from "react";
import type {
  PingResult,
  PingStats,
  PacketLoss,
  GapStats,
  SpeedtestStats,
  SpeedtestStatusEvent,
  SpeedtestResult,
} from "@/lib/types";

// Stat periods configuration
const PING_PERIODS = [
  { label: "Hari ini", minutes: 1440 },
  { label: "3 jam", minutes: 180 },
  { label: "1 jam", minutes: 60 },
  { label: "30 menit", minutes: 30 },
  { label: "10 menit", minutes: 10 },
];

const SPEEDTEST_PERIODS = [
  { label: "Hari ini", minutes: 1440 },
  { label: "3 jam", minutes: 180 },
  { label: "1 jam", minutes: 60 },
];

export default function Home() {
  // States
  const [isClient, setIsClient] = useState(false);
  const [pingRunning, setPingRunning] = useState(false);
  const [recentPings, setRecentPings] = useState<PingResult[]>([]);
  const [pingStats, setPingStats] = useState<Record<number, PingStats>>({});
  const [packetLoss, setPacketLoss] = useState<PacketLoss>({ percent: "0", lost: 0, total: 0 });
  const [gapStats, setGapStats] = useState<GapStats>({ count: 0, totalSec: 0, avg: "0", min: 0, max: 0 });
  const [speedtestStats, setSpeedtestStats] = useState<Record<number, SpeedtestStats>>({});
  const [speedtestRunning, setSpeedtestRunning] = useState(false);
  const [lastSpeedtest, setLastSpeedtest] = useState<SpeedtestResult | null>(null);
  const [alert, setAlert] = useState<{ type: "timeout" | "loss" | "speedtest"; message: string } | null>(null);

  // Track client-side rendering
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Fetch all statistics
  const fetchStats = useCallback(async () => {
    if (!window.electronAPI) return;

    try {
      // Fetch ping stats for all periods
      const pingStatsData: Record<number, PingStats> = {};
      for (const period of PING_PERIODS) {
        pingStatsData[period.minutes] = await window.electronAPI.getPingStats(period.minutes);
      }
      setPingStats(pingStatsData);

      // Fetch packet loss and gap stats
      setPacketLoss(await window.electronAPI.getPacketLoss());
      setGapStats(await window.electronAPI.getGapStats());

      // Fetch speedtest stats for all periods
      const speedtestStatsData: Record<number, SpeedtestStats> = {};
      for (const period of SPEEDTEST_PERIODS) {
        speedtestStatsData[period.minutes] = await window.electronAPI.getSpeedtestStats(period.minutes);
      }
      setSpeedtestStats(speedtestStatsData);

      // Fetch recent pings
      setRecentPings(await window.electronAPI.getRecentPings(5));

      // Fetch ping status
      const status = await window.electronAPI.pingStatus();
      setPingRunning(status.running);
    } catch (error) {
      console.error("Error fetching stats:", error);
    }
  }, []);

  // Initialize and set up event listeners
  useEffect(() => {
    if (!window.electronAPI) {
      console.warn("Electron API not available - running in browser mode");
      return;
    }

    // Initial fetch
    fetchStats();

    // Set up periodic stats refresh (every 5 seconds)
    const statsInterval = setInterval(fetchStats, 5000);

    // Set up event listeners
    const cleanupPingResult = window.electronAPI.onPingResult((data) => {
      setRecentPings((prev) => [...prev.slice(-4), data]);
    });

    const cleanupPingTimeout = window.electronAPI.onPingTimeout((data) => {
      setAlert({ type: "timeout", message: `Timeout: Gap ${data.gap} detik!` });
      setTimeout(() => setAlert(null), 5000);
    });

    const cleanupPacketLoss = window.electronAPI.onPacketLoss((data) => {
      setAlert({ type: "loss", message: `Packet Loss: ${data.lost} paket hilang!` });
      setTimeout(() => setAlert(null), 5000);
    });

    const cleanupSpeedtest = window.electronAPI.onSpeedtestStatus((data: SpeedtestStatusEvent) => {
      if (data.status === "running") {
        setSpeedtestRunning(true);
      } else {
        setSpeedtestRunning(false);
        if (data.status === "completed" && data.result) {
          setLastSpeedtest(data.result);
          setAlert({ type: "speedtest", message: "Speedtest selesai!" });
          setTimeout(() => setAlert(null), 3000);
          fetchStats();
        } else if (data.status === "failed") {
          setAlert({ type: "speedtest", message: `Speedtest gagal: ${data.error}` });
          setTimeout(() => setAlert(null), 5000);
        }
      }
    });

    return () => {
      clearInterval(statsInterval);
      cleanupPingResult();
      cleanupPingTimeout();
      cleanupPacketLoss();
      cleanupSpeedtest();
    };
  }, [fetchStats]);

  // Handle speedtest button click
  const handleSpeedtest = async () => {
    if (!isClient || !window.electronAPI || speedtestRunning) return;
    await window.electronAPI.speedtestRun();
  };

  // Check if electron API is available
  const hasElectronAPI = isClient && typeof window !== "undefined" && !!window.electronAPI;

  // Get color based on ping value
  const getPingColor = (time: number) => {
    if (time < 50) return "text-green-400";
    if (time < 100) return "text-yellow-400";
    return "text-red-400";
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100 p-4 font-mono">
      {/* Header */}
      <header className="text-center mb-6">
        <h1 className="text-2xl font-bold text-cyan-400 tracking-wider">
          ══════════════════ NETWORK MONITOR ══════════════════
        </h1>
        <div className="flex justify-center gap-4 mt-2 text-sm">
          <span className={pingRunning ? "text-green-400" : "text-gray-500"}>
            ● Ping: {pingRunning ? "Running" : "Stopped"}
          </span>
          <span className={speedtestRunning ? "text-cyan-400" : "text-gray-500"}>
            ● Speedtest: {speedtestRunning ? "Running..." : "Idle"}
          </span>
        </div>
      </header>

      {/* Alert Banner */}
      {alert && (
        <div
          className={`mb-4 p-3 rounded text-center font-bold ${
            alert.type === "timeout" || alert.type === "loss"
              ? "bg-red-900/50 text-red-400 border border-red-500"
              : "bg-green-900/50 text-green-400 border border-green-500"
          }`}
        >
          {">>>"} {alert.message} {"<<<"}
        </div>
      )}

      {/* Ping Statistics Table */}
      <section className="mb-6">
        <h2 className="text-yellow-400 font-bold mb-2">▶ PING GOOGLE (ms)</h2>
        <div className="border border-gray-700 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800">
              <tr>
                <th className="px-3 py-2 text-left">Periode</th>
                <th className="px-3 py-2 text-right">Avg</th>
                <th className="px-3 py-2 text-right">Med</th>
                <th className="px-3 py-2 text-right">Stdev</th>
                <th className="px-3 py-2 text-right">Range</th>
                <th className="px-3 py-2 text-right">Count</th>
              </tr>
            </thead>
            <tbody>
              {PING_PERIODS.map((period) => {
                const stats = pingStats[period.minutes] || { avg: "N/A", med: "N/A", std: "N/A", min: "N/A", max: "N/A", count: 0 };
                return (
                  <tr key={period.minutes} className="border-t border-gray-700 hover:bg-gray-800/50">
                    <td className="px-3 py-2 text-green-400">{period.label}</td>
                    <td className="px-3 py-2 text-right">{stats.avg}</td>
                    <td className="px-3 py-2 text-right">{stats.med}</td>
                    <td className="px-3 py-2 text-right">{stats.std}</td>
                    <td className="px-3 py-2 text-right">{stats.min}-{stats.max}</td>
                    <td className="px-3 py-2 text-right">{stats.count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Status Today */}
      <section className="mb-6">
        <h2 className="text-yellow-400 font-bold mb-2">▶ STATUS HARI INI</h2>
        <div className="border border-gray-700 rounded p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span>Packet Loss:</span>
            {packetLoss.lost > 0 ? (
              <span className="text-red-400 font-bold">
                {packetLoss.percent}% ({packetLoss.lost} hilang dari {packetLoss.total} paket)
              </span>
            ) : (
              <span className="text-green-400 font-bold">
                {packetLoss.percent}% (0 hilang dari {packetLoss.total} paket)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span>Gap/Timeout:</span>
            {gapStats.count > 0 ? (
              <span className="text-red-400">
                <span className="font-bold">{gapStats.count}x</span> | Tot:{gapStats.totalSec}s | Avg:{gapStats.avg}s | Min:{gapStats.min}s | Max:{gapStats.max}s
              </span>
            ) : (
              <span className="text-green-400 font-bold">Tidak ada timeout hari ini</span>
            )}
          </div>
        </div>
      </section>

      {/* Speedtest Statistics */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-yellow-400 font-bold">▶ SPEEDTEST</h2>
          <button
            onClick={handleSpeedtest}
            disabled={speedtestRunning || !hasElectronAPI}
            className={`px-4 py-1 rounded text-sm font-bold transition ${
              speedtestRunning
                ? "bg-gray-700 text-gray-400 cursor-not-allowed"
                : "bg-cyan-600 hover:bg-cyan-500 text-white"
            }`}
          >
            {speedtestRunning ? "Running..." : "Run Speedtest"}
          </button>
        </div>
        <div className="border border-gray-700 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800">
              <tr>
                <th className="px-3 py-2 text-left">Periode</th>
                <th className="px-3 py-2 text-right">Download</th>
                <th className="px-3 py-2 text-right">Upload</th>
                <th className="px-3 py-2 text-right">Latency</th>
                <th className="px-3 py-2 text-right">Count</th>
              </tr>
            </thead>
            <tbody>
              {SPEEDTEST_PERIODS.map((period) => {
                const stats = speedtestStats[period.minutes] || { download: "N/A", upload: "N/A", latency: "N/A", count: 0 };
                return (
                  <tr key={period.minutes} className="border-t border-gray-700 hover:bg-gray-800/50">
                    <td className="px-3 py-2 text-green-400">{period.label}</td>
                    <td className="px-3 py-2 text-right">{stats.download} Mbit/s</td>
                    <td className="px-3 py-2 text-right">{stats.upload} Mbit/s</td>
                    <td className="px-3 py-2 text-right">{stats.latency} ms</td>
                    <td className="px-3 py-2 text-right">{stats.count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Last Speedtest Result */}
        {lastSpeedtest && (
          <div className="mt-2 p-3 bg-gray-800/50 border border-gray-700 rounded text-sm">
            <div className="text-green-400 font-bold mb-1">[SPEEDTEST] Hasil Terakhir:</div>
            <div className="grid grid-cols-2 gap-2 text-gray-300">
              <div>Server: <span className="text-cyan-400">{lastSpeedtest.server}</span></div>
              <div>Latency: <span className="text-yellow-400">{lastSpeedtest.latency} ms</span></div>
              <div>Download: <span className="text-green-400">{lastSpeedtest.download} Mbit/s</span></div>
              <div>Upload: <span className="text-green-400">{lastSpeedtest.upload} Mbit/s</span></div>
            </div>
          </div>
        )}
      </section>

      {/* Realtime Ping */}
      <section className="mb-6">
        <h2 className="text-yellow-400 font-bold mb-2">▶ REALTIME PING</h2>
        <div className="border border-gray-700 rounded p-3 bg-gray-900/50 min-h-[140px]">
          {recentPings.length === 0 ? (
            <div className="text-gray-500 text-center py-4">Waiting for ping data...</div>
          ) : (
            <div className="space-y-1 font-mono text-sm">
              {recentPings.map((ping, idx) => (
                <div key={idx} className="flex gap-4">
                  <span className="text-gray-400">{ping.ts}</span>
                  <span className={getPingColor(ping.time)}>
                    seq={ping.seq.toString().padEnd(5)} ttl={ping.ttl.toString().padEnd(3)} time={ping.time.toFixed(1).padStart(6)} ms
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center text-gray-500 text-sm">
        <span className="text-cyan-400">Ctrl+Q</span> untuk keluar | Speedtest otomatis tiap 15 menit
      </footer>
    </div>
  );
}
