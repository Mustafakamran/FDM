import { Check, AlertCircle, Info, X } from "lucide-react";
import { useToasts, type ToastType } from "../store/toast";

const icon: Record<ToastType, React.ReactNode> = {
  success: <Check size={16} />,
  error: <AlertCircle size={16} />,
  info: <Info size={16} />,
};

const color: Record<ToastType, string> = {
  success: "var(--success)",
  error: "var(--error)",
  info: "var(--accent)",
};

export function ToastHost() {
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${t.leaving ? "animate-toast-out" : "animate-rise"} pointer-events-auto flex items-center gap-2.5 rounded-[9px] border border-[var(--border-strong)] bg-[var(--card)] py-2.5 pl-3 pr-2.5 text-sm text-[var(--text)] shadow-[var(--shadow-lg)]`}
          style={{ minWidth: 240, maxWidth: 360 }}
        >
          <span style={{ color: color[t.type] }} className="shrink-0">
            {icon[t.type]}
          </span>
          <span className="flex-1">{t.message}</span>
          <button
            className="shrink-0 text-[var(--text-3)] hover:text-[var(--text)]"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
