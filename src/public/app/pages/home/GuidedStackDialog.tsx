import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { FileCode, FileText, Loader2, Wand2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";
import type { Stack } from "./types";
import { AppConfigTab }   from "./guided/AppConfigTab";
import { EnvFileTab }     from "./guided/EnvFileTab";
import { ServiceTab }     from "./guided/ServiceTab";
import { StackConfigTab } from "./guided/StackConfigTab";
import {
  parseComposeDoc, serializeComposeDoc,
  parseService,    serializeService,
  parseStackConfig, serializeStackConfig,
} from "./guided/composeUtils";
import type { AppConfigState, OpenMode, ServiceForm, StackConfig } from "./guided/types";

interface SSEMsg { log?: string; ok?: boolean; error?: string }

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

function toSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const EDITOR_OPTIONS = {
  minimap:              { enabled: false },
  fontSize:             13,
  lineNumbers:          "on" as const,
  scrollBeyondLastLine: false,
  wordWrap:             "off" as const,
  tabSize:              2,
  insertSpaces:         true,
  renderLineHighlight:  "line" as const,
  padding:              { top: 12, bottom: 12 },
  scrollbar:            { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
};

const DEFAULT_YAML = `services:
  app:
    image: nginx:latest
    ports:
      - "8080:80"
    restart: unless-stopped
`;

function initForms(yaml: string, projectName = "") {
  try {
    const doc   = parseComposeDoc(yaml);
    const names = Object.keys(doc.services ?? {});
    const cfg   = parseStackConfig(doc);
    if (!cfg.name && projectName) cfg.name = projectName;
    return {
      serviceNames: names,
      serviceForms: Object.fromEntries(names.map(n => [n, parseService(doc.services[n])])),
      stackConfig:  cfg,
    };
  } catch {
    return {
      serviceNames: [] as string[],
      serviceForms: {} as Record<string, ServiceForm>,
      stackConfig:  { name: projectName, networks: [], volumes: [] } as StackConfig,
    };
  }
}

function initAppConfig(stack: Stack | null): AppConfigState {
  return {
    title:     stack?.meta?.title     ?? "",
    icon:      stack?.meta?.icon      ?? "",
    scheme:    stack?.meta?.scheme    ?? "http",
    portMap:   stack?.meta?.portMap   ?? "",
    indexPath: stack?.meta?.indexPath ?? "/",
    address:   stack?.meta?.address   ?? "",
    note:      stack?.meta?.note      ?? "",
    openMode:  (stack?.meta?.openMode as OpenMode | undefined) ?? "new-page",
  };
}

type TabId = "app-config" | "stack-config" | "env-file" | "yaml" | "action-log" | "install-log" | string;

// ─── Outer wrapper ────────────────────────────────────────────────────────────

export function GuidedStackDialog({ mode, stack, open, onClose, onDone }: {
  mode:    "create" | "edit";
  stack?:  Stack | null;
  open:    boolean;
  onClose: () => void;
  onDone:  () => void;
}) {
  if (!open) return null;
  if (mode === "edit" && !stack) return null;
  return (
    <GuidedStackDialogInner
      key={mode === "edit" ? stack!.name : "new"}
      mode={mode}
      stack={stack ?? null}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

// ─── Inner component ──────────────────────────────────────────────────────────

function GuidedStackDialogInner({ mode, stack, onClose, onDone }: {
  mode:    "create" | "edit";
  stack:   Stack | null;
  onClose: () => void;
  onDone:  () => void;
}) {
  const isEdit = mode === "edit";
  const init   = isEdit ? initForms("", stack?.name ?? "") : initForms(DEFAULT_YAML);

  const [loading,          setLoading]          = useState(isEdit);
  const [yamlContent,      setYamlContent]      = useState(isEdit ? "" : DEFAULT_YAML);
  const [envContent,       setEnvContent]       = useState("");
  const [envTouched,       setEnvTouched]       = useState(false);
  const [serviceNames,     setServiceNames]     = useState<string[]>(init.serviceNames);
  const [serviceForms,     setServiceForms]     = useState<Record<string, ServiceForm>>(init.serviceForms);
  const [stackConfig,      setStackConfig]      = useState<StackConfig>(init.stackConfig);
  const [stackNameDirty,   setStackNameDirty]   = useState(false);
  const [appConfig,        setAppConfig]        = useState<AppConfigState>(() => initAppConfig(stack));
  const [activeTab,        setActiveTab]        = useState<TabId>("app-config");
  const [parseErrors,      setParseErrors]      = useState<string[]>([]);
  const [busy,             setBusy]             = useState(false);
  const [actionLog,        setActionLog]        = useState<string[]>([]);
  const [installLog,       setInstallLog]       = useState<string | null>(null);
  const [installLogBusy,   setInstallLogBusy]   = useState(false);
  const [error,            setError]            = useState("");

  const logRef   = useRef<HTMLPreElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [actionLog]);

  // Cancel any in-flight SSE when the component unmounts
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // Block close while an install/deploy is streaming
  const handleClose = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);

  // Edit mode: load existing YAML + env file on mount
  useEffect(() => {
    if (!isEdit || !stack) return;
    void (async () => {
      try {
        const { data: fileData, error: fileErr } =
          await api.api.compose.stacks({ name: stack.name }).file.get();
        if (fileErr) {
          setError((fileErr.value as { error?: string })?.error ?? "Failed to load compose file");
          setLoading(false);
          return;
        }
        const yaml = fileData as unknown as string;
        setYamlContent(yaml);

        try {
          const doc   = parseComposeDoc(yaml);
          const names = Object.keys(doc.services ?? {});
          setServiceNames(names);
          setServiceForms(Object.fromEntries(names.map(n => [n, parseService(doc.services[n])])));
          const cfg = parseStackConfig(doc);
          if (!cfg.name && stack?.name) cfg.name = stack.name;
          setStackConfig(cfg);
        } catch { /* ignore parse errors on load */ }

        const envRes  = await api.api.compose.stacks({ name: stack.name }).envfile.get();
        const envData = envRes.data as { content?: string } | null;
        if (envData?.content !== undefined) setEnvContent(envData.content);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load stack data");
      } finally {
        setLoading(false);
      }
    })();
  }, [isEdit, stack]);

  // ── Sync helpers ──────────────────────────────────────────────────────────

  const handleParseToForms = () => {
    try {
      const doc   = parseComposeDoc(yamlContent);
      const names = Object.keys(doc.services ?? {});
      setServiceNames(names);
      setServiceForms(Object.fromEntries(names.map(n => [n, parseService(doc.services[n])])));
      setStackConfig(parseStackConfig(doc));
      setParseErrors([]);
      if (names[0]) setActiveTab(names[0]);
    } catch (e) {
      setParseErrors([e instanceof Error ? e.message : "Invalid YAML"]);
    }
  };

  const handleFormsToYaml = () => {
    try {
      const doc      = parseComposeDoc(yamlContent);
      const services = Object.fromEntries(
        serviceNames.map(n => [n, serializeService(serviceForms[n] ?? parseService({}))])
      );
      const withCfg  = serializeStackConfig(stackConfig, { ...doc, services });
      setYamlContent(serializeComposeDoc(withCfg));
      setActiveTab("yaml");
    } catch (e) {
      setParseErrors([e instanceof Error ? e.message : "Failed to apply forms to YAML"]);
    }
  };

  // Sync forms → YAML and return the result
  const syncYaml = (): string => {
    if (serviceNames.length === 0) return yamlContent;
    try {
      const doc      = parseComposeDoc(yamlContent);
      const services = Object.fromEntries(
        serviceNames.map(n => [n, serializeService(serviceForms[n] ?? parseService({}))])
      );
      const withCfg  = serializeStackConfig(stackConfig, { ...doc, services });
      const yaml     = serializeComposeDoc(withCfg);
      setYamlContent(yaml);
      return yaml;
    } catch {
      return yamlContent;
    }
  };

  // ── App config change with soft-binding ──────────────────────────────────

  const handleAppConfigChange = (v: AppConfigState) => {
    setAppConfig(v);
    if (!isEdit && !stackNameDirty) {
      setStackConfig(prev => ({ ...prev, name: toSlug(v.title) }));
    }
  };

  // ── Create action ─────────────────────────────────────────────────────────

  const handleCreate = async () => {
    setError("");
    setParseErrors([]);

    const name = stackConfig.name.trim();
    if (!name || !NAME_RE.test(name)) {
      setError("Stack Name is required and must only contain letters, numbers, dashes, or underscores.");
      return;
    }

    const yaml = syncYaml();
    if (!yaml.trim()) { setError("Compose content cannot be empty."); return; }

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setActionLog([]);
    setActiveTab("action-log");

    try {
      const { data, error: err } = await api.api.compose.stacks.post(
        { name, content: yaml },
        { fetch: { signal: controller.signal } },
      );
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Request failed");
        setBusy(false);
        return;
      }

      if (!data) { setError("No stream received from server"); setBusy(false); return; }
      for await (const event of data as AsyncIterable<{ data: SSEMsg }>) {
        const m = event.data as SSEMsg | undefined;
        if (!m) continue;
        if (m.log !== undefined) {
          setActionLog(prev => [...prev, m.log!]);
        } else if (m.ok) {
          if (appConfig.title || appConfig.icon || appConfig.portMap || appConfig.note) {
            await api.api.docker.stacks({ name }).patch({
              title:     appConfig.title     || undefined,
              icon:      appConfig.icon      || undefined,
              scheme:    appConfig.scheme    || undefined,
              portMap:   appConfig.portMap   || undefined,
              indexPath: appConfig.indexPath || undefined,
              address:   appConfig.address   || undefined,
              note:      appConfig.note      || undefined,
              openMode:  appConfig.openMode  || undefined,
            });
          }
          if (envTouched && envContent.trim()) {
            await api.api.compose.stacks({ name }).envfile.put({ content: envContent });
          }
          useToastStore.getState().push("Stack installed", "success");
          onDone();
          onClose();
          return;
        } else if (m.error) {
          setError(m.error);
          setBusy(false);
          return;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    } finally {
      abortRef.current = null;
    }
  };

  // ── Deploy action (edit mode) ─────────────────────────────────────────────

  const handleDeploy = async () => {
    if (!yamlContent.trim()) { setError("Compose content cannot be empty."); return; }
    setError("");
    setParseErrors([]);

    const yaml = syncYaml();

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setActionLog([]);
    setActiveTab("action-log");

    try {
      if (envTouched) {
        const { error: envErr } = await api.api.compose.stacks({ name: stack!.name }).envfile.put(
          { content: envContent },
          { fetch: { signal: controller.signal } },
        );
        if (envErr) {
          setError((envErr.value as { error?: string })?.error ?? "Failed to save .env file");
          setBusy(false);
          return;
        }
      }

      await api.api.docker.stacks({ name: stack!.name }).patch(
        {
          title:     appConfig.title     || undefined,
          icon:      appConfig.icon      || undefined,
          scheme:    appConfig.scheme    || undefined,
          portMap:   appConfig.portMap   || undefined,
          indexPath: appConfig.indexPath || undefined,
          address:   appConfig.address   || undefined,
          note:      appConfig.note      || undefined,
          openMode:  appConfig.openMode  || undefined,
        },
        { fetch: { signal: controller.signal } },
      );

      const { data: sseData, error: sseErr } =
        await api.api.compose.stacks({ name: stack!.name }).file.put(
          { content: yaml },
          { fetch: { signal: controller.signal } },
        );
      if (sseErr) {
        setError((sseErr.value as { error?: string })?.error ?? "Request failed");
        setBusy(false);
        return;
      }

      if (!sseData) { setError("No stream received from server"); setBusy(false); return; }
      for await (const event of sseData as AsyncIterable<{ data: SSEMsg }>) {
        const m = event.data as SSEMsg | undefined;
        if (!m) continue;
        if (m.log !== undefined) {
          setActionLog(prev => [...prev, m.log!]);
        } else if (m.ok) {
          useToastStore.getState().push("Stack updated and deployed", "success");
          onDone();
          onClose();
          return;
        } else if (m.error) {
          setError(m.error);
          setBusy(false);
          return;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    } finally {
      abortRef.current = null;
    }
  };

  // ── UI ────────────────────────────────────────────────────────────────────

  const title = isEdit
    ? `Edit (Guided) — ${stack!.meta?.title ?? stack!.name}`
    : "New Stack";

  const staticTabs: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
    { id: "app-config",   label: "App Config",   icon: <Wand2 size={12} /> },
    { id: "stack-config", label: "Stack Config", icon: <FileCode size={12} /> },
    { id: "env-file",     label: "Env File",     icon: <FileText size={12} /> },
    { id: "yaml",         label: "YAML",         icon: <FileCode size={12} /> },
  ];

  const errorNotif = (error || parseErrors.length > 0) ? (
    <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 whitespace-pre-wrap">
      {error || parseErrors.join("\n")}
    </p>
  ) : undefined;

  const footer = (
    <div className="flex items-center gap-2 w-full">
      <button
        type="button"
        onClick={handleParseToForms}
        disabled={busy || loading}
        className="px-3 py-2 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white rounded-lg transition-colors disabled:opacity-40"
      >
        Parse YAML → Forms
      </button>
      <button
        type="button"
        onClick={handleFormsToYaml}
        disabled={busy || loading || serviceNames.length === 0}
        className="px-3 py-2 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white rounded-lg transition-colors disabled:opacity-40"
      >
        Forms → Apply to YAML
      </button>

      <div className="flex-1" />

      <button
        type="button"
        onClick={handleClose}
        disabled={busy}
        className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={() => void (isEdit ? handleDeploy() : handleCreate())}
        disabled={busy || loading || (!isEdit && !stackConfig.name)}
        className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
      >
        {busy
          ? <><Loader2 size={13} className="inline animate-spin mr-1" />{isEdit ? "Deploying…" : "Installing…"}</>
          : isEdit ? "Save & Deploy" : "Install"
        }
      </button>
    </div>
  );

  if (loading) {
    return (
      <Dialog open title={title} onClose={handleClose} size="2xl" disableBackdropClose footer={footer}>
        <div className="h-64 flex items-center justify-center text-gray-600 text-sm">
          <Loader2 size={18} className="animate-spin mr-2" /> Loading stack data…
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={title}
      onClose={handleClose}
      size="2xl"
      disableBackdropClose
      notification={errorNotif}
      footer={footer}
    >
      <div className="flex flex-col h-[64vh] min-h-0">

        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-gray-700 mb-4 overflow-x-auto shrink-0">
          {staticTabs.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t-md whitespace-nowrap transition-colors
                ${activeTab === id
                  ? "bg-gray-800 text-white border border-b-0 border-gray-700"
                  : "text-gray-500 hover:text-gray-300"
                }`}
            >
              {icon} {label}
            </button>
          ))}

          {serviceNames.map(svcName => (
            <button
              key={svcName}
              onClick={() => setActiveTab(svcName)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t-md whitespace-nowrap transition-colors
                ${activeTab === svcName
                  ? "bg-gray-800 text-white border border-b-0 border-gray-700"
                  : "text-gray-500 hover:text-gray-300"
                }`}
            >
              {svcName}
            </button>
          ))}

          {(busy || actionLog.length > 0) && (
            <button
              onClick={() => setActiveTab("action-log")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t-md whitespace-nowrap transition-colors
                ${activeTab === "action-log"
                  ? "bg-gray-800 text-white border border-b-0 border-gray-700"
                  : "text-gray-500 hover:text-gray-300"
                }`}
            >
              {busy && <Loader2 size={11} className="animate-spin" />}
              {isEdit ? "Deploy Log" : "Install Log"}
            </button>
          )}

          {isEdit && (
            <button
              onClick={() => {
                setActiveTab("install-log");
                if (installLog === null && !installLogBusy) {
                  setInstallLogBusy(true);
                  api.api.compose.stacks({ name: stack!.name })["install-log"].get()
                    .then(({ data }) => {
                      const d = data as { log?: string; error?: string } | null;
                      setInstallLog(d?.log ?? d?.error ?? "(empty)");
                    })
                    .catch(() => setInstallLog("(failed to load)"))
                    .finally(() => setInstallLogBusy(false));
                }
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-t-md whitespace-nowrap transition-colors
                ${activeTab === "install-log"
                  ? "bg-gray-800 text-white border border-b-0 border-gray-700"
                  : "text-gray-500 hover:text-gray-300"
                }`}
            >
              Install Logs
            </button>
          )}
        </div>

        {/* Tab body */}
        <div className="flex-1 min-h-0 overflow-y-auto">

          {/* App Config */}
          {activeTab === "app-config" && (
            <AppConfigTab
              value={appConfig}
              onChange={handleAppConfigChange}
            />
          )}

          {/* Stack Config (name, named networks / volumes) */}
          {activeTab === "stack-config" && (
            <StackConfigTab
              value={stackConfig}
              onChange={setStackConfig}
              isEdit={isEdit}
              onNameChange={name => {
                setStackNameDirty(true);
                setStackConfig(prev => ({ ...prev, name }));
              }}
            />
          )}

          {/* Env File */}
          {activeTab === "env-file" && (
            <div className="flex flex-col h-full">
              <EnvFileTab
                value={envContent}
                onChange={v => { setEnvContent(v); setEnvTouched(true); }}
              />
            </div>
          )}

          {/* YAML editor — kept mounted to preserve edits */}
          <div style={{ display: activeTab === "yaml" ? "flex" : "none" }} className="flex-col h-full">
            <div className="flex-1 rounded-lg overflow-hidden border border-gray-700">
              <Editor
                height="100%"
                defaultLanguage="yaml"
                theme="vs-dark"
                value={yamlContent}
                onChange={val => setYamlContent(val ?? "")}
                loading={
                  <div className="h-full bg-[#1e1e1e] flex items-center justify-center text-gray-600 text-sm">
                    Loading editor…
                  </div>
                }
                options={EDITOR_OPTIONS}
              />
            </div>
          </div>

          {/* Per-service tabs */}
          {serviceNames.map(svcName => (
            <div key={svcName} style={{ display: activeTab === svcName ? "block" : "none" }}>
              {serviceForms[svcName] && (
                <ServiceTab
                  value={serviceForms[svcName]!}
                  onChange={v => setServiceForms(prev => ({ ...prev, [svcName]: v }))}
                />
              )}
            </div>
          ))}

          {/* Action log (live stream — install for create, deploy for edit) */}
          {activeTab === "action-log" && (
            <pre
              ref={logRef}
              className="h-full bg-black rounded-lg border border-gray-700 p-3 text-xs text-green-400 font-mono overflow-y-auto whitespace-pre-wrap"
            >
              {actionLog.length === 0
                ? <span className="text-gray-600">Waiting for output…</span>
                : actionLog.join("\n")
              }
            </pre>
          )}

          {/* Persisted install log — edit mode only */}
          {isEdit && activeTab === "install-log" && (
            <pre className="h-full bg-black rounded-lg border border-gray-700 p-3 text-xs text-green-400 font-mono overflow-y-auto whitespace-pre-wrap">
              {installLogBusy
                ? <span className="text-gray-600">Loading…</span>
                : installLog ?? <span className="text-gray-600">No install log found.</span>
              }
            </pre>
          )}
        </div>
      </div>
    </Dialog>
  );
}
