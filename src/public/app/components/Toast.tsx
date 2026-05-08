import { CheckCircle, XCircle, Info } from "lucide-react";
import { useToastStore, type ToastType } from "../stores/toastStore";

const STYLES: Record<ToastType, string> = {
  success: "bg-green-950 border-green-700 text-green-300",
  error:   "bg-red-950   border-red-700   text-red-300",
  info:    "bg-gray-800  border-gray-700  text-gray-200",
};

const ICON: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle size={15} className="shrink-0" />,
  error:   <XCircle    size={15} className="shrink-0" />,
  info:    <Info       size={15} className="shrink-0" />,
};

export function ToastContainer() {
  const { toasts, dismiss } = useToastStore();

  return (
    <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-2xl border text-sm font-medium max-w-xs ${STYLES[t.type]}`}
        >
          {ICON[t.type]}
          <span className="flex-1">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="ml-1 opacity-60 hover:opacity-100 leading-none text-base"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
