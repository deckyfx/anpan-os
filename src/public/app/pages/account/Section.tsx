import { useId, type ReactNode } from "react";

/**
 * One card on the Account page: a titled `<section>`, labelled by its heading so screen
 * readers can jump between them, with optional actions at the right of the heading.
 */
export function Section({ title, description, actions, children }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-1 min-w-0">
          <h2 id={headingId} className="text-sm font-semibold text-white">{title}</h2>
          {description && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
