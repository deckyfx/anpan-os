import { useEffect, useId, useRef, useState } from "react";
import { Loader2, KeyRound, KeySquare, LogOut, CheckCircle2, UserRound, ShieldCheck, Container, type LucideIcon } from "lucide-react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { TopBar } from "./home/TopBar";
import { Pane } from "./account/Pane";
import { Section } from "./account/Section";
import { AvatarEditor } from "./account/AvatarEditor";
import { ApiKeysSection } from "./account/ApiKeysSection";
import { ChangePasswordForm } from "./account/ChangePasswordForm";
import { DockerHubForm } from "./account/DockerHubForm";
import { Avatar } from "../components/Avatar";
import { CARD, LABEL, QUIET_BUTTON, TARGET } from "./account/styles";
import { signOut } from "../lib/sign-out";
import { useRouter } from "../router";
import { useAuthStore } from "../stores/authStore";
import { useStacksStore } from "../stores/stacksStore";
import { useToastStore } from "../stores/toastStore";

/** The Account screen's pages, in sidebar order. Each lives at `/account/<id>`. */
const PAGES = [
  { id: "profile",    label: "Profile",    icon: UserRound },
  { id: "security",   label: "Security",   icon: ShieldCheck },
  { id: "docker-hub", label: "Docker Hub", icon: Container },
  { id: "api-keys",   label: "API keys",   icon: KeySquare },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: LucideIcon }>;

type PageId = (typeof PAGES)[number]["id"];

/** The page a path asks for. Plain `/account`, and anything unknown under it, is Profile. */
function pageFromPath(path: string): PageId {
  const segment = path.split("/")[2] ?? "";
  return PAGES.find(p => p.id === segment)?.id ?? "profile";
}

/** Password, changed in an inline form that opens inside the card. */
function PasswordCard({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const formId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  // When the form closes (saved or cancelled), focus returns to the button that opened it.
  useEffect(() => {
    if (!open && wasOpenRef.current) buttonRef.current?.focus();
    wasOpenRef.current = open;
  }, [open]);

  return (
    <Section title="Password" description="Changing it signs out your other sessions and revokes every API key.">
      {open ? (
        <div id={formId}>
          <ChangePasswordForm onDone={() => setOpen(false)} onChanged={onChanged} />
        </div>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-controls={formId}
          className={QUIET_BUTTON}
        >
          Change password
        </button>
      )}
    </Section>
  );
}

/**
 * Passkey status, and Add passkey when the user has none yet, the browser supports
 * WebAuthn and the server has passkey sign-in enabled.
 */
function PasskeyCard() {
  const hasPasskey      = useAuthStore(s => s.hasPasskey);
  const passkeyEnabled  = useAuthStore(s => s.loginMethods.passkey);
  const registerPasskey = useAuthStore(s => s.registerPasskey);
  const [busy, setBusy] = useState(false);
  const supported = browserSupportsWebAuthn();

  const add = async () => {
    setBusy(true);
    try {
      await registerPasskey("This device");
      useToastStore.getState().push("Passkey added", "success");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      useToastStore.getState().push(`Failed to add passkey: ${message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const status =
    !passkeyEnabled       ? "Passkey sign-in is turned off on this server."
    : hasPasskey === true ? <span className="inline-flex items-center gap-1.5 text-green-400"><CheckCircle2 size={13} aria-hidden="true" /> A passkey is registered.</span>
    : hasPasskey === null ? "Unknown."
    : !supported          ? "No passkey yet. This browser does not support passkeys."
    : "No passkey yet.";

  return (
    <Section title="Passkey" description="Sign in with your fingerprint, face or security key instead of a password.">
      <div className="flex items-center gap-3 flex-wrap">
        <p className="flex-1 min-w-40 text-xs text-gray-400">{status}</p>
        {hasPasskey === false && supported && passkeyEnabled && (
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy}
            className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 hover:bg-amber-500/20 transition-colors disabled:opacity-50 ${TARGET}`}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
            Add passkey
          </button>
        )}
      </div>
    </Section>
  );
}

/**
 * The signed-in user's account, as a sidebar of pages (Profile, Security, Docker Hub and
 * API keys) beside the current page, with Sign out at the foot of the sidebar.
 *
 * Each page has its own URL, so it can be bookmarked and the browser's Back button moves
 * between them. A page stays mounted once visited and is only hidden when another is
 * shown, so typed input and a new API key not yet copied survive switching pages. The
 * page area takes the full width beside the sidebar; on a narrow screen the sidebar
 * becomes a scrolling row above it. Every form is inline: nothing that holds typed input
 * or the one-time API key lives in a dialog that a stray click or Escape could close.
 */
