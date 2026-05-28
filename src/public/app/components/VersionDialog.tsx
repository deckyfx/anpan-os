import { useState, useEffect } from "react";
import { CheckCircle, Download, AlertCircle } from "lucide-react";
import { Dialog } from "./Dialog";
import { api } from "../lib/api";

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  releaseNotes?: string;
  downloadUrl?: string;
  sha256Url?: string;
  error?: string;
}

/**
 * Shows current version, GitHub release notes, and an update check with one-click install.
 */
export function VersionDialog({ open, onClose, version }: {
  open: boolean;
  onClose: () => void;
  version: string;
}) {
  const [checking, setChecking]     = useState(false);
  const [result,   setResult]       = useState<UpdateCheckResult | null>(null);
  const [updating, setUpdating]     = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setUpdateError("");
    setRestarting(false);
    setUpdating(false);
    setChecking(true);
    void api.api.system["update-check"].get()
      .then(({ data, error }) => {
        if (error) {
          const msg = (error as { value?: { error?: string } }).value?.error ?? "Request failed";
          setResult({ updateAvailable: false, currentVersion: version, error: msg });
        } else if (data) {
          setResult(data as UpdateCheckResult);
        }
      })
      .catch((e: unknown) => {
        setResult({ updateAvailable: false, currentVersion: version, error: String(e) });
      })
      .finally(() => setChecking(false));
  }, [open]);

  const handleUpdate = async () => {
    setUpdateError("");
    setUpdating(true);
    try {
      const { error } = await api.api.system.update.post();
      if (error) {
        const msg = (error as { value?: { error?: string } }).value?.error ?? "Update failed";
        setUpdateError(msg);
        setUpdating(false);
        return;
      }
      setRestarting(true);
      // Poll until the server responds after restart, then reload.
      // Give up after ~90 s (3 s initial delay + 30 retries × 3 s).
      const MAX_RETRIES = 30;
      let attempts = 0;
      const poll = () => {
        void api.api.system.info.get()
          .then(() => { window.location.reload(); })
          .catch(() => {
            attempts++;
            if (attempts >= MAX_RETRIES) {
              setRestarting(false);
              setUpdateError("Service did not respond after restart — please reload manually.");
              return;
            }
            setTimeout(poll, 3000);
          });
      };
      setTimeout(poll, 3000);
    } catch (e: unknown) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setUpdating(false);
    }
  };

  return (
    <Dialog open={open} title="Version & Updates" onClose={restarting ? () => {} : onClose} disableBackdropClose={restarting} size="md">
      {/* Current version */}
      <div className="mb-5 text-center py-2">
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Current version</p>
        <p className="text-3xl font-bold font-mono text-amber-400">v{version}</p>
      </div>

      {/* Update check */}
      <div className="mb-4 p-3 bg-gray-900 rounded-xl border border-gray-800">
        {checking && (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <span className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin shrink-0" />
            Checking for updates…
          </div>
        )}

        {!checking && result && !result.error && !result.updateAvailable && (
          <div className="flex items-center gap-2 text-green-400 text-sm">
            <CheckCircle size={15} className="shrink-0" />
            You&apos;re up to date
          </div>
        )}

        {!checking && result?.error && (
          <div className="flex items-start gap-2 text-red-400 text-sm">
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <span>Failed to check for updates: {result.error}</span>
          </div>
        )}

        {!checking && result?.updateAvailable && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">Update available</p>
                <p className="text-xs text-gray-400">v{result.latestVersion} is ready to install</p>
              </div>
              {!restarting && (
                <button
                  onClick={() => void handleUpdate()}
                  disabled={updating}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 shrink-0"
                >
                  {updating
                    ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    : <Download size={12} />}
                  {updating ? "Installing…" : "Update now"}
                </button>
              )}
            </div>
            {restarting && (
              <div className="flex items-center gap-2 text-amber-400 text-xs">
                <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin shrink-0" />
                Restarting service — reconnecting…
              </div>
            )}
            {updateError && (
              <p className="text-xs text-red-400">{updateError}</p>
            )}
          </div>
        )}
      </div>

      {/* Release notes */}
      {result?.releaseNotes && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Release notes</p>
          <pre className="text-xs text-gray-300 whitespace-pre-wrap bg-gray-900 border border-gray-800 rounded-xl p-3 max-h-64 overflow-y-auto font-mono leading-relaxed">
            {result.releaseNotes}
          </pre>
        </div>
      )}
    </Dialog>
  );
}
