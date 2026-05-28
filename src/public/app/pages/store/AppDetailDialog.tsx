import { useState, useRef, useEffect } from "react";
import Viewer from "viewerjs";
import { useShallow } from "zustand/react/shallow";
import { Dialog } from "../../components/Dialog";
import { useAppStoreStore } from "../../stores/appStoreStore";
import { GuidedStackDialog } from "../home/GuidedStackDialog";
import type { StoreApp } from "./types";

export function AppDetailDialog() {
  const { detailApp, setDetailApp, installApp, installContent, startInstall, clearInstall } =
    useAppStoreStore(useShallow(s => ({
      detailApp:      s.detailApp,
      setDetailApp:   s.setDetailApp,
      installApp:     s.installApp,
      installContent: s.installContent,
      startInstall:   s.startInstall,
      clearInstall:   s.clearInstall,
    })));

  const [installing, setInstalling] = useState(false);

  const app = detailApp;

  const handleInstall = async () => {
    if (!app) return;
    setInstalling(true);
    try {
      await startInstall(app);
    } finally {
      setInstalling(false);
    }
    // Close detail dialog; GuidedStackDialog will open via installContent being set
    setDetailApp(null);
  };

  // When install content is ready, show the GuidedStackDialog
  const isInstalling = !!installApp && installContent !== null;

  return (
    <>
      <Dialog
        open={!!app}
        title={app?.title ?? ""}
        size="xl"
        onClose={() => setDetailApp(null)}
        footer={
          app ? (
            <>
              <button
                onClick={() => setDetailApp(null)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => void handleInstall()}
                disabled={installing}
                className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {installing && (
                  <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                )}
                Install
              </button>
            </>
          ) : null
        }
      >
        {app && <AppDetailBody app={app} />}
      </Dialog>

      <GuidedStackDialog
        mode="create"
        open={isInstalling}
        initialContent={installContent ?? undefined}
        initialAppId={installApp?.id}
        onClose={clearInstall}
        onDone={clearInstall}
      />
    </>
  );
}

// ── Screenshot gallery with viewerjs zoom ─────────────────────────────────────

function ScreenshotGallery({ screenshots }: { screenshots: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const viewer = new Viewer(el, {
      toolbar: {
        zoomIn: 4, zoomOut: 4, oneToOne: 4, reset: 4,
        prev: 4, play: 0, next: 4,
        rotateLeft: 0, rotateRight: 0,
        flipHorizontal: 0, flipVertical: 0,
      },
    });
    return () => { viewer.destroy(); };
  }, [screenshots]);

  return (
    <div ref={containerRef} className="flex gap-3 overflow-x-auto pb-2">
      {screenshots.map((url, i) => (
        <img
          key={i}
          src={url}
          alt={`Screenshot ${i + 1}`}
          className="h-36 rounded-lg object-cover shrink-0 border border-gray-800 cursor-zoom-in"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ))}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(v: unknown): string {
  let d: Date;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === "string" && v) {
    d = new Date(v);
  } else {
    return "";
  }
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ── App detail body ────────────────────────────────────────────────────────────

const LINKS = [
  { key: "website" as const, label: "Website" },
  { key: "repo"    as const, label: "GitHub"  },
  { key: "support" as const, label: "Support" },
  { key: "docs"    as const, label: "Docs"    },
] as const;

function AppDetailBody({ app }: { app: StoreApp }) {
  console.log("[AppDetailBody] app data:", app);
  const hasDevSection =
    app.version || app.updatedAt || app.releaseNotes ||
    app.website || app.repo || app.support || app.docs;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-4">
        {app.icon ? (
          <img
            src={app.icon}
            alt={app.title}
            className="w-20 h-20 rounded-2xl object-cover shrink-0 bg-gray-800"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="w-20 h-20 rounded-2xl bg-gray-800 flex items-center justify-center shrink-0">
            <span className="text-4xl">📦</span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-xl font-semibold text-white">{app.title}</h3>
          {app.developer && <p className="text-sm text-gray-500 mt-1">by {app.developer}</p>}
          {app.category && (
            <span className="inline-block mt-2 text-[10px] font-medium bg-gray-800 text-gray-400 rounded-full px-2.5 py-0.5">
              {app.category}
            </span>
          )}
          {app.architectures.length > 0 && (
            <div className="flex gap-1 flex-wrap mt-2">
              {app.architectures.map(a => (
                <span key={a} className="text-[10px] font-mono bg-gray-800 text-gray-500 rounded px-1.5 py-0.5">{a}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Screenshots */}
      {app.screenshots.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Screenshots</p>
          <ScreenshotGallery screenshots={app.screenshots} />
        </div>
      )}

      {/* Before-install tip */}
      {app.beforeInstallTip && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
          <p className="text-xs font-semibold text-amber-400 mb-1">Before installing</p>
          <p className="text-sm text-amber-200/80 whitespace-pre-wrap">{app.beforeInstallTip}</p>
        </div>
      )}

      {/* Description */}
      {app.description && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">About</p>
          <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{app.description}</p>
        </div>
      )}

      {/* Developer & Release */}
      {hasDevSection && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Developer &amp; Release</p>

          {/* Version / updated row */}
          {(app.version || app.updatedAt) && (
            <div className="flex gap-4 mb-3">
              {app.version && (
                <div>
                  <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">Version</p>
                  <p className="text-sm font-mono text-white">{app.version}</p>
                </div>
              )}
              {app.updatedAt && (
                <div>
                  <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">Updated</p>
                  <p className="text-sm text-gray-300">{formatDate(app.updatedAt)}</p>
                </div>
              )}
            </div>
          )}

          {/* Release notes (collapsible) */}
          {app.releaseNotes && (
            <details className="mb-3 group">
              <summary className="text-xs text-gray-500 cursor-pointer select-none hover:text-gray-300 transition-colors list-none flex items-center gap-1">
                <span className="group-open:rotate-90 inline-block transition-transform">▶</span>
                Release notes
              </summary>
              <pre className="mt-2 text-xs text-gray-300 whitespace-pre-wrap leading-relaxed bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 max-h-48 overflow-y-auto font-sans">
                {app.releaseNotes}
              </pre>
            </details>
          )}

          {/* Links */}
          {LINKS.some(l => app[l.key]) && (
            <div className="flex flex-wrap gap-2">
              {LINKS.filter(l => app[l.key]).map(l => (
                <a
                  key={l.key}
                  href={app[l.key]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 border border-gray-700 transition-colors"
                >
                  {l.label} ↗
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Port map */}
      {app.portMap && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Port Map</p>
          <code className="block text-xs text-gray-300 bg-gray-800 rounded-lg px-3 py-2 font-mono">{app.portMap}</code>
        </div>
      )}
    </div>
  );
}
