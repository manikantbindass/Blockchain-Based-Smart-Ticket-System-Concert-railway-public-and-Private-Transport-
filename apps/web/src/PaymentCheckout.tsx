import { useEffect, useRef, useState } from "react";
import { ArrowRight, CreditCard, ShieldCheck, Smartphone } from "lucide-react";
import type {
  Booking,
  PaymentConfig,
  PaymentOrder,
  Session,
} from "@chainpass/shared";
import { api, errorMessage } from "./api";
import { ErrorNotice, Spinner } from "./components";
import "./providers.css";

type PaymentResult = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};
type Checkout = {
  open(): void;
  close(): void;
  on(event: "payment.failed", callback: () => void): void;
};
type CheckoutOptions = {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description: string;
  prefill: { name: string; email?: string; contact?: string };
  theme: { color: string };
  modal: { ondismiss: () => void };
  handler: (result: PaymentResult) => void;
};
declare global {
  interface Window {
    Razorpay?: new (options: CheckoutOptions) => Checkout;
  }
}
let checkoutScript: Promise<void> | undefined;
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  checkoutScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    const timer = window.setTimeout(() => fail(), 20_000);
    function fail() {
      clearTimeout(timer);
      script.remove();
      checkoutScript = undefined;
      reject(
        new Error(
          "Secure checkout could not load. Check your connection and try again.",
        ),
      );
    }
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timer);
      if (window.Razorpay) resolve();
      else fail();
    };
    document.head.appendChild(script);
  });
  return checkoutScript;
}

type PendingIntent = { key: string; quantity: number; orderId?: string };
function restoreIntent(storageKey: string): PendingIntent | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(storageKey) || "null",
    );
    if (
      value &&
      typeof value === "object" &&
      "key" in value &&
      typeof value.key === "string" &&
      "quantity" in value &&
      typeof value.quantity === "number" &&
      Number.isInteger(value.quantity) &&
      value.quantity >= 1 &&
      value.quantity <= 6 &&
      (!("orderId" in value) || typeof value.orderId === "string")
    )
      return value as PendingIntent;
  } catch {
    /* Recovery remains possible from the wallet if browser storage is unavailable. */
  }
  return null;
}

