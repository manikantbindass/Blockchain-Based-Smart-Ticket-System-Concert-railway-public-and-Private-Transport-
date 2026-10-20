import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, Smartphone } from "lucide-react";
import type { AuthProviders, Session } from "@chainpass/shared";
import type {
  Auth,
  ConfirmationResult,
  RecaptchaVerifier,
  User,
} from "firebase/auth";
import { api, ApiError, errorMessage } from "./api";
import { ErrorNotice, Spinner } from "./components";
import "./providers.css";

type FirebaseSdk = typeof import("firebase/auth");
let firebaseClient: Promise<{ sdk: FirebaseSdk; auth: Auth }> | undefined;

function client(config: NonNullable<AuthProviders["firebase"]>) {
  firebaseClient ??= Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
  ])
    .then(([apps, sdk]) => {
      const app =
        apps.getApps().find((item) => item.name === "chainpass-auth") ??
        apps.initializeApp(config, "chainpass-auth");
      const auth = sdk.initializeAuth(app, {
        persistence: sdk.inMemoryPersistence,
        popupRedirectResolver: sdk.browserPopupRedirectResolver,
      });
      auth.languageCode = "en";
      return { sdk, auth };
    })
    .catch((error: unknown) => {
      firebaseClient = undefined;
      throw error;
    });
  return firebaseClient;
}

function authError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const messages: Record<string, string> = {
    "auth/popup-closed-by-user":
      "Sign-in was closed. You can try again whenever you’re ready.",
    "auth/popup-blocked":
      "Your browser blocked the Google window. Allow pop-ups for ChainPass and try again.",
    "auth/cancelled-popup-request":
      "Another sign-in window was opened. Please try again.",
    "auth/unauthorized-domain":
      "Sign-in is not enabled for this website address yet. Contact the site operator.",
    "auth/operation-not-allowed":
      "This sign-in method is not enabled yet. Please use email sign-in.",
    "auth/invalid-phone-number":
      "Enter a mobile number with its country code, such as +91 98765 43210.",
    "auth/invalid-verification-code":
      "That code doesn’t match. Check the SMS and try again.",
    "auth/code-expired": "This code has expired. Request a new SMS code.",
    "auth/session-expired": "This code has expired. Request a new SMS code.",
    "auth/too-many-requests":
      "Too many attempts. Please wait a little before trying again.",
    "auth/quota-exceeded":
      "SMS sign-in is temporarily unavailable. Please use another sign-in method.",
    "auth/captcha-check-failed":
      "The security check expired. Please complete it again.",
    "auth/network-request-failed":
      "Unable to reach Google. Check your connection and try again.",
    "auth/account-exists-with-different-credential":
      "This email already has another sign-in method. Sign in with that method first, then link Google in Manage sign-in methods.",
  };
  return (
    messages[code] ??
    (code
      ? "Sign-in could not be completed. Please try again or use email."
      : errorMessage(error))
  );
}

