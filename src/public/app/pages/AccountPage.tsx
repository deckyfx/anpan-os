import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Lock, KeyRound, LogOut, CheckCircle2 } from "lucide-react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { TopBar } from "./home/TopBar";
import { Section } from "./account/Section";
import { AvatarEditor } from "./account/AvatarEditor";
import { ApiKeysSection } from "./account/ApiKeysSection";
import { ChangePasswordForm } from "./account/ChangePasswordForm";
import { DockerHubForm } from "./account/DockerHubForm";
import { QUIET_BUTTON, TARGET } from "./account/styles";
import { api } from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { useStacksStore } from "../stores/stacksStore";
import { useToastStore } from "../stores/toastStore";

/** A labelled line inside a card, with its control at the right. */
function Row({ icon, label, detail, children }: {
  icon: React.ReactNode;
  label: string;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-gray-500 shrink-0" aria-hidden="true">{icon}</span>
      <div className="flex-1 min-w-40">
        <p className="text-sm text-gray-200">{label}</p>
        {detail && <div className="text-[11px] text-gray-500 mt-0.5">{detail}</div>}
      </div>
      {children && <div className="shrink-0 flex items-center gap-2">{children}</div>}
    </div>
  );
}

/** Password, changed in an inline form that opens under the row. */
function PasswordRow({ onChanged }: { onChanged: () => void }) {
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
    <div className="space-y-3">
      <Row icon={<Lock size={16} />} label="Password" detail="Changing it signs out your other sessions and revokes every API key.">
        {!open && (
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
      </Row>
      {open && (
        <div id={formId} className="pl-7">
          <ChangePasswordForm onDone={() => setOpen(false)} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

/**
 * Passkey status, and Add passkey when the user has none yet, the browser supports
 * WebAuthn and the server has passkey sign-in enabled.
 */
function PasskeyRow() {
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

  const detail =
    !passkeyEnabled       ? "Passkey sign-in is turned off on this server."
    : hasPasskey === true ? <span className="inline-flex items-center gap-1 text-green-400"><CheckCircle2 size={11} aria-hidden="true" /> A passkey is registered.</span>
    : hasPasskey === null ? "Unknown."
    : !supported          ? "No passkey yet. This browser does not support passkeys."
    : "No passkey yet. Sign in with your fingerprint, face or security key instead of a password.";

  return (
    <Row icon={<KeyRound size={16} />} label="Passkey" detail={detail}>
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
    </Row>
  );
}

/**
 * The signed-in user's account: profile and avatar, password and passkey, Docker Hub,
 * API keys, and sign out.
 *
 * These used to sit at the bottom of the main menu; they are reached now through the
 * user button in the top bar. The cards share the page's full width in a responsive grid,
 * and every form is inline: nothing that holds typed input or the one-time API key lives
 * in a dialog that a stray click or Escape could close.
 */
export function AccountPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const username = useAuthStore(s => s.username);
  const version  = useStacksStore(s => s.version);
  const [signingOut, setSigningOut] = useState(false);
  const [keysGeneration, setKeysGeneration] = useState(0);

  // The top bar's version comes from the stacks store, which only loads it on initialize.
  // FilesPage does the same, so a page opened directly still shows the version.
  useEffect(() => { useStacksStore.getState().initialize(); }, []);

  const signOut = async () => {
    setSigningOut(true);
    // Signed out only once the server says so. Clearing the page on a failed request would
    // look signed out while the session stays valid, and a reload would sign straight back in.
    try {
      const { error } = await api.api.auth.logout.post();
      if (error) throw new Error((error.value as { error?: string })?.error ?? `HTTP ${error.status}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      useToastStore.getState().push(`Sign out failed: ${message}. You are still signed in.`, "error");
      setSigningOut(false);
      return;
    }
    // Back to "/" first, so signing in again lands on the dashboard, not this page.
    onNavigate("/");
    useAuthStore.getState().logout();
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      <TopBar version={version} onNavigate={onNavigate} currentPath="/account" showUpdates={false} />

      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[100rem] mx-auto space-y-5">
          <h1 className="text-lg font-semibold text-white">Account</h1>

          <div className="grid gap-4 items-start grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))]">
            <Section title="Profile">
              <div className="space-y-4">
                <AvatarEditor />
                <div>
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-1">Username</p>
                  <p className="text-sm text-white font-mono break-all">{username || "—"}</p>
                </div>
              </div>
            </Section>

            <Section title="Security">
              <div className="space-y-4">
                <PasswordRow onChanged={() => setKeysGeneration(g => g + 1)} />
                <div className="border-t border-gray-800/60" />
                <PasskeyRow />
              </div>
            </Section>

            <Section
              title="Docker Hub"
              description="Signing in raises Docker Hub's pull rate limits and gives access to your private images."
            >
              <DockerHubForm />
            </Section>

            <div className="col-span-full">
              {/* Remounted after a password change, which revokes every key on the server:
                  its list, any token on screen and any load in flight all belong to the old
                  password. */}
              <ApiKeysSection key={keysGeneration} />
            </div>
          </div>

          <div className="pb-2">
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={signingOut}
              className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm text-red-300 bg-red-500/10 border border-red-500/25 hover:bg-red-500/20 transition-colors disabled:opacity-50 ${TARGET}`}
            >
              {signingOut ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
              Sign out
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