export function AccountPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { path } = useRouter();
  const current  = pageFromPath(path);
  const username  = useAuthStore(s => s.username);
  const avatarUrl = useAuthStore(s => s.avatarUrl);
  const version   = useStacksStore(s => s.version);
  const [signingOut, setSigningOut] = useState(false);
  const [keysGeneration, setKeysGeneration] = useState(0);
  const [visited, setVisited] = useState<ReadonlySet<PageId>>(() => new Set([current]));

  // The top bar's version comes from the stacks store, which only loads it on initialize.
  // FilesPage does the same, so a page opened directly still shows the version.
  useEffect(() => { useStacksStore.getState().initialize(); }, []);

  // Back and Forward change the page without a click, so record visits from the path.
  useEffect(() => {
    setVisited(prev => prev.has(current) ? prev : new Set(prev).add(current));
  }, [current]);

  // On a narrow screen the sidebar is a row that scrolls sideways, and a page opened by URL
  // can sit past its edge; bring the current one into view. A no-op in the tall sidebar.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  const open = (e: React.MouseEvent<HTMLAnchorElement>, id: PageId) => {
    // A modified click (new tab, new window) is left to the browser.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (id !== current) onNavigate(`/account/${id}`);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    if (!await signOut(onNavigate)) setSigningOut(false);
  };

  /** Rendered once first visited, then kept; only the current page is shown. */
  const shown = (id: PageId) => visited.has(id) || id === current;

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      <TopBar version={version} onNavigate={onNavigate} currentPath={path} showUpdates={false} />

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <aside className="shrink-0 md:w-60 flex md:flex-col items-center md:items-stretch gap-2 border-b md:border-b-0 md:border-r border-gray-800 bg-gray-950 px-3 py-2 md:py-4 overflow-x-auto md:overflow-x-visible md:overflow-y-auto">
          <div className="hidden md:flex items-center gap-3 px-2 pb-3 mb-1 border-b border-gray-800/60">
            <Avatar url={avatarUrl} username={username} size={36} alt="" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-white truncate">{username || "—"}</p>
              <p className="text-[11px] text-gray-500">Account</p>
            </div>
          </div>

          <nav ref={navRef} aria-label="Account" className="shrink-0">
            <ul className="flex md:flex-col gap-1">
              {PAGES.map(({ id, label, icon: Icon }) => {
                const active = id === current;
                return (
                  <li key={id}>
                    <a
                      href={`/account/${id}`}
                      onClick={e => open(e, id)}
                      aria-current={active ? "page" : undefined}
                      // Not by colour alone: the current page also gets an accent bar and weight.
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${TARGET} ${
                        active
                          ? "bg-gray-800 text-white font-medium shadow-[inset_0_-2px_0_var(--color-amber-400)] md:shadow-[inset_3px_0_0_var(--color-amber-400)]"
                          : "text-gray-400 hover:text-white hover:bg-gray-800/60"
                      }`}
                    >
                      <Icon size={15} aria-hidden="true" className={active ? "text-amber-400" : "text-gray-500"} />
                      {label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="ml-auto md:ml-0 md:mt-auto md:pt-3 md:border-t md:border-gray-800/60 shrink-0">
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap text-red-300 hover:text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-50 ${TARGET}`}
            >
              {signingOut ? <Loader2 size={15} className="animate-spin" /> : <LogOut size={15} aria-hidden="true" />}
              Sign out
            </button>
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto p-6">
          {shown("profile") && (
            <Pane title="Profile" description="How you appear in anpan-os." hidden={current !== "profile"}>
              <div className={`${CARD} space-y-5`}>
                <AvatarEditor />
                <div>
                  <p className={LABEL}>Username</p>
                  <p className="text-sm text-white font-mono break-all">{username || "—"}</p>
                </div>
              </div>
            </Pane>
          )}

          {shown("security") && (
            <Pane title="Security" description="How you sign in to anpan-os." hidden={current !== "security"}>
              <div className="grid gap-4 items-start grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))]">
                <PasswordCard onChanged={() => setKeysGeneration(g => g + 1)} />
                <PasskeyCard />
              </div>
            </Pane>
          )}

          {shown("docker-hub") && (
            <Pane
              title="Docker Hub"
              description="Signing in raises Docker Hub's pull rate limits and gives access to your private images."
              hidden={current !== "docker-hub"}
            >
              <div className={CARD}>
                <DockerHubForm />
              </div>
            </Pane>
          )}

          {/* Remounted after a password change, which revokes every key on the server: its
              list, any token on screen and any load in flight all belong to the old password. */}
          {shown("api-keys") && <ApiKeysSection key={keysGeneration} hidden={current !== "api-keys"} />}
        </main>
      </div>
    </div>
  );
}