export function ProviderAuth({
  session,
  disabled,
  onSuccess,
  onBusyChange,
  onExternalDialogChange,
}: {
  session?: Session | null;
  disabled: boolean;
  onSuccess: (session: Session) => void;
  onBusyChange: (busy: boolean) => void;
  onExternalDialogChange: (open: boolean) => void;
}) {
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phone, setPhone] = useState("+91 ");
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(
    null,
  );
  const [busy, setBusy] = useState<"google" | "sms" | "verify" | null>(null);
  const [error, setError] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const captchaContainer = useRef<HTMLDivElement>(null);
  const verifier = useRef<RecaptchaVerifier | null>(null);
  const active = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const sdkRef = useRef<{ sdk: FirebaseSdk; auth: Auth } | null>(null);
  const onBusyRef = useRef(onBusyChange);
  const externalRef = useRef(onExternalDialogChange);
  onBusyRef.current = onBusyChange;
  externalRef.current = onExternalDialogChange;

  useEffect(() => {
    active.current = true;
    const request = new AbortController();
    controller.current = request;
    void api<AuthProviders>("/auth/providers", { signal: request.signal })
      .then(async (value) => {
        if (!active.current || request.signal.aborted) return;
        setProviders(value);
        if (value.firebase && (value.google || value.phone)) {
          const initialized = await client(value.firebase);
          if (!active.current || request.signal.aborted) return;
          sdkRef.current = initialized;
          setReady(true);
        }
      })
      .catch((err: unknown) => {
        if (!request.signal.aborted) setError(authError(err));
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
    return () => {
      active.current = false;
      request.abort();
      verifier.current?.clear();
      verifier.current = null;
      const initialized = sdkRef.current;
      if (initialized) void initialized.sdk.signOut(initialized.auth);
      onBusyRef.current(false);
      externalRef.current(false);
    };
  }, []);
  useEffect(() => {
    if (!sentAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sentAt]);

  function markBusy(value: typeof busy) {
    setBusy(value);
    onBusyChange(value !== null);
  }
  async function exchange(user: User) {
    const idToken = await user.getIdToken(true);
    if (!active.current) return;
    const result = await api<Session | { user: Session["user"] }>(
      session ? "/auth/firebase/link" : "/auth/firebase",
      {
        method: "POST",
        token: session?.token,
        body: { idToken, ...(session ? { password } : {}) },
        signal: controller.current?.signal,
      },
    );
    const initialized = sdkRef.current;
    if (initialized) await initialized.sdk.signOut(initialized.auth);
    if (active.current)
      onSuccess(
        session ? { ...session, user: result.user } : (result as Session),
      );
  }
  async function google() {
    const initialized = sdkRef.current;
    if (!initialized || busy || disabled) return;
    markBusy("google");
    setError("");
    try {
      const provider = new initialized.sdk.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const result = await initialized.sdk.signInWithPopup(
        initialized.auth,
        provider,
      );
      if (active.current) await exchange(result.user);
    } catch (err) {
      if (active.current) setError(authError(err));
    } finally {
      void initialized.sdk.signOut(initialized.auth);
      if (active.current) markBusy(null);
    }
  }
  async function sendCode(event: FormEvent) {
    event.preventDefault();
    const initialized = sdkRef.current;
    if (!initialized || !captchaContainer.current || busy || disabled) return;
    const normalized = phone.replace(/[\s()-]/g, "");
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
      setError(
        "Enter your mobile number with its country code, such as +91 98765 43210.",
      );
      return;
    }
    if (!consent) return;
    markBusy("sms");
    setError("");
    onExternalDialogChange(true);
    try {
      verifier.current?.clear();
      verifier.current = new initialized.sdk.RecaptchaVerifier(
        initialized.auth,
        captchaContainer.current,
        {
          size: "normal",
          "expired-callback": () => {
            if (active.current)
              setError(
                "The security check expired. Please try sending the code again.",
              );
          },
        },
      );
      const result = await initialized.sdk.signInWithPhoneNumber(
        initialized.auth,
        normalized,
        verifier.current,
      );
      if (!active.current) return;
      setConfirmation(result);
      setPhone(normalized);
      setCode("");
      setSentAt(Date.now());
      setNow(Date.now());
    } catch (err) {
      if (active.current) setError(authError(err));
    } finally {
      verifier.current?.clear();
      verifier.current = null;
      onExternalDialogChange(false);
      if (active.current) markBusy(null);
    }
  }
  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (!confirmation || busy || disabled) return;
    markBusy("verify");
    setError("");
    try {
      const result = await confirmation.confirm(code);
      if (active.current) await exchange(result.user);
    } catch (err) {
      if (active.current) setError(authError(err));
    } finally {
      const initialized = sdkRef.current;
      if (initialized) void initialized.sdk.signOut(initialized.auth);
      if (active.current) markBusy(null);
    }
  }
  const blocked =
    disabled || busy !== null || !ready || (!!session && !password);
  const resendSeconds = Math.max(0, 60 - Math.floor((now - sentAt) / 1000));
  return (
    <section
      className="provider-auth"
      aria-label={session ? "Link sign-in methods" : "More ways to sign in"}
    >
      {session && (
        <div className="form-stack provider-link-password">
          <label>
            Current ChainPass password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              maxLength={128}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Verify your existing email account"
              disabled={disabled || !!busy}
            />
          </label>
        </div>
      )}
      <div className="provider-buttons">
        <button
          className="button provider-button"
          type="button"
          disabled={blocked || !providers?.google}
          onClick={() => void google()}
        >
          {busy === "google" ? (
            <Spinner label="Opening Google…" />
          ) : (
            <>
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
              >
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.73-.06-1.42-.19-2.09H12v3.96h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.56c2.08-1.92 3.28-4.74 3.28-7.96Z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.67l-3.56-2.77c-.99.66-2.25 1.06-3.72 1.06-2.87 0-5.3-1.94-6.17-4.54H2.15v2.84A11 11 0 0 0 12 23Z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.83 14.08A6.6 6.6 0 0 1 5.48 12c0-.72.12-1.42.35-2.08V7.08H2.15A11 11 0 0 0 1 12c0 1.78.43 3.45 1.15 4.92l3.68-2.84Z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.07.56 4.21 1.64l3.16-3.16A10.57 10.57 0 0 0 12 1a11 11 0 0 0-9.85 6.08l3.68 2.84C6.7 7.32 9.13 5.38 12 5.38Z"
                />
              </svg>
              {session ? "Link Google" : "Continue with Google"}
            </>
          )}
        </button>
        <button
          className="button provider-button"
          type="button"
          disabled={blocked || !providers?.phone}
          aria-expanded={phoneOpen}
          onClick={() => {
            setPhoneOpen(!phoneOpen);
            setError("");
          }}
        >
          <Smartphone size={18} />{" "}
          {session ? "Link mobile number" : "Continue with mobile"}
        </button>
      </div>
      {loading && (
        <p className="provider-note" role="status">
          Checking sign-in options…
        </p>
      )}
      {!loading &&
        (!providers?.firebase || (!providers.google && !providers.phone)) && (
          <p className="provider-note">
            Google and mobile sign-in will be available after Firebase is
            configured.{" "}
            {session
              ? "Your current sign-in method is ready to use."
              : "You can sign in with email below."}
          </p>
        )}
      {!loading &&
        providers?.firebase &&
        (!providers.google || !providers.phone) && (
          <p className="provider-note">
            The unavailable sign-in method has not been enabled by this site.
          </p>
        )}
      {session && (
        <p className="provider-note">
          Connect your existing email/password account to Google or a mobile
          number. Confirm your password first. Google must use the same email
          address. Your tickets stay with this account.
        </p>
      )}
      {phoneOpen && (
        <div className="phone-signin">
          {confirmation ? (
            <form
              className="form-stack"
              onSubmit={(event) => void verifyCode(event)}
            >
              <p className="phone-status">
                <Check size={15} /> SMS sent to {phone}. Enter the 6-digit code.
              </p>
              <label>
                SMS verification code
                <input
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, ""))
                  }
                  placeholder="6-digit code"
                  disabled={!!busy || disabled}
                />
              </label>
              <button
                className="button primary full-width"
                disabled={!!busy || disabled || code.length !== 6}
              >
                {busy === "verify" ? (
                  <Spinner label="Verifying…" />
                ) : (
                  <>
                    {session ? "Verify and link number" : "Verify and sign in"}
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!!busy || disabled || resendSeconds > 0}
                onClick={() => {
                  setConfirmation(null);
                  setCode("");
                  setError("");
                }}
              >
                {resendSeconds > 0
                  ? `Request another code in ${resendSeconds}s`
                  : "Change number or request another code"}
              </button>
            </form>
          ) : (
            <form
              className="form-stack"
              onSubmit={(event) => void sendCode(event)}
            >
              <label>
                Mobile number
                <input
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  required
                  maxLength={24}
                  placeholder="+91 98765 43210"
                  onChange={(event) => setPhone(event.target.value)}
                  disabled={!!busy || disabled}
                />
              </label>
              <label className="provider-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                  required
                  disabled={!!busy || disabled}
                />
                <span>
                  I agree to receive a verification SMS. My number will be sent
                  to Google for authentication and abuse prevention. SMS rates
                  may apply.
                </span>
              </label>
              <button
                className="button primary full-width"
                disabled={!!busy || disabled || !consent}
              >
                {busy === "sms" ? (
                  <Spinner label="Complete the security check…" />
                ) : (
                  <>
                    Send verification code
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </form>
          )}
          <div className="recaptcha-container" ref={captchaContainer} />
          <p className="provider-note">
            Mobile sign-in verifies your phone. Railway identity verification
            remains a separate sandbox step.
          </p>
          {["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && (
            <p className="provider-note">
              Real SMS sign-in requires an authorized HTTPS domain. This local
              preview can use Firebase’s configured test phone numbers.
            </p>
          )}
        </div>
      )}
      {error && <ErrorNotice message={error} />}
    </section>
  );
}
