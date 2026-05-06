import React, { useEffect, useState } from "react";
import type { SystemStats } from "./types";
import { toGB } from "./utils";

export function ClockWidget() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-3xl font-mono font-semibold text-white tabular-nums">{timeStr}</p>
      <p className="text-xs text-gray-500 mt-1">{dateStr}</p>
    </div>
  );
}

export function CalendarWidget() {
  const now         = new Date();
  const year        = now.getFullYear();
  const month       = now.getMonth();
  const today       = now.getDate();
  const monthName   = now.toLocaleDateString([], { month: "long", year: "numeric" });
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs font-semibold text-gray-300 mb-3">{monthName}</p>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d, i) => (
          <span key={i} className="text-gray-600 pb-1 font-medium">{d}</span>
        ))}
        {cells.map((day, i) => (
          <span
            key={i}
            className={`py-0.5 rounded-md leading-5 ${
              day === today
                ? "bg-amber-500 text-black font-bold"
                : day ? "text-gray-300" : ""
            }`}
          >
            {day ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatBar({ label, used, total, color }: {
  label: string;
  used: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5">
        <span className="text-gray-500">{label}</span>
        <span className="text-gray-300 tabular-nums">{toGB(used)} / {toGB(total)}</span>
      </div>
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function SystemWidget({ stats }: { stats: SystemStats | null }) {
  if (!stats) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs text-gray-600 animate-pulse">
        Loading…
      </div>
    );
  }

  const cpuColor = stats.cpu > 80 ? "bg-red-500" : stats.cpu > 50 ? "bg-yellow-400" : "bg-green-400";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">Resources</p>
      <div>
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-gray-500">CPU</span>
          <span className="text-gray-300 tabular-nums">{stats.cpu}%</span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div className={`h-full ${cpuColor} rounded-full transition-all duration-700`} style={{ width: `${stats.cpu}%` }} />
        </div>
      </div>
      <StatBar label="RAM"  used={stats.ramUsed}  total={stats.ramTotal}  color="bg-blue-500" />
      <StatBar label="Disk" used={stats.diskUsed} total={stats.diskTotal} color="bg-violet-500" />
    </div>
  );
}

export function NetworkWidget() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Network</p>
      <div className="space-y-2 text-xs">
        <div className="flex justify-between items-center">
          <span className="text-gray-500">Host</span>
          <span className="text-gray-300 font-mono truncate max-w-27.5">{window.location.hostname}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-gray-500">Port</span>
          <span className="text-gray-300 font-mono">{window.location.port || "443"}</span>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-gray-500">Online</span>
        </div>
      </div>
    </div>
  );
}
