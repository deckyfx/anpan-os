import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { FileCode, FileText, Loader2, Wand2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";
import { useJobsStore, runningJobFor, readStartAnswer, type JobSummary } from "../../stores/jobsStore";
import type { InstallMeta } from "../../stores/appStoreStore";
import { JobView } from "../../components/JobView";
import type { Stack } from "./types";
import { AppConfigTab }   from "./guided/AppConfigTab";
import { EnvFileTab }     from "./guided/EnvFileTab";
import { ServiceTab }     from "./guided/ServiceTab";
import { StackConfigTab } from "./guided/StackConfigTab";
import { parseComposeDoc, parseService, parseStackConfig } from "./guided/composeUtils";
import { applyFormChanges, type FormSnapshot } from "./guided/composePatch";
import type { AppConfigState, OpenMode, ServiceForm, StackConfig } from "./guided/types";

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

function initForms(yaml: string, projectName = ""): FormSnapshot {
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

/**
 * Build the initial AppConfigState: from an existing stack's metadata, from an App Store
 * app's x-casaos metadata, or defaults for a new stack.
 */
function initAppConfig(stack: Stack | null, initial?: InstallMeta): AppConfigState {
  const m = stack?.meta ?? initial;
  return {
    title:     m?.title     ?? "",
    tagline:   m?.tagline   ?? "",
    icon:      m?.icon      ?? "",
    scheme:    m?.scheme    ?? "http",
    portMap:   m?.portMap   ?? "",
    indexPath: m?.indexPath ?? "/",
    address:   stack?.meta?.address ?? "",
    note:      m?.note      ?? "",
    openMode:  (stack?.meta?.openMode as OpenMode | undefined) ?? "new-page",
  };
}

type TabId = "app-config" | "stack-config" | "env-file" | "yaml" | "action-log" | "install-log" | string;

// ─── Outer wrapper ────────────────────────────────────────────────────────────

/**
 * Outer guard — returns null when closed or in edit mode without a stack.
 * Forces a full remount via `key` when the target changes so all draft
 * state is reset cleanly between different stacks or App Store installs.
 */
export function GuidedStackDialog({ mode, stack, open, onClose, onDone, initialContent, initialMeta, initialAppId }: {
  mode:             "create" | "edit";
  stack?:           Stack | null;
  open:             boolean;
  onClose:          () => void;
  onDone:           () => void;
  /** Pre-fill the YAML editor with this content when creating a new stack (e.g. from App Store). */
  initialContent?:  string;
  /** Pre-fill App Config with this metadata when creating (from the App Store's x-casaos). */
  initialMeta?:     InstallMeta;
  /** Unique key for the app being installed; forces remount between different App Store installs. */
  initialAppId?:    string;
}) {
  if (!open) return null;
  if (mode === "edit" && !stack) return null;
  return (
    <GuidedStackDialogInner
      key={mode === "edit" ? stack!.name : (initialAppId ?? "new")}
      mode={mode}
      stack={stack ?? null}
      onClose={onClose}
      onDone={onDone}
      initialContent={initialContent}
      initialMeta={initialMeta}
    />
  );
}

// ─── Inner component ──────────────────────────────────────────────────────────

function GuidedStackDialogInner({ mode, stack, onClose, onDone, initialContent, initialMeta }: {
  mode:             "create" | "edit";
  stack:            Stack | null;
  onClose:          () => void;
  onDone:           () => void;
  initialContent?:  string;
  initialMeta?:     InstallMeta;
}) {
  const isEdit     = mode === "edit";
  const startYaml  = isEdit ? "" : (initialContent ?? DEFAULT_YAML);
  const init       = isEdit ? initForms("", stack?.name ?? "") : initForms(startYaml);

  const [loading,              setLoading]              = useState(isEdit);
  const [yamlContent,          setYamlContent]          = useState(startYaml);
  const [envContent,           setEnvContent]           = useState("");
  const [envTouched,           setEnvTouched]           = useState(false);
  const [serviceNames,         setServiceNames]         = useState<string[]>(init.serviceNames);
  const [serviceForms,         setServiceForms]         = useState<Record<string, ServiceForm>>(init.serviceForms);
  const [stackConfig,          setStackConfig]          = useState<StackConfig>(init.stackConfig);
  const [stackNameDirty,       setStackNameDirty]       = useState(false);
  const [appConfig,            setAppConfig]            = useState<AppConfigState>(() => initAppConfig(stack, initialMeta));
  const [activeTab,            setActiveTab]            = useState<TabId>("app-config");
  const [parseErrors,          setParseErrors]          = useState<string[]>([]);
  // `starting`: a request is on its way. The work itself is a server job, `jobId`, which
  // carries on if this dialog closes; reopening the stack's editor shows it again.
  const [starting,             setStarting]             = useState(false);
  const [jobId,                setJobId]                = useState<string | null>(
    () => (stack ? runningJobFor(useJobsStore.getState().jobs, stack.name)?.id ?? null : null),
  );
  const [installLog,           setInstallLog]           = useState<string | null>(null);
  const [installLogBusy,       setInstallLogBusy]       = useState(false);
  const [error,                setError]                = useState("");
  // Track whether anything beyond App Config has been modified (yaml, services, env, stack config)
  const [nonAppConfigTouched,  setNonAppConfigTouched]  = useState(false);

  const jobRunning = useJobsStore(s => (jobId ? s.jobs[jobId]?.status === "running" : false));

  // Reopened while this stack's job still runs: show its log first.
  useEffect(() => {
    if (jobId) setActiveTab("action-log");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const busy = starting || jobRunning;
  // The forms as last read from (or written to) the YAML. Writing back diffs
  // the current forms against this, so only fields the user changed are
  // touched and everything else in the file is left as it is.
  const formsBaseRef = useRef<FormSnapshot>(init);

  // Closing is always allowed: an install or deploy runs on the server and continues.
  const handleClose = useCallback(() => { if (!starting) onClose(); }, [starting, onClose]);

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
          // On a parse error this is the same empty state the dialog started with
          const loaded = initForms(yaml, stack?.name ?? "");
          setServiceNames(loaded.serviceNames);
          setServiceForms(loaded.serviceForms);
          setStackConfig(loaded.stackConfig);
          formsBaseRef.current = loaded;
        } catch { /* ignore parse errors on load */ }

        const envRes  = await api.api.compose.stacks({ name: stack.name }).envfile.get();
        const envData = envRes.data as { content?: string } | null;
        if (envData?.content !== undefined) setEnvContent(envData.content);

        // Reset dirty flag — nothing has changed yet
        setNonAppConfigTouched(false);
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
      const doc    = parseComposeDoc(yamlContent);
      const names  = Object.keys(doc.services ?? {});
      const parsed: FormSnapshot = {
        serviceNames: names,
        serviceForms: Object.fromEntries(names.map(n => [n, parseService(doc.services[n])])),
        stackConfig:  parseStackConfig(doc),
      };
      setServiceNames(parsed.serviceNames);
      setServiceForms(parsed.serviceForms);
      setStackConfig(parsed.stackConfig);
      formsBaseRef.current = parsed;
      setParseErrors([]);
      if (isEdit) setNonAppConfigTouched(true);
      if (names[0]) setActiveTab(names[0]);
    } catch (e) {
      setParseErrors([e instanceof Error ? e.message : "Invalid YAML"]);
    }
  };

  /**
   * Patch the current form edits into the YAML text in place and make the
   * result the new base. Throws when the YAML does not parse.
   */
  const writeFormsToYaml = (): string => {
    const now: FormSnapshot = { serviceNames, serviceForms, stackConfig };
    const yaml = applyFormChanges(yamlContent, formsBaseRef.current, now);
    formsBaseRef.current = now;
    setYamlContent(yaml);
    return yaml;
  };

  const handleFormsToYaml = () => {
    try {
      writeFormsToYaml();
      setActiveTab("yaml");
    } catch (e) {
      setParseErrors([e instanceof Error ? e.message : "Failed to apply forms to YAML"]);
    }
  };

  // Sync forms → YAML and return the result
  const syncYaml = (): string => {
    if (serviceNames.length === 0) return yamlContent;
    try {
      return writeFormsToYaml();
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

  /** The tile metadata, sent with the install or deploy so it is saved before the first start. */
  const appMeta = () => ({
    title:     appConfig.title     || undefined,
    tagline:   appConfig.tagline   || undefined,
    icon:      appConfig.icon      || undefined,
    scheme:    appConfig.scheme    || undefined,
    portMap:   appConfig.portMap   || undefined,
    indexPath: appConfig.indexPath || undefined,
    address:   appConfig.address   || undefined,
    note:      appConfig.note      || undefined,
    openMode:  appConfig.openMode  || undefined,
  });

  /** Show a started job, or the job already working on this stack, or the refusal. */
  const takeAnswer = (data: unknown, err: unknown) => {
    const answer = readStartAnswer(data, err);
    if (answer.job) {
      setJobId(answer.job.id);
      setActiveTab("action-log");
    }
    if (answer.error) setError(answer.error);
  };

  /** A job ended: on success the dialog is done; on failure it stays open with the log. */
  const onJobFinished = (job: JobSummary) => {
    if (job.status !== "done") return;
    useToastStore.getState().push(isEdit ? "Stack updated and deployed" : "Stack installed", "success");
    onDone();
    onClose();
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

    setStarting(true);
    try {
      // One request: the server writes the compose file, .env and tile settings, then deploys.
      const { data, error: err } = await api.api.compose.stacks.post({
        name,
        content: yaml,
        env:     envContent.trim() ? envContent : undefined,
        meta:    appMeta(),
      });
      takeAnswer(data, err);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  // ── Save-only action (edit mode, only App Config changed) ────────────────

  const handleSaveOnly = async () => {
    setError("");
    setStarting(true);
    try {
      await api.api.docker.stacks({ name: stack!.name }).patch(appMeta());
      useToastStore.getState().push("Settings saved", "success");
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  // ── Deploy action (edit mode) ─────────────────────────────────────────────

  const handleDeploy = async () => {
    if (!yamlContent.trim()) { setError("Compose content cannot be empty."); return; }
    setError("");
    setParseErrors([]);

    const yaml = syncYaml();
    setStarting(true);
    try {
      const { data, error: err } = await api.api.compose.stacks({ name: stack!.name }).file.put({
        content: yaml,
        // Omitted keeps the stack's current .env on the server.
        env:     envTouched ? envContent : undefined,
        meta:    appMeta(),
      });
      takeAnswer(data, err);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
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
        onClick={() => void (isEdit
          ? (nonAppConfigTouched ? handleDeploy() : handleSaveOnly())
          : handleCreate()
        )}
        disabled={busy || loading || (!isEdit && !stackConfig.name)}
        className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
      >
        {busy
          ? <><Loader2 size={13} className="inline animate-spin mr-1" />{isEdit ? (nonAppConfigTouched ? "Deploying…" : "Saving…") : "Installing…"}</>
          : isEdit ? (nonAppConfigTouched ? "Save & Deploy" : "Save") : "Install"
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

          {(starting || jobId) && (
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
              onChange={v => { setStackConfig(v); if (isEdit) setNonAppConfigTouched(true); }}
              isEdit={isEdit}
              onNameChange={name => {
                setStackNameDirty(true);
                setStackConfig(prev => ({ ...prev, name }));
                if (isEdit) setNonAppConfigTouched(true);
              }}
            />
          )}

          {/* Env File */}
          {activeTab === "env-file" && (
            <div className="flex flex-col h-full">
              <EnvFileTab
                value={envContent}
                onChange={v => { setEnvContent(v); setEnvTouched(true); if (isEdit) setNonAppConfigTouched(true); }}
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
                onChange={val => { setYamlContent(val ?? ""); if (isEdit) setNonAppConfigTouched(true); }}
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
                  onChange={v => { setServiceForms(prev => ({ ...prev, [svcName]: v })); if (isEdit) setNonAppConfigTouched(true); }}
                />
              )}
            </div>
          ))}

          {/* The install or deploy job: install for create, deploy for edit */}
          {activeTab === "action-log" && (
            jobId
              ? <JobView jobId={jobId} logHeight="h-[50vh]" onFinished={onJobFinished} />
              : <p className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" /> Starting…</p>
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
