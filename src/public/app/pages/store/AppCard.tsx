import { useAppStoreStore } from "../../stores/appStoreStore";
import type { StoreApp } from "./types";

export function AppCard({ app }: { app: StoreApp }) {
  const setDetailApp = useAppStoreStore(s => s.setDetailApp);

  return (
    <button
      type="button"
      onClick={() => setDetailApp(app)}
      className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 cursor-pointer transition-colors flex flex-col gap-3 text-left w-full"
    >
      {/* Icon */}
      <div className="flex items-start gap-3">
        {app.icon ? (
          <img
            src={app.icon}
            alt={app.title}
            className="w-14 h-14 rounded-xl object-cover shrink-0 bg-gray-800"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="w-14 h-14 rounded-xl bg-gray-800 flex items-center justify-center shrink-0">
            <span className="text-2xl">📦</span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-100 truncate">{app.title}</p>
          <p className="text-xs text-gray-500 line-clamp-2 mt-0.5 leading-relaxed">{app.tagline}</p>
        </div>
      </div>

      {/* Category badge */}
      {app.category && (
        <span className="self-start text-[10px] font-medium bg-gray-800 text-gray-400 rounded-full px-2 py-0.5 truncate max-w-full">
          {app.category}
        </span>
      )}
    </button>
  );
}
