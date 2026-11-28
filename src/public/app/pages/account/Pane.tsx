import { useId, type ReactNode } from "react";

/**
 * One page of the Account screen: the panel to the right of the sidebar.
 *
 * Its heading is the page's `<h1>`, and the region is labelled by it. The panes stay
 * mounted once visited and only the current one is shown (`hidden` removes the others
 * from view and from the accessibility tree), so a half-typed form or an API key not yet
 * copied survives a visit to another page.
 */
export function Pane({ title, description, actions, hidden, children }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  hidden: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} hidden={hidden} className="space-y-5">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-60">
          <h1 id={headingId} className="text-lg font-semibold text-white">{title}</h1>
          {description && <p className="text-xs text-gray-500 mt-1 leading-relaxed max-w-prose">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
