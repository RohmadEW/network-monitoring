"use client";

import { useEffect, useState, useCallback } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  LabelList,
  AreaChart,
  Area,
  ReferenceLine,
} from "recharts";
import type {
  PingStats,
  PacketLoss,
  GapStats,
  SpeedtestStats,
  SpeedtestStatusEvent,
  SpeedtestResult,
  PingHistoryPoint,
  SpeedtestHistoryPoint,
  GapHistoryPoint,
} from "@/lib/types";

const PING_CHART_PERIODS = [
  { label: "1h", minutes: 60, interval: 60 },
  { label: "30m", minutes: 30, interval: 30 },
  { label: "10m", minutes: 10, interval: 10 },
  { label: "5m", minutes: 5, interval: 5 },
  { label: "2m", minutes: 2, interval: 1 },  // Realtime per second
  { label: "1m", minutes: 1, interval: 1 },  // Realtime per second
];

const GAP_CHART_PERIODS = [
  { label: "24h", minutes: 1440, groupBy: "hour" },
  { label: "12h", minutes: 720, groupBy: "hour" },
  { label: "6h", minutes: 360, groupBy: "minute" },
  { label: "3h", minutes: 180, groupBy: "minute" },
  { label: "1h", minutes: 60, groupBy: "minute" },
];

