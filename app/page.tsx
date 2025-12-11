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
  const [pingRunning, setPingRunning] = useState(false);
  const [recentPings, setRecentPings] = useState<PingResult[]>([]);
  const [pingStats, setPingStats] = useState<Record<number, PingStats>>({});
  const [packetLoss, setPacketLoss] = useState<PacketLoss>({ percent: "0", lost: 0, total: 0 });
  const [gapStats, setGapStats] = useState<GapStats>({ count: 0, totalSec: 0, avg: "0", min: 0, max: 0 });
  const [speedtestStats, setSpeedtestStats] = useState<Record<number, SpeedtestStats>>({});
  const [speedtestRunning, setSpeedtestRunning] = useState(false);
  const [lastSpeedtest, setLastSpeedtest] = useState<SpeedtestResult | null>(null);
  const [alert, setAlert] = useState<{ type: "timeout" | "loss" | "speedtest"; message: string } | null>(null);

  // Fetch all statistics
  const fetchStats = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI) return;

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
    if (typeof window === "undefined" || !window.electronAPI) {
      console.warn("Electron API not available - running in browser mode");
      return;
    }

    // Initial fetch scheduled to avoid synchronous state updates warning
    const initialTrigger = setTimeout(() => {
      fetchStats();
    }, 0);

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
      clearTimeout(initialTrigger);
      clearInterval(statsInterval);
      cleanupPingResult();
      cleanupPingTimeout();
      cleanupPacketLoss();
      cleanupSpeedtest();
    };
  }, [fetchStats]);

  // Handle speedtest button click
  const handleSpeedtest = async () => {
    if (typeof window === "undefined" || !window.electronAPI || speedtestRunning) return;
    await window.electronAPI.speedtestRun();
  };

  // Check if electron API is available
  const hasElectronAPI = typeof window !== "undefined" && !!window.electronAPI;

  // Get color based on ping value
  const getPingColor = (time: number) => {
    if (time < 50) return "text-green-400";
    if (time < 100) return "text-yellow-400";
    return "text-red-400";
  };

  const latestPing = recentPings[recentPings.length - 1];
  const numericPacketLoss = Number.isFinite(Number(packetLoss.percent)) ? Number(packetLoss.percent) : 0;
  const hasGapsToday = gapStats.count > 0;
  const healthMeta = (() => {
    if ((packetLoss.lost > 0 && numericPacketLoss >= 5) || (hasGapsToday && gapStats.max >= 5)) {
      return {
        badge: "KRITIS",
        label: "Tidak Stabil",
        color: "text-rose-300",
        description: "Packet loss tinggi atau gap panjang terdeteksi",
        score: 25,
      };
    }
    if (packetLoss.lost > 0 || hasGapsToday) {
      return {
        badge: "WARNING",
        label: "Perlu Perhatian",
        color: "text-amber-200",
        description: "Ada gap/packet loss ringan hari ini",
        score: 55,
      };
    }
    return {
      badge: "OPTIMAL",
      label: "Stabil",
      color: "text-emerald-300",
      description: "Semua metrik masih dalam batas aman",
      score: 90,
    };
  })();

  const gapSummary = hasGapsToday
    ? `${gapStats.count} kejadian • Total ${gapStats.totalSec}s • Rata ${gapStats.avg}s`
    : "Tidak ada timeout harian";

  return (
    <div className="relative h-dvh min-h-[700px] max-h-[800px] overflow-hidden bg-[#01030a] text-slate-100">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_0%,rgba(59,130,246,0.25),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-[#04122c] via-[#040916] to-[#01030a]" />

      <main className="relative z-10 mx-auto flex h-full max-w-[700px] flex-col gap-4 px-4 py-5">
        {alert && (
          <div
            className={`rounded-2xl border px-3 py-2 text-xs font-semibold ${
              alert.type === "timeout" || alert.type === "loss"
                ? "border-rose-400/40 bg-gradient-to-r from-rose-600/20 to-transparent text-rose-100"
                : "border-emerald-400/40 bg-gradient-to-r from-emerald-600/20 to-transparent text-emerald-100"
            }`}
          >
            {alert.message}
          </div>
        )}

        {!hasElectronAPI && (
          <div className="rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-500/20 to-transparent px-3 py-2 text-[0.7rem] text-amber-100">
            Mode browser: daemon ping & speedtest tidak aktif.
          </div>
        )}

        <div className="grid h-full gap-4 md:grid-cols-[1.05fr_0.85fr]">
          {/* Left Stack */}
          <section className="flex h-full flex-col gap-4">
            <header className="rounded-[28px] border border-white/10 bg-gradient-to-br from-[#072740]/80 via-[#021021]/90 to-[#01050c]/95 p-4 shadow-[0_15px_45px_rgba(1,10,24,0.55)]">
              <div className="flex flex-col gap-4">
                <div>
                  <p className="text-[0.5rem] uppercase tracking-[0.45em] text-cyan-200">Network telemetry</p>
                  <h1 className="mt-2 text-2xl font-semibold text-white">Network Command Center</h1>
                  <p className="mt-2 text-[0.75rem] text-slate-300">
                    Layout ini dikompres untuk resolusi 700×800 px sehingga semua data penting tetap terlihat tanpa scroll.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className={`rounded-2xl border border-emerald-400/30 bg-gradient-to-br ${pingRunning ? "from-emerald-500/25" : "from-white/5"} to-transparent px-3 py-3 text-center`}>
                    <p className="text-[0.5rem] uppercase tracking-[0.45em] text-emerald-100/70">Ping</p>
                    <p className={`mt-1 text-xl font-semibold ${pingRunning ? "text-emerald-200" : "text-slate-200"}`}>
                      {pingRunning ? "Aktif" : "Nonaktif"}
                    </p>
                    <p className="text-[0.7rem] text-slate-400">
                      {latestPing ? `${latestPing.time.toFixed(1)} ms • seq ${latestPing.seq}` : "Menunggu data"}
                    </p>
                  </div>
                  <div className={`rounded-2xl border border-cyan-400/30 bg-gradient-to-br ${speedtestRunning ? "from-cyan-500/25" : "from-white/5"} to-transparent px-3 py-3 text-center`}>
                    <p className="text-[0.5rem] uppercase tracking-[0.45em] text-cyan-100/70">Speedtest</p>
                    <p className={`mt-1 text-xl font-semibold ${speedtestRunning ? "text-cyan-200" : "text-slate-200"}`}>
                      {speedtestRunning ? "Sedang jalan" : "Siap"}
                    </p>
                    <p className="text-[0.7rem] text-slate-400">
                      {lastSpeedtest ? `Terakhir ${lastSpeedtest.download}↓/${lastSpeedtest.upload}↑` : "Belum ada hasil"}
                    </p>
                  </div>
                </div>
              </div>
            </header>

            <div className="flex flex-1 flex-col rounded-[28px] border border-white/5 bg-gradient-to-br from-[#04142e]/80 via-[#020915]/95 to-[#010308]/95 p-4">
              <div className="flex items-center justify-between text-[0.65rem]">
                <p className="uppercase tracking-[0.35em] text-cyan-200">Ping summary</p>
                <span className="text-slate-500">±5 detik</span>
              </div>
              <div className="mt-3 divide-y divide-white/5 text-xs text-slate-300">
                {PING_PERIODS.map((period) => {
                  const stats =
                    pingStats[period.minutes] || ({ avg: "N/A", med: "N/A", std: "N/A", min: "N/A", max: "N/A", count: 0 } as PingStats);
                  return (
                    <div key={period.minutes} className="flex items-center justify-between py-2">
                      <div>
                        <p className="text-cyan-200">{period.label}</p>
                        <p className="text-[0.7rem] text-slate-500">{stats.count} sampel</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-white">Avg {stats.avg}</p>
                        <p className="text-[0.7rem] text-slate-400">Md {stats.med} • Range {stats.min}-{stats.max}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 rounded-2xl border border-white/5 bg-black/30 p-3 font-mono text-[0.7rem]">
                <p className="mb-2 text-[0.55rem] uppercase tracking-[0.4em] text-slate-400">Live ping</p>
                {recentPings.length === 0 ? (
                  <div className="text-center text-slate-500">Menunggu paket…</div>
                ) : (
                  <div className="space-y-1">
                    {recentPings.map((ping, idx) => (
                      <div key={`${ping.seq}-${idx}`} className="flex justify-between">
                        <span className="text-slate-500">{ping.ts}</span>
                        <span className={`${getPingColor(ping.time)} font-semibold`}>
                          {ping.time.toFixed(1)} ms
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Right Stack */}
          <section className="flex h-full flex-col gap-4">
            <div className="rounded-[28px] border border-white/10 bg-gradient-to-br from-white/10 via-transparent to-transparent p-4 text-sm text-slate-300">
              <div className="flex items-center justify-between text-[0.55rem] uppercase tracking-[0.35em] text-slate-400">
                <span>Kesehatan</span>
                <span className="rounded-full border border-white/10 px-2 py-0.5 text-white/80">{healthMeta.badge}</span>
              </div>
              <p className={`mt-2 text-2xl font-semibold ${healthMeta.color}`}>{healthMeta.label}</p>
              <p className="text-[0.75rem] text-slate-400">{healthMeta.description}</p>
              <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/5">
                <span
                  className="block h-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-500"
                  style={{ width: `${healthMeta.score}%` }}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                  <p className="text-[0.6rem] uppercase tracking-[0.35em] text-slate-400">Packet Loss</p>
                  <p className={`text-lg font-semibold ${packetLoss.lost > 0 ? "text-rose-200" : "text-emerald-300"}`}>
                    {packetLoss.percent}%
                  </p>
                  <p className="text-[0.65rem] text-slate-400">{packetLoss.lost}/{packetLoss.total} paket</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                  <p className="text-[0.6rem] uppercase tracking-[0.35em] text-slate-400">Gap</p>
                  <p className={`text-lg font-semibold ${hasGapsToday ? "text-amber-200" : "text-emerald-300"}`}>
                    {hasGapsToday ? `${gapStats.count}x` : "0x"}
                  </p>
                  <p className="text-[0.65rem] text-slate-400">{gapSummary}</p>
                </div>
              </div>
            </div>

            <div className="rounded-[28px] border border-white/10 bg-gradient-to-br from-[#062032]/80 via-[#020a16]/90 to-[#01030a]/95 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[0.55rem] uppercase tracking-[0.35em] text-cyan-200">Speedtest</p>
                  <h2 className="text-xl font-semibold text-white">Bandwidth</h2>
                </div>
                <button
                  onClick={handleSpeedtest}
                  disabled={speedtestRunning || !hasElectronAPI}
                  className={`rounded-full px-4 py-1 text-[0.7rem] font-semibold transition ${
                    speedtestRunning || !hasElectronAPI
                      ? "cursor-not-allowed border border-white/10 text-slate-400"
                      : "bg-cyan-500 text-slate-900 hover:bg-cyan-400"
                  }`}
                >
                  {speedtestRunning ? "Running" : "Mulai"}
                </button>
              </div>
              <div className="mt-3 divide-y divide-white/5 text-xs text-slate-300">
                {SPEEDTEST_PERIODS.map((period) => {
                  const stats =
                    speedtestStats[period.minutes] || ({ download: "N/A", upload: "N/A", latency: "N/A", count: 0 } as SpeedtestStats);
                  return (
                    <div key={period.minutes} className="py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-cyan-200">{period.label}</span>
                        <span className="text-slate-500">{stats.count} tes</span>
                      </div>
                      <p className="text-sm text-emerald-200">↓ {stats.download} Mbps</p>
                      <p className="text-sm text-blue-200">↑ {stats.upload} Mbps</p>
                      <p className="text-[0.7rem] text-slate-400">Latency {stats.latency} ms</p>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-[0.75rem] text-slate-300">
                <p className="text-[0.55rem] uppercase tracking-[0.3em] text-slate-500">Hasil terakhir</p>
                {lastSpeedtest ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-lg font-semibold text-white">{lastSpeedtest.server}</p>
                    <p className="text-emerald-200">↓ {lastSpeedtest.download} Mbps</p>
                    <p className="text-blue-200">↑ {lastSpeedtest.upload} Mbps</p>
                    <p className="text-[0.7rem] text-slate-400">Latency {lastSpeedtest.latency} ms • {lastSpeedtest.timestamp}</p>
                  </div>
                ) : (
                  <p className="text-slate-500">Belum ada speedtest.</p>
                )}
              </div>
            </div>

            <div className="rounded-[28px] border border-white/10 bg-gradient-to-br from-white/10 via-transparent to-transparent px-4 py-3 text-[0.75rem] text-slate-300">
              <p className="text-[0.55rem] uppercase tracking-[0.35em] text-slate-400">Aktivitas</p>
              <ul className="mt-2 space-y-1 text-white">
                <li>Packet Loss {packetLoss.percent}% ({packetLoss.lost}/{packetLoss.total})</li>
                <li>Gap Watch: {hasGapsToday ? gapSummary : "Stabil sepanjang hari"}</li>
                <li>Speedtest otomatis tiap 15 menit</li>
              </ul>
              <p className="mt-2 text-[0.65rem] text-slate-500">Ctrl+Q untuk keluar.</p>
            </div>
          </section>
        </div>

        <footer className="text-center text-[0.55rem] uppercase tracking-[0.35em] text-slate-500">
          Dibuat untuk jaringan yang selalu aktif · {new Date().getFullYear()}
        </footer>
      </main>
    </div>
  );
}
