import { useSystemStore } from "../stores/systemStore";

interface Props {
  /** Content shown only when the process is running as root. */
  children: React.ReactNode;
  /**
   * Content shown when NOT elevated.
   * If omitted the guard renders nothing for unprivileged users.
   */
  fallback?: React.ReactNode;
  /**
   * When true, renders children as disabled/greyed-out instead of hiding them,
   * and shows `fallback` as an overlay tooltip/label.
   * Useful for buttons that should be visible but blocked.
   */
  overlay?: boolean;
}

/**
 * Renders `children` only when the server process is running as root (uid 0).
 * Renders `fallback` (or nothing) otherwise.
 *
 * Usage:
 *   <PrivilegeGuard>
 *     <DangerousAdminButton />
 *   </PrivilegeGuard>
 *
 *   <PrivilegeGuard fallback={<p>Root required</p>}>
 *     <AdminPanel />
 *   </PrivilegeGuard>
 *
 *   <PrivilegeGuard overlay fallback="Requires root">
 *     <button>Edit Samba config</button>
 *   </PrivilegeGuard>
 */
export function PrivilegeGuard({ children, fallback, overlay }: Props) {
  const { isRoot, loaded } = useSystemStore();

  if (!loaded) return null;

  if (isRoot) return <>{children}</>;

  if (overlay) {
    return (
      <div className="relative group">
        <div className="pointer-events-none opacity-30 select-none">
          {children}
        </div>
        {fallback && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] font-semibold text-amber-500 bg-gray-950/80 px-2 py-0.5 rounded-full border border-amber-500/30">
              {fallback}
            </span>
          </div>
        )}
      </div>
    );
  }

  return <>{fallback ?? null}</>;
}