// Custom tooltip for dark theme
const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 shadow-xl">
        <p className="text-slate-400 text-xs mb-1">{label}</p>
        {payload.map((entry, index) => (
          <p key={index} className="text-sm" style={{ color: entry.color }}>
            {entry.name}: <span className="font-semibold">{typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}</span>
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export default function Home() {
  const [pingRunning, setPingRunning] = useState(false);
  const [pingStats, setPingStats] = useState<PingStats>({ avg: "--", med: "--", std: "--", min: "--", max: "--", count: 0 });
  const [packetLoss, setPacketLoss] = useState<PacketLoss>({ percent: "0", lost: 0, total: 0 });
  const [gapStats, setGapStats] = useState<GapStats>({ count: 0, totalSec: 0, avg: "0", min: 0, max: 0 });
  const [speedtestStats, setSpeedtestStats] = useState<SpeedtestStats>({ download: "--", upload: "--", latency: "--", count: 0 });
  const [speedtestRunning, setSpeedtestRunning] = useState(false);
  const [lastSpeedtest, setLastSpeedtest] = useState<SpeedtestResult | null>(null);
  const [alert, setAlert] = useState<{ type: "timeout" | "loss" | "speedtest"; message: string } | null>(null);
  const [hasElectronAPI, setHasElectronAPI] = useState(false);
  const [uptime, setUptime] = useState(0);

  // Chart states
  const [pingHistory, setPingHistory] = useState<PingHistoryPoint[]>([]);
  const [speedtestHistory, setSpeedtestHistory] = useState<SpeedtestHistoryPoint[]>([]);
  const [gapHistory, setGapHistory] = useState<GapHistoryPoint[]>([]);

  // Period selectors
  const [pingPeriod, setPingPeriod] = useState(PING_CHART_PERIODS[5]); // 1m realtime default
  const [gapPeriod, setGapPeriod] = useState(GAP_CHART_PERIODS[3]); // 3h default

  const fetchStats = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI) return;
    try {
      setPingStats(await window.electronAPI.getPingStats(1440));
      setPacketLoss(await window.electronAPI.getPacketLoss());
      setGapStats(await window.electronAPI.getGapStats());
      setSpeedtestStats(await window.electronAPI.getSpeedtestStats(1440));
      const status = await window.electronAPI.pingStatus();
      setPingRunning(status.running);
    } catch (error) {
      console.error("Error fetching stats:", error);
    }
  }, []);

  const fetchChartData = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI) return;
    try {
      const [pingHist, speedHist, gapHist] = await Promise.all([
        window.electronAPI.getPingHistory(pingPeriod.minutes, pingPeriod.interval),
        window.electronAPI.getSpeedtestHistory(1440),
        window.electronAPI.getGapHistory(gapPeriod.minutes, gapPeriod.groupBy),
      ]);
      setPingHistory(pingHist);
      setSpeedtestHistory(speedHist);
      setGapHistory(gapHist);
    } catch (error) {
      console.error("Error fetching chart data:", error);
    }
  }, [pingPeriod, gapPeriod]);

  useEffect(() => {
    setHasElectronAPI(typeof window !== "undefined" && !!window.electronAPI);
    const startTime = Date.now();
    const uptimeInterval = setInterval(() => {
      setUptime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(uptimeInterval);
  }, []);

  // Determine chart refresh rate based on period (2 seconds for realtime to avoid too many requests)
  const isRealtimeMode = pingPeriod.interval <= 1;
  const chartRefreshRate = isRealtimeMode ? 2000 : 10000;

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI) return;
    const initialTrigger = setTimeout(() => {
      fetchStats();
      fetchChartData();
    }, 0);
    const statsInterval = setInterval(fetchStats, 5000);
    const chartInterval = setInterval(fetchChartData, chartRefreshRate);

    const cleanupPingTimeout = window.electronAPI.onPingTimeout((data) => {
      setAlert({ type: "timeout", message: `Timeout: ${data.gap}s gap detected` });
      setTimeout(() => setAlert(null), 5000);
    });
    const cleanupPacketLoss = window.electronAPI.onPacketLoss((data) => {
      setAlert({ type: "loss", message: `Packet loss: ${data.lost} packets dropped` });
      setTimeout(() => setAlert(null), 5000);
    });
    const cleanupSpeedtest = window.electronAPI.onSpeedtestStatus((data: SpeedtestStatusEvent) => {
      if (data.status === "running") {
        setSpeedtestRunning(true);
      } else {
        setSpeedtestRunning(false);
        if (data.status === "completed" && data.result) {
          setLastSpeedtest(data.result);
          setAlert({ type: "speedtest", message: "Speedtest completed!" });
          setTimeout(() => setAlert(null), 3000);
          fetchStats();
          fetchChartData();
        } else if (data.status === "failed") {
          setAlert({ type: "speedtest", message: `Speedtest failed: ${data.error}` });
          setTimeout(() => setAlert(null), 5000);
        }
      }
    });

    return () => {
      clearTimeout(initialTrigger);
      clearInterval(statsInterval);
      clearInterval(chartInterval);
      cleanupPingTimeout();
      cleanupPacketLoss();
      cleanupSpeedtest();
    };
  }, [fetchStats, fetchChartData, chartRefreshRate]);

  useEffect(() => {
    fetchChartData();
  }, [pingPeriod, gapPeriod, fetchChartData]);

  const handleSpeedtest = async () => {
    if (typeof window === "undefined" || !window.electronAPI || speedtestRunning) return;
    await window.electronAPI.speedtestRun();
  };

  const numericPacketLoss = Number.isFinite(Number(packetLoss.percent)) ? Number(packetLoss.percent) : 0;
  const hasGapsToday = gapStats.count > 0;

  const healthStatus = (() => {
    if ((packetLoss.lost > 0 && numericPacketLoss >= 5) || (hasGapsToday && gapStats.max >= 5)) {
      return { label: "CRITICAL", color: "text-rose-400", bg: "bg-rose-500/20", border: "border-rose-500/40", score: 25 };
    }
    if (packetLoss.lost > 0 || hasGapsToday) {
      return { label: "WARNING", color: "text-amber-400", bg: "bg-amber-500/20", border: "border-amber-500/40", score: 60 };
    }
    return { label: "HEALTHY", color: "text-emerald-400", bg: "bg-emerald-500/20", border: "border-emerald-500/40", score: 95 };
  })();

  const latestPing = pingHistory.length > 0 ? pingHistory[pingHistory.length - 1] : null;

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-dvh w-dvw overflow-hidden bg-[#0a0f1a] text-white font-mono">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1628] via-[#0a0f1a] to-[#050a12]" />

      {/* Toast Alert */}
      {alert && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl text-sm font-semibold flex items-center gap-2 shadow-2xl ${
          alert.type === "timeout" || alert.type === "loss"
            ? "bg-rose-500 text-white"
            : "bg-emerald-500 text-white"
        }`}>
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          {alert.message}
        </div>
      )}

      <main className="relative h-full flex flex-col p-4 gap-3 overflow-hidden">

        {/* Status Cards - 4 columns with detailed stats */}
        <div className="grid grid-cols-4 gap-3 shrink-0">
          {/* Ping Stats Card */}
          <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 border border-cyan-500/20 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-widest text-cyan-400">PING</span>
              <span className={`w-2 h-2 rounded-full ${pingRunning ? "bg-cyan-400 animate-pulse" : "bg-slate-500"}`} />
            </div>
            <div className="flex items-baseline gap-1 mb-3">
              <span className="text-3xl font-black text-white">{pingStats.avg}</span>
              <span className="text-sm text-slate-400">ms avg</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <div>
                <span className="text-slate-500">min</span>
                <span className="text-emerald-400 font-semibold ml-1">{pingStats.min}</span>
              </div>
              <div>
                <span className="text-slate-500">max</span>
                <span className="text-rose-400 font-semibold ml-1">{pingStats.max}</span>
              </div>
              <div>
                <span className="text-slate-500">med</span>
                <span className="text-cyan-400 font-semibold ml-1">{pingStats.med}</span>
              </div>
              <div>
                <span className="text-slate-500">std</span>
                <span className="text-amber-400 font-semibold ml-1">±{pingStats.std}</span>
              </div>
            </div>
            <div className="text-[10px] text-slate-600 mt-2">{pingStats.count.toLocaleString()} samples</div>
          </div>

          {/* Gap/Timeout Stats Card */}
          <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 border border-amber-500/20 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-widest text-amber-400">GAPS</span>
              <span className={`w-2 h-2 rounded-full ${hasGapsToday ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`} />
            </div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-baseline gap-1">
                <span className={`text-3xl font-black ${hasGapsToday ? "text-amber-400" : "text-emerald-400"}`}>{gapStats.count}</span>
                <span className="text-sm text-slate-400">timeouts</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-sm text-slate-400">total</span>
                <span className={`text-3xl font-black ${hasGapsToday ? "text-amber-400" : "text-emerald-400"}`}>{gapStats.totalSec}</span>
                <span className="text-sm text-slate-400">s</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <div>
                <span className="text-slate-500">min</span>
                <span className="text-emerald-400 font-semibold ml-1">{gapStats.min}s</span>
              </div>
              <div>
                <span className="text-slate-500">avg</span>
                <span className="text-amber-400 font-semibold ml-1">{gapStats.avg}s</span>
              </div>
              <div>
                <span className="text-slate-500">max</span>
                <span className="text-rose-400 font-semibold ml-1">{gapStats.max}s</span>
              </div>
            </div>
            <div className="text-[10px] text-slate-600 mt-2">today (&gt;2s threshold)</div>
          </div>

          {/* Packet Loss Stats Card */}
          <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 border border-rose-500/20 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-widest text-rose-400">LOSS</span>
              <span className={`w-2 h-2 rounded-full ${packetLoss.lost > 0 ? "bg-rose-400 animate-pulse" : "bg-emerald-400"}`} />
            </div>
            <div className="flex items-baseline gap-1 mb-3">
              <span className={`text-3xl font-black ${packetLoss.lost > 0 ? "text-rose-400" : "text-emerald-400"}`}>{packetLoss.percent}</span>
              <span className="text-xl text-slate-400">%</span>
            </div>
            <div className="flex items-center justify-between gap-4 text-xs">
              <div>
                <span className="text-slate-500">lost</span>
                <span className="text-rose-400 font-semibold ml-1">{packetLoss.lost}</span>
              </div>
              <div>
                <span className="text-slate-500">total</span>
                <span className="text-white font-semibold ml-1">{packetLoss.total}</span>
              </div>
              <div>
                <span className="text-slate-500">recv</span>
                <span className="text-emerald-400 font-semibold ml-1">{packetLoss.total - packetLoss.lost}</span>
              </div>
            </div>
            <div className="text-[10px] text-slate-600 mt-2">today&apos;s packets</div>
          </div>

          {/* Speedtest Stats Card */}
          <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 border border-emerald-500/20 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-widest text-emerald-400">SPEED</span>
              <span className={`w-2 h-2 rounded-full ${speedtestRunning ? "bg-cyan-400 animate-pulse" : "bg-emerald-400"}`} />
            </div>
            <div className="flex items-center gap-3 mb-3">
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-black text-emerald-400">{speedtestStats.download}</span>
                <span className="text-[10px] text-slate-500">↓</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-black text-blue-400">{speedtestStats.upload}</span>
                <span className="text-[10px] text-slate-500">↑</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 text-xs">
              <div>
                <span className="text-slate-500">down</span>
                <span className="text-emerald-400 font-semibold ml-1">{speedtestStats.download} Mbps</span>
              </div>
              <div>
                <span className="text-slate-500">ping</span>
                <span className="text-amber-400 font-semibold ml-1">{speedtestStats.latency} ms</span>
              </div>
            </div>
            <div className="text-[10px] text-slate-600 mt-2">{speedtestStats.count} tests avg</div>
          </div>
        </div>

        {/* Charts Grid - 2 columns top, full width bottom */}
        <div className="flex flex-col gap-4 flex-1 min-h-0">
          {/* Top Row: Network Gap + Speedtest */}
          <div className="grid grid-cols-2 gap-4 h-[45%]">
            {/* Gap Chart */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-4 flex flex-col">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-sm font-semibold text-slate-300">Network Gaps</span>
                <div className="flex gap-1">
                  {GAP_CHART_PERIODS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => setGapPeriod(p)}
                      className={`px-2 py-1 text-[10px] rounded-lg transition-all ${
                        gapPeriod.label === p.label
                          ? "bg-amber-500/30 text-amber-400 border border-amber-500/50"
                          : "text-slate-500 hover:text-slate-300 hover:bg-slate-700/50"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={gapHistory} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gapGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#fbbf24" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#fbbf24" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" tick={{ fill: "#94a3b8", fontSize: 9 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: "#94a3b8", fontSize: 9 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                    <Area type="stepAfter" dataKey="count" stroke="#fbbf24" strokeWidth={2} fill="url(#gapGradient)" name="Gap Count" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="flex justify-between mt-2 text-[10px] text-slate-400 shrink-0">
                <span>Today: <span className="text-amber-400 font-semibold">{gapStats.count}</span></span>
                <span>Total: <span className="text-rose-400 font-semibold">{gapStats.totalSec}s</span></span>
                <span>Max: <span className="text-rose-400 font-semibold">{gapStats.max}s</span></span>
              </div>
            </div>

            {/* Speedtest Chart */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-4 flex flex-col">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-sm font-semibold text-slate-300">Speedtest History</span>
                <button
                  onClick={handleSpeedtest}
                  disabled={speedtestRunning || !hasElectronAPI}
                  className={`px-3 py-1 rounded-lg text-[10px] font-semibold transition-all ${
                    speedtestRunning
                      ? "bg-cyan-500/20 border border-cyan-500/50 text-cyan-400"
                      : !hasElectronAPI
                      ? "bg-slate-700/50 text-slate-500 cursor-not-allowed"
                      : "bg-cyan-500 text-slate-900 hover:bg-cyan-400"
                  }`}
                >
                  {speedtestRunning ? (
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Running
                    </span>
                  ) : (
                    "Run Test"
                  )}
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={speedtestHistory} margin={{ top: 15, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" tick={{ fill: "#94a3b8", fontSize: 9 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: "#94a3b8", fontSize: 9 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Bar dataKey="download" fill="#4ade80" name="Download" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="upload" fill="#60a5fa" name="Upload" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="flex justify-between mt-2 text-[10px] text-slate-400 shrink-0">
                <span>DL: <span className="text-emerald-400 font-semibold">{speedtestStats.download} Mbps</span></span>
                <span>UL: <span className="text-blue-400 font-semibold">{speedtestStats.upload} Mbps</span></span>
                <span>Lat: <span className="text-amber-400 font-semibold">{speedtestStats.latency}ms</span></span>
              </div>
            </div>
          </div>

          {/* Bottom Row: Ping Latency (full width) */}
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-4 flex flex-col flex-1 min-h-0">
            <div className="flex items-center justify-between mb-3 shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-300">Ping Latency</span>
                {isRealtimeMode && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    REALTIME
                  </span>
                )}
              </div>
              <div className="flex gap-1">
                {PING_CHART_PERIODS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setPingPeriod(p)}
                    className={`px-2 py-1 text-[10px] rounded-lg transition-all ${
                      pingPeriod.label === p.label
                        ? "bg-cyan-500/30 text-cyan-400 border border-cyan-500/50"
                        : "text-slate-500 hover:text-slate-300 hover:bg-slate-700/50"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={pingHistory} margin={{ top: 10, right: 30, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="pingGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis
                    dataKey="time"
                    tick={{ fill: "#94a3b8", fontSize: 9 }}
                    tickLine={false}
                    axisLine={false}
                    interval={isRealtimeMode ? 9 : "preserveStartEnd"}
                  />
                  <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} tickLine={false} axisLine={false} unit="ms" />
                  <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#475569', strokeWidth: 1 }} />
                  <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'TIMEOUT', fill: '#ef4444', fontSize: 9, position: 'insideTopRight' }} />
                  <Area
                    type="monotone"
                    dataKey="avg"
                    stroke="#22d3ee"
                    strokeWidth={isRealtimeMode ? 1.5 : 2}
                    fill="url(#pingGradient)"
                    name="Latency"
                    dot={isRealtimeMode ? false : false}
                    isAnimationActive={!isRealtimeMode}
                  />
                  {!isRealtimeMode && (
                    <>
                      <Line type="monotone" dataKey="max" stroke="#f87171" strokeWidth={1} dot={false} name="Max" strokeDasharray="4 4" />
                      <Line type="monotone" dataKey="min" stroke="#4ade80" strokeWidth={1} dot={false} name="Min" strokeDasharray="4 4" />
                    </>
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-between mt-2 text-[10px] text-slate-400 shrink-0">
              <span>Avg: <span className="text-cyan-400 font-semibold">{pingStats.avg}ms</span></span>
              <span>Med: <span className="text-cyan-400 font-semibold">{pingStats.med}ms</span></span>
              <span>Std: <span className="text-slate-300 font-semibold">±{pingStats.std}ms</span></span>
              <span>Min: <span className="text-emerald-400 font-semibold">{pingStats.min}ms</span></span>
              <span>Max: <span className="text-rose-400 font-semibold">{pingStats.max}ms</span></span>
              <span>Samples: <span className="text-slate-300 font-semibold">{pingStats.count}</span></span>
            </div>
          </div>
        </div>

        {/* Footer with Uptime, Health Status, and Info */}
        <footer className="flex items-center justify-between text-[10px] text-slate-500 shrink-0 bg-slate-800/30 rounded-xl px-4 py-2">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Uptime:</span>
              <span className="text-cyan-400 font-bold text-xs">{formatUptime(uptime)}</span>
            </div>
            <span className="text-slate-600">|</span>
            <span>Speedtest: 15 min</span>
            <span>•</span>
            <span>Retention: 7 days</span>
            {lastSpeedtest && (
              <>
                <span>•</span>
                <span>Last: {lastSpeedtest.server?.split(' ')[0]} @ {lastSpeedtest.timestamp?.split(' ')[1]}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Quality:</span>
              <div className="w-20 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-rose-500 via-amber-500 to-emerald-500 transition-all duration-500"
                  style={{ width: `${healthStatus.score}%` }}
                />
              </div>
              <span className={`text-xs font-bold ${healthStatus.color}`}>{healthStatus.score}%</span>
            </div>
            <div className={`px-3 py-1 rounded-lg text-[10px] font-bold ${healthStatus.bg} ${healthStatus.border} border ${healthStatus.color}`}>
              {healthStatus.label}
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
