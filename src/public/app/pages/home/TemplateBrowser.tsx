import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../../lib/api";

interface TemplateSummary {
  id:          string;
  name:        string;
  icon:        string;
  tagline:     string;
  category:    string;
  defaultPort: string;
  scheme:      string;
}

export function TemplateBrowser({ onSelect }: {
  onSelect: (yaml: string, templateName: string, defaultPort: string) => void;
}) {
  const [templates,  setTemplates]  = useState<TemplateSummary[] | null>(null);
  const [loadingId,  setLoadingId]  = useState<string | null>(null);
  const [fetchError, setFetchError] = useState("");

  // Load template list on first render
  useEffect(() => {
    void (async () => {
      try {
        const { data, error } = await api.api.compose.templates.get();
        if (error) {
          setFetchError((error.value as { error?: string })?.error ?? "Failed to load templates");
          return;
        }
        setTemplates(data as TemplateSummary[]);
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : "Failed to load templates");
      }
    })();
  }, []);

  const handleSelect = async (tpl: TemplateSummary) => {
    setLoadingId(tpl.id);
    try {
      const { data, error } = await api.api.compose.templates({ id: tpl.id }).get();
      if (error) return;
      const full = data as { composeYaml?: string; defaultPort?: string } | null;
      if (full?.composeYaml) {
        onSelect(full.composeYaml, tpl.name, tpl.defaultPort);
      }
    } finally {
      setLoadingId(null);
    }
  };

  if (fetchError) {
    return (
      <div className="flex items-center justify-center h-64 text-red-400 text-sm">{fetchError}</div>
    );
  }

  if (!templates) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-600 text-sm gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading templates…
      </div>
    );
  }

  const byCategory = templates.reduce<Record<string, TemplateSummary[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  return (
    <div className="space-y-4 max-h-[360px] overflow-y-auto pr-1">
      {Object.entries(byCategory).map(([category, items]) => (
        <div key={category}>
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">{category}</p>
          <div className="grid grid-cols-2 gap-2">
            {items.map(tpl => (
              <button
                key={tpl.id}
                onClick={() => void handleSelect(tpl)}
                disabled={loadingId !== null}
                className="relative flex items-start gap-3 p-3 rounded-xl bg-gray-800 border border-gray-700 hover:border-amber-500/50 hover:bg-gray-700/50 transition-all text-left disabled:opacity-60"
              >
                {loadingId === tpl.id && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-gray-800/80">
                    <Loader2 size={16} className="animate-spin text-amber-400" />
                  </div>
                )}
                <img
                  src={tpl.icon}
                  alt={tpl.name}
                  className="w-8 h-8 rounded-lg object-contain bg-gray-900 shrink-0 p-0.5"
                  onError={(e) => {
                    const el = e.target as HTMLImageElement;
                    el.style.display = "none";
                    const sibling = el.nextElementSibling as HTMLElement | null;
                    if (sibling) {
                      sibling.classList.remove("hidden");
                      sibling.classList.add("flex");
                    }
                  }}
                />
                <span className="hidden w-8 h-8 rounded-lg bg-gray-700 border border-gray-600 items-center justify-center text-sm font-bold text-gray-300 shrink-0">
                  {tpl.name.charAt(0)}
                </span>
                <div className="min-w-0">
                  <p className="text-sm text-gray-100 font-medium truncate">{tpl.name}</p>
                  <p className="text-[10px] text-gray-500 truncate mt-0.5">{tpl.tagline}</p>
                  <p className="text-[9px] text-gray-600 mt-0.5">:{tpl.defaultPort}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