export function PaymentCheckout({
  eventId,
  title,
  quantity,
  session,
  demo,
  soldOut,
  bookingClosed,
  onSignIn,
  onBooked,
  onBusyChange,
  onExternalDialogChange,
  onQuantityHeld,
}: {
  eventId: string;
  title: string;
  quantity: number;
  session: Session | null;
  demo: boolean;
  soldOut: boolean;
  bookingClosed: boolean;
  onSignIn: () => void;
  onBooked: () => void;
  onBusyChange: (busy: boolean) => void;
  onExternalDialogChange: (open: boolean) => void;
  onQuantityHeld: (quantity: number | null) => void;
}) {
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [recoverable, setRecoverable] = useState(false);
  const intent = useRef<PendingIntent | null>(null);
  const alive = useRef(false);
  const request = useRef<AbortController | null>(null);
  const checkout = useRef<Checkout | null>(null);
  const callbacks = useRef({
    onBusyChange,
    onExternalDialogChange,
    onQuantityHeld,
    onBooked,
  });
  callbacks.current = {
    onBusyChange,
    onExternalDialogChange,
    onQuantityHeld,
    onBooked,
  };
  const storageKey = session
    ? `chainpass.payment.${session.user.id}.${eventId}`
    : "";

  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    request.current = abort;
    intent.current = storageKey ? restoreIntent(storageKey) : null;
    if (intent.current) {
      callbacks.current.onQuantityHeld(intent.current.quantity);
      setRecoverable(true);
      setMessage(
        "A previous checkout is waiting for confirmation. Check its status before trying again.",
      );
    }
    void api<PaymentConfig>("/payments/config", { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setConfig(value);
      })
      .catch((err: unknown) => {
        if (!abort.signal.aborted) setError(errorMessage(err));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      alive.current = false;
      abort.abort();
      checkout.current?.close();
      checkout.current = null;
      callbacks.current.onBusyChange(false);
      callbacks.current.onExternalDialogChange(false);
      callbacks.current.onQuantityHeld(null);
    };
  }, [storageKey]);

  function remember(value: PendingIntent | null) {
    intent.current = value;
    try {
      if (storageKey)
        value
          ? sessionStorage.setItem(storageKey, JSON.stringify(value))
          : sessionStorage.removeItem(storageKey);
    } catch {
      /* Only the non-secret order reference is persisted for tab recovery. */
    }
    if (alive.current) {
      setRecoverable(value !== null);
      callbacks.current.onQuantityHeld(value?.quantity ?? null);
    }
  }
  function markBusy(value: boolean) {
    if (!alive.current) return;
    setBusy(value);
    callbacks.current.onBusyChange(value);
  }
  function accept(next: PaymentOrder) {
    if (!alive.current) return;
    setOrder(next);
    if (next.status === "paid" && next.booking) {
      remember(null);
      callbacks.current.onBooked();
    } else if (next.status === "refund_required") {
      setMessage(
        "The payment was received, but tickets could not be issued. Your payment needs a refund. Contact the site operator with the order reference below.",
      );
    } else if (next.status === "expired") {
      setMessage(
        "This checkout’s ticket hold has expired. If a payment is still processing, check again before starting another checkout.",
      );
    } else {
      setMessage(
        "Payment is not confirmed yet. No ticket has been issued. You can check the status or resume this same checkout.",
      );
    }
  }
  async function getOrder(): Promise<PaymentOrder> {
    if (!session || !intent.current) throw new Error("Start a checkout first.");
    if (intent.current.orderId) {
      return api<PaymentOrder>(
        `/payments/orders/${encodeURIComponent(intent.current.orderId)}`,
        { token: session.token, signal: request.current?.signal },
      );
    }
    const created = await api<PaymentOrder>("/payments/orders", {
      method: "POST",
      token: session.token,
      idempotencyKey: intent.current.key,
      body: { eventId, quantity: intent.current.quantity },
      signal: request.current?.signal,
    });
    if (alive.current && intent.current)
      remember({ ...intent.current, orderId: created.id });
    return created;
  }
  async function recover() {
    if (busy) return;
    markBusy(true);
    setError("");
    try {
      accept(await getOrder());
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    } finally {
      markBusy(false);
    }
  }
  async function book() {
    if (!session) {
      onSignIn();
      return;
    }
    if (!config || busy) return;
    markBusy(true);
    setError("");
    if (!config.enabled) {
      if (!demo) {
        setError("Payments have not been enabled yet. Please check back soon.");
        markBusy(false);
        return;
      }
      const signature = `${eventId}:${quantity}`;
      const key = `chainpass.demo-intent.${session.user.id}.${signature}`;
      let idempotencyKey = crypto.randomUUID() as string;
      try {
        idempotencyKey = sessionStorage.getItem(key) || idempotencyKey;
        sessionStorage.setItem(key, idempotencyKey);
      } catch {
        /* In-memory request is still safe. */
      }
      try {
        await api<Booking>("/bookings", {
          method: "POST",
          token: session.token,
          idempotencyKey,
          body: { eventId, quantity },
          signal: request.current?.signal,
        });
        if (alive.current) {
          try {
            sessionStorage.removeItem(key);
          } catch {
            /* Browser storage is optional. */
          }
          callbacks.current.onBooked();
        }
      } catch (err) {
        if (alive.current) setError(errorMessage(err));
      } finally {
        markBusy(false);
      }
      return;
    }
    let opened = false;
    try {
      if (!intent.current) remember({ key: crypto.randomUUID(), quantity });
      const next = await getOrder();
      if (!alive.current) return;
      accept(next);
      if (next.status !== "pending") return;
      await loadCheckout();
      if (!alive.current || !window.Razorpay) return;
      let handled = false;
      const finish = () => {
        checkout.current = null;
        if (alive.current) {
          callbacks.current.onExternalDialogChange(false);
          markBusy(false);
        }
      };
      const dialog = new window.Razorpay({
        key: next.keyId,
        amount: next.amount,
        currency: next.currency,
        order_id: next.providerOrderId,
        name: "ChainPass",
        description: title,
        prefill: {
          name: session.user.name,
          ...(session.user.email ? { email: session.user.email } : {}),
          ...(session.user.phone ? { contact: session.user.phone } : {}),
        },
        theme: { color: "#ff805e" },
        handler: (result) => {
          handled = true;
          if (!alive.current) return;
          setMessage(
            "Payment submitted. Waiting for server confirmation before issuing your tickets.",
          );
          void api<PaymentOrder>(
            `/payments/orders/${encodeURIComponent(next.id)}/confirm`,
            {
              method: "POST",
              token: session.token,
              body: result,
              signal: request.current?.signal,
            },
          )
            .then(accept)
            .catch((err: unknown) => {
              if (alive.current) {
                setError(errorMessage(err));
                setMessage(
                  "Your payment result could not be confirmed. Check this order’s status; do not pay again while confirmation is pending.",
                );
              }
            })
            .finally(finish);
        },
        modal: {
          ondismiss: () => {
            if (handled || !alive.current) return;
            handled = true;
            setMessage(
              "Checkout closed. Checking whether a payment was completed…",
            );
            void getOrder()
              .then(accept)
              .catch((err: unknown) => {
                if (alive.current) setError(errorMessage(err));
              })
              .finally(finish);
          },
        },
      });
      dialog.on("payment.failed", () => {
        if (alive.current)
          setMessage(
            "The payment attempt did not complete. You can retry securely in checkout or close it and check the order status.",
          );
      });
      checkout.current = dialog;
      callbacks.current.onExternalDialogChange(true);
      dialog.open();
      opened = true;
    } catch (err) {
      checkout.current = null;
      if (alive.current) {
        callbacks.current.onExternalDialogChange(false);
        setError(errorMessage(err));
        setMessage(
          "Your checkout is saved in this tab. Retry to recover the same order.",
        );
      }
    } finally {
      if (!opened) markBusy(false);
    }
  }
  function restart() {
    remember(null);
    setOrder(null);
    setMessage("");
    setError("");
  }
  const terminal =
    order?.status === "expired" || order?.status === "refund_required";
  return (
    <div className="payment-checkout">
      {loading ? (
        <p className="fine-print" role="status">
          Checking payment availability…
        </p>
      ) : config?.enabled ? (
        <div className="payment-provider-card">
          <div className="payment-provider-heading">
            <strong>
              <ShieldCheck size={16} /> Secure Razorpay checkout
            </strong>
            <span className="payment-mode">
              {config.mode === "test" ? "Test mode" : "Live"}
            </span>
          </div>
          <div className="payment-methods">
            <span>
              <Smartphone size={13} /> UPI
            </span>
            <span>
              <CreditCard size={13} /> Cards
            </span>
          </div>
          <p>
            {config.mode === "test"
              ? "Use Razorpay test payment details. No real money is charged."
              : "Pay securely with the payment methods available for your device and bank."}{" "}
            Tickets are issued after the server confirms payment.
          </p>
        </div>
      ) : config && demo ? (
        <div className="demo-disclosure">
          <CreditCard size={17} />
          <span>
            <strong>Demo checkout</strong>No payment is collected. Your demo
            ticket is issued instantly.
          </span>
        </div>
      ) : config ? (
        <p className="fine-print">Payment checkout is not enabled yet.</p>
      ) : null}
      {recoverable && (
        <div className="payment-pending" role="status">
          <strong>
            {order?.status === "refund_required"
              ? "Refund assistance needed"
              : order?.status === "expired"
                ? "Checkout expired"
                : "Your checkout is saved"}
          </strong>
          <p>{message}</p>
          {order && <p className="payment-reference">Order: {order.id}</p>}
          <button
            type="button"
            className="text-button"
            onClick={() => void recover()}
            disabled={busy}
          >
            Check payment status
          </button>
          {order?.status === "expired" && (
            <button
              type="button"
              className="text-button"
              onClick={restart}
              disabled={busy}
            >
              Start a new checkout
            </button>
          )}
        </div>
      )}
      {error && <ErrorNotice message={error} />}
      {!terminal && (
        <button
          className="button primary full-width"
          disabled={
            busy ||
            loading ||
            !config ||
            (!config.enabled && !demo) ||
            (!recoverable && (soldOut || bookingClosed))
          }
          onClick={() => void book()}
        >
          {busy ? (
            <Spinner
              label={
                config?.enabled
                  ? "Confirming your checkout…"
                  : "Securing your tickets…"
              }
            />
          ) : (
            <>
              {!session
                ? "Sign in to book"
                : recoverable
                  ? "Resume secure checkout"
                  : soldOut
                    ? "Sold out"
                    : bookingClosed
                      ? "Booking closed"
                      : config?.enabled
                        ? "Pay with UPI or card"
                        : "Confirm booking"}
              <ArrowRight size={17} />
            </>
          )}
        </button>
      )}
      <p className="fine-print centered">
        {config?.enabled
          ? "Payment details are handled by Razorpay. Keep this tab open while payment is processing."
          : "Tickets appear in your wallet after booking. You can cancel an unused ticket before the experience begins."}
      </p>
    </div>
  );
}
