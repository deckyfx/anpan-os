import { useFileStore } from "../../stores/fileStore";

// ─── Upload Progress Dialog ───────────────────────────────────────────────────

export function UploadProgressDialog() {
  const { uploadItems, setUploadItems } = useFileStore();
  if (!uploadItems.length) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-xl shadow-2xl">
        <div className="px-5 py-4 border-b border-gray-800">
          <h2 className="text-base font-semibold text-white">Uploading</h2>
        </div>
        <div className="px-5 py-4 space-y-3 max-h-60 overflow-y-auto">
          {uploadItems.map((item, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span className="truncate mr-2 flex-1">{item.name}</span>
                <span className="shrink-0 font-mono">
                  {item.error ? "❌" : item.done ? "✅" : `${Math.round((item.loaded / Math.max(item.total, 1)) * 100)}%`}
                </span>
              </div>
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all rounded-full ${item.error ? "bg-red-500" : item.done ? "bg-green-500" : "bg-blue-500"}`}
                  style={{ width: `${Math.round((item.loaded / Math.max(item.total, 1)) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        {uploadItems.every(it => it.done) && (
          <div className="px-5 py-3 border-t border-gray-800 flex justify-end">
            <button onClick={() => setUploadItems([])} className="px-4 py-2 rounded-lg text-sm bg-gray-700 hover:bg-gray-600 text-white transition-colors">Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
