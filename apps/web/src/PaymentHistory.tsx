import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock3, CreditCard, RefreshCw } from "lucide-react";
import type { PaymentConfig, PaymentOrder, Session } from "@chainpass/shared";
import { api, errorMessage } from "./api";
import { ErrorNotice, Spinner } from "./components";
import "./providers.css";

const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});
const labels: Record<string, string> = {
  creating: "Preparing checkout",
  pending: "Awaiting confirmation",
  expired: "Hold expired",
  refund_required: "Refund assistance needed",
  paid: "Tickets issued",
};
const descriptions: Record<string, string> = {
  creating:
    "Payment order being prepared. Check its status to recover this checkout.",
  pending:
    "No tickets have been issued yet. Check this payment before paying again.",
  expired:
    "The ticket hold expired. A payment may still be processing; check its status before paying again.",
  refund_required:
    "Payment was received, but tickets could not be issued. Contact the site operator with this reference to arrange a refund.",
  paid: "Payment confirmed. Your tickets are available in this wallet.",
};

export function PaymentHistory({
  session,
  onIssued,
}: {
  session: Session;
  onIssued: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null);
  const previous = useRef(new Map<string, PaymentOrder["status"]>());
  const busy = useRef(false);
  const issuedCallback = useRef(onIssued);
  issuedCallback.current = onIssued;

  function record(next: PaymentOrder[]) {
    const issued = next.some((order) => {
      const before = previous.current.get(order.id);
      return (
        before !== undefined && before !== "paid" && order.status === "paid"
      );
    });
    for (const order of next) previous.current.set(order.id, order.status);
    if (issued) {
      setNotice("Payment confirmed. Your ticket wallet has been refreshed.");
      issuedCallback.current();
    }
  }

  async function load(controller: AbortController) {
    busy.current = true;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const config = await api<PaymentConfig>("/payments/config", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setEnabled(config.enabled);
      if (!config.enabled) {
        setOrders([]);
        return;
      }
      const result = await api<{ orders: PaymentOrder[] }>("/payments/orders", {
        token: session.token,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      record(result.orders);
      setOrders(result.orders);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorMessage(err));
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    previous.current = new Map();
    setOrders([]);
    setEnabled(null);
    setChecking(null);
    void load(controller);
    return () => {
      controller.abort();
      if (request.current === controller) request.current = null;
    };
    // A new session gets its own request lifecycle and private order history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

  function refresh() {
    if (busy.current || !request.current) return;
    void load(request.current);
  }

  async function check(order: PaymentOrder) {
    const controller = request.current;
    if (busy.current || !controller) return;
    busy.current = true;
    setChecking(order.id);
    setError("");
    setNotice("");
    try {
      const next = await api<PaymentOrder>(
        `/payments/orders/${encodeURIComponent(order.id)}`,
        { token: session.token, signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      record([next]);
      setOrders((current) =>
        current.map((item) => (item.id === next.id ? next : item)),
      );
      if (next.status !== "paid")
        setNotice(`Status checked: ${labels[next.status] || next.status}.`);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorMessage(err));
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        setChecking(null);
      }
    }
  }

  if (enabled === false) return null;
  let paidCount = 0;
  const visible = orders.filter(
    (order) => order.status !== "paid" || ++paidCount <= 5,
  );

  return (
    <section className="payment-history" aria-label="Payment activity">
      <div className="payment-history-heading">
        <div>
          <h2>
            <CreditCard size={18} /> Payment activity
          </h2>
          <p>Recover an interrupted checkout and track recent payments.</p>
        </div>
        <button
          className="button secondary"
          type="button"
          onClick={refresh}
          disabled={loading || checking !== null}
          aria-label="Refresh payment activity"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {loading && (
        <div className="payment-history-loading" role="status">
          <Spinner label="Loading payment activity…" />
        </div>
      )}
      {error && (
        <ErrorNotice
          message={error}
          onRetry={loading || checking ? undefined : refresh}
        />
      )}
      {notice && (
        <p className="payment-history-notice" role="status">
          {notice}
        </p>
      )}
      {!loading && !error && visible.length === 0 && (
        <p className="payment-history-empty">
          Your UPI and card checkouts will appear here.
        </p>
      )}
      {visible.length > 0 && (
        <div className="payment-history-list">
          {visible.map((order) => (
            <article
              className={`payment-history-order payment-history-${order.status}`}
              key={order.id}
            >
              <div className="payment-history-order-main">
                <div className="payment-history-order-title">
                  <span className="payment-history-status">
                    {order.status === "paid" ? (
                      <CheckCircle2 size={15} />
                    ) : (
                      <Clock3 size={15} />
                    )}
                    {labels[order.status] || order.status}
                  </span>
                  <span className="payment-mode">
                    {order.mode === "test" ? "Test mode" : "Live"}
                  </span>
                </div>
                <p>{descriptions[order.status]}</p>
                <p className="payment-reference">Order: {order.id}</p>
              </div>
              <div className="payment-history-order-actions">
                <strong>{currency.format(order.amount / 100)}</strong>
                {order.status !== "paid" && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={loading || checking !== null}
                    aria-label={`Check payment status for order ${order.id}`}
                    onClick={() => void check(order)}
                  >
                    {checking === order.id ? (
                      <Spinner label="Checking…" />
                    ) : (
                      <>
                        Check status <RefreshCw size={12} />
                      </>
                    )}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {orders.length > 0 && (
        <p className="provider-note">
          Shows the latest 20 checkouts and up to five confirmed payments. A
          refund is complete only after the payment provider confirms it.
        </p>
      )}
    </section>
  );
}
