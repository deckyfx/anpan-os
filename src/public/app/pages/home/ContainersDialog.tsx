import React, { useEffect, useState } from "react";
import { Dialog } from "../../components/Dialog";
import type { ContainerDetail, Stack } from "./types";

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

// ─── Dialog ───────────────────────────────────────────────────────────────────

export function ContainersDialog({ stack, open, onClose }: {
  stack: Stack | null;
  open: boolean;
  onClose: () => void;
}) {
  const [containers, setContainers] = useState<Record<string, ContainerDetail>>({});
  const [loading,    setLoading]    = useState(false);
  const [activeIdx,  setActiveIdx]  = useState(0);

  useEffect(() => {
    if (!open || !stack) return;
    const ids = stack.services.map(s => s.id);
    if (ids.length === 0) return;
    setLoading(true);
    setActiveIdx(0);
    Promise.all(
      ids.map(id =>
        fetch(`/api/docker/containers/${id}`)
          .then(r => r.json() as Promise<ContainerDetail>)
          .then(d => [id, d] as [string, ContainerDetail])
          .catch(() => null)
      )
    ).then(results => {
      const map: Record<string, ContainerDetail> = {};
      for (const r of results) {
        if (r) map[r[0]] = r[1];
      }
      setContainers(map);
    }).finally(() => setLoading(false));
  }, [open, stack]);

  if (!stack) return null;

  const activeSvc = stack.services[activeIdx];
  const detail    = activeSvc ? containers[activeSvc.id] : undefined;

  return (
    <Dialog
      open={open}
      title={`Containers — ${stack.name}`}
      onClose={onClose}
      size="xl"
      footer={
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
          Close
        </button>
      }
    >
      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse py-4">Loading container details…</p>
      ) : (
        <>
          {/* Service tabs — one per container */}
          {stack.services.length > 1 && (
            <div className="flex gap-1 mb-5 border-b border-gray-800 -mt-1 overflow-x-auto">
              {stack.services.map((svc, i) => (
                <button
                  key={svc.id}
                  onClick={() => setActiveIdx(i)}
                  className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px shrink-0
                    ${activeIdx === i
                      ? "border-amber-500 text-amber-400"
                      : "border-transparent text-gray-500 hover:text-gray-200"
                    }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${svc.state === "running" ? "bg-green-400" : "bg-red-400"}`} />
                  {svc.service}
                </button>
              ))}
            </div>
          )}

          {activeSvc && (
            <>
              {/* Container header */}
              <div className="flex items-center gap-2 text-xs text-gray-500 pb-3 mb-3 border-b border-gray-800">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${activeSvc.state === "running" ? "bg-green-400" : "bg-red-400"}`} />
                <span className="font-medium text-gray-300">{activeSvc.service}</span>
                <span className="text-gray-700">·</span>
                <span className="font-mono text-gray-500 truncate flex-1">{activeSvc.image}</span>
                <span className="font-mono shrink-0">{activeSvc.id.slice(0, 12)}</span>
              </div>

              {!detail ? (
                <p className="text-gray-600 text-sm">No details available.</p>
              ) : (
                <ContainerPanel detail={detail} />
              )}
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
