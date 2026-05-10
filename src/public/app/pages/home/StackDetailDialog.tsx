import { useState, useEffect } from "react";
import { ExternalLink } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import type { ComposeOrigin, ContainerDetail, Stack } from "./types";
import { buildLaunchUrl, stackStateColor } from "./utils";
import { api } from "../../lib/api";

const ORIGIN_LABEL: Record<NonNullable<ComposeOrigin>, { label: string; cls: string }> = {
  managed: { label: "⚙ Managed by anpan-os", cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
  casaos:  { label: "🏠 Managed by CasaOS",  cls: "text-sky-400  bg-sky-500/10  border-sky-500/20"  },
};

// ─── KV display helpers ───────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1.5">{title}</p>
      <div className="space-y-1 pl-1">{children}</div>
    </div>
  );
}

function KVRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2 min-w-0">
      <span className="text-gray-500 shrink-0 w-32 truncate">{k}</span>
      <span className={`text-gray-300 truncate flex-1 ${mono ? "font-mono" : ""}`} title={v}>{v || "—"}</span>
    </div>
  );
}

// ─── Container detail panel ───────────────────────────────────────────────────

function ContainerPanel({ detail }: { detail: ContainerDetail }) {
  return (
    <div className="space-y-4 text-xs">
      <Section title="State">
        <KVRow k="Status"  v={detail.State.Status} />
        <KVRow k="Started" v={detail.State.StartedAt ? new Date(detail.State.StartedAt).toLocaleString() : "—"} />
        {!detail.State.Running && (
          <>
            <KVRow k="Finished"  v={detail.State.FinishedAt ? new Date(detail.State.FinishedAt).toLocaleString() : "—"} />
            <KVRow k="Exit code" v={String(detail.State.ExitCode)} />
          </>
        )}
      </Section>

      <Section title="Config">
        <KVRow k="Hostname"       v={detail.Config.Hostname} />
        <KVRow k="Network mode"   v={detail.HostConfig.NetworkMode} />
        <KVRow k="Restart policy" v={
          detail.HostConfig.RestartPolicy.Name === "on-failure"
            ? `on-failure (max ${detail.HostConfig.RestartPolicy.MaximumRetryCount})`
            : detail.HostConfig.RestartPolicy.Name || "no"
        } />
      </Section>

      {Object.keys(detail.NetworkSettings.Ports).length > 0 && (
        <Section title="Ports">
          {Object.entries(detail.NetworkSettings.Ports).map(([containerPort, bindings]) => (
            <KVRow
              key={containerPort}
              k={containerPort}
              v={bindings?.map(b => `${b.HostIp}:${b.HostPort}`).join(", ") ?? "—"}
            />
          ))}
        </Section>
      )}

      {detail.Mounts.length > 0 && (
        <Section title="Mounts">
          {detail.Mounts.map((m, i) => (
            <KVRow
              key={i}
              k={`${m.Type}${m.RW ? "" : " (ro)"}`}
              v={`${m.Source} → ${m.Destination}`}
              mono
            />
          ))}
        </Section>
      )}

      {Object.keys(detail.NetworkSettings.Networks).length > 0 && (
        <Section title="Networks">
          {Object.entries(detail.NetworkSettings.Networks).map(([net, info]) => (
            <KVRow key={net} k={net} v={info.IPAddress || "—"} />
          ))}
        </Section>
      )}

      {detail.Config.Env && detail.Config.Env.length > 0 && (
        <Section title="Environment">
          {detail.Config.Env.map((e, i) => {
            const [key, ...rest] = e.split("=");
            return <KVRow key={i} k={key ?? e} v={rest.join("=") || ""} mono />;
          })}
        </Section>
      )}
    </div>
  );
}

// ─── Inner component — keyed by stack.name so state initializes fresh each time ──

type DetailTab = "docker" | `service:${string}`;

function StackDetailDialogInner({ stack, onClose }: {
  stack: Stack;
  onClose: () => void;
}) {
  const launchUrl = buildLaunchUrl(stack);
  const [tab, setTab] = useState<DetailTab>("docker");

  // Container details — fetched once on mount
  const [containers,    setContainers]    = useState<Record<string, ContainerDetail>>({});
  const [containersLoading, setContainersLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const ids = stack.services.map(s => s.id);
    if (ids.length === 0) { setContainersLoading(false); return; }
    setContainersLoading(true);
    Promise.all(
      ids.map(id =>
        api.api.docker.containers({ id }).get()
          .then(({ data }) => data ? [id, data as ContainerDetail] as [string, ContainerDetail] : null)
          .catch(() => null)
      )
    ).then(results => {
      if (cancelled) return;
      const map: Record<string, ContainerDetail> = {};
      for (const r of results) { if (r) map[r[0]] = r[1]; }
      setContainers(map);
    }).finally(() => { if (!cancelled) setContainersLoading(false); });
    return () => { cancelled = true; };
  }, [stack.services]);

  const tabs: { id: DetailTab; label: string }[] = [
    { id: "docker", label: "Docker" },
    ...stack.services.map(svc => ({ id: `service:${svc.service}` as const, label: svc.service })),
  ];

  const activeSvcName = tab.startsWith("service:") ? tab.slice("service:".length) : null;
  const activeSvc = activeSvcName ? stack.services.find(s => s.service === activeSvcName) : null;

  return (
    <Dialog
      open
      title={stack.meta?.title ?? stack.name}
      onClose={onClose}
      size="xl"
      footer={
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
          Close
        </button>
      }
    >
      {/* Tab bar */}
      <div className="flex gap-1 mb-5 border-b border-gray-800 -mt-1 overflow-x-auto">
        {tabs.map(t => {
          const svcName = t.id.startsWith("service:") ? t.id.slice("service:".length) : null;
          const svc = svcName ? stack.services.find(s => s.service === svcName) : null;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px shrink-0
                ${tab === t.id
                  ? "border-amber-500 text-amber-400"
                  : "border-transparent text-gray-500 hover:text-gray-200"
                }`}
            >
              {svc && (
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${svc.state === "running" ? "bg-green-400" : "bg-red-400"}`} />
              )}
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="h-128 overflow-y-auto pr-1">

      {/* ── Docker overview ─────────────────────────────────────────── */}
      {tab === "docker" && (
        <div className="space-y-4 text-sm">
          {launchUrl && (
            <a
              href={launchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-amber-400 hover:text-amber-300 hover:underline min-w-0"
              title={launchUrl}
            >
              <ExternalLink size={14} className="shrink-0" />
              <span className="truncate overflow-hidden whitespace-nowrap">Open web UI — {launchUrl}</span>
            </a>
          )}

          <div className="flex items-center gap-3">
            <span className="text-gray-500">Project name</span>
            <span className="font-mono text-gray-200">{stack.name}</span>
            <span className="ml-auto flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${stackStateColor[stack.state]}`} />
              <span className="text-gray-400">{stack.state}</span>
            </span>
          </div>

          {stack.origin && (() => {
            const o = ORIGIN_LABEL[stack.origin];
            return <p className={`text-xs px-3 py-1.5 rounded-lg border ${o.cls}`}>{o.label}</p>;
          })()}
          {!stack.origin && (
            <p className="text-xs px-3 py-1.5 rounded-lg border border-gray-800 text-gray-600">
              No compose file found — discovered from Docker only
            </p>
          )}

          <div>
            <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">Services</p>
            <div className="overflow-x-auto rounded-lg border border-gray-800">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-600">
                    <th className="text-left px-3 py-2 font-medium">Service</th>
                    <th className="text-left px-3 py-2 font-medium">Image</th>
                    <th className="text-left px-3 py-2 font-medium">Container ID</th>
                    <th className="text-left px-3 py-2 font-medium">State</th>
                    <th className="text-left px-3 py-2 font-medium">Ports</th>
                  </tr>
                </thead>
                <tbody>
                  {stack.services.map(svc => (
                    <tr
                      key={svc.id}
                      className="border-b border-gray-800/50 last:border-0 cursor-pointer hover:bg-gray-800/40 transition-colors"
                      onClick={() => setTab(`service:${svc.service}`)}
                    >
                      <td className="px-3 py-2 text-gray-200 font-medium">{svc.service}</td>
                      <td className="px-3 py-2 font-mono text-gray-400 max-w-48 truncate" title={svc.image}>{svc.image}</td>
                      <td className="px-3 py-2 font-mono text-gray-500">{svc.id.slice(0, 12)}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${svc.state === "running" ? "bg-green-400" : "bg-red-400"}`} />
                          <span className="text-gray-400">{svc.state}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-500 font-mono">
                        {svc.ports.filter(p => p.PublicPort).map(p => `${p.PublicPort}:${p.PrivatePort}/${p.Type ?? "tcp"}`).join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Per-service container detail ────────────────────────────── */}
      {activeSvc && (
        <>
          <div className="flex items-center gap-2 text-xs text-gray-500 pb-3 mb-3 border-b border-gray-800">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${activeSvc.state === "running" ? "bg-green-400" : "bg-red-400"}`} />
            <span className="font-medium text-gray-300">{activeSvc.service}</span>
            <span className="text-gray-700">·</span>
            <span className="font-mono text-gray-500 truncate flex-1">{activeSvc.image}</span>
            <span className="font-mono shrink-0">{activeSvc.id.slice(0, 12)}</span>
          </div>

          {containersLoading ? (
            <p className="text-gray-500 text-sm animate-pulse py-4">Loading container details…</p>
          ) : !containers[activeSvc.id] ? (
            <p className="text-gray-600 text-sm">No details available.</p>
          ) : (
            <ContainerPanel detail={containers[activeSvc.id]!} />
          )}
        </>
      )}

      </div>
    </Dialog>
  );
}

// ─── Public component — renders nothing when closed ──────────────────────────

export function StackDetailDialog({ stack, open, onClose }: {
  stack: Stack;
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return <StackDetailDialogInner key={stack.name} stack={stack} onClose={onClose} />;
}
