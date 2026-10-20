import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Compass,
  CreditCard,
  ExternalLink,
  Fingerprint,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  Minus,
  Music2,
  Plus,
  QrCode,
  ScanLine,
  Search,
  ShieldCheck,
  Sparkles,
  Ticket as TicketIcon,
  TrainFront,
  TramFront,
  BusFront,
  Users,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import type {
  Booking,
  Category,
  Dashboard,
  Event as Experience,
  Session,
  RailBooking,
  SystemStatus,
  Ticket,
} from "@chainpass/shared";
import { api, ApiError, errorMessage, readSession, saveSession } from "./api";
import { ErrorNotice, Modal, Spinner, Toast } from "./components";
import RailPage from "./RailPage";
import { RailReceipt } from "./RailReceipt";
import { ProviderAuth } from "./ProviderAuth";
import { PaymentCheckout } from "./PaymentCheckout";
import { PaymentHistory } from "./PaymentHistory";

type Page = "explore" | "rail" | "tickets" | "verify" | "organizer";
const categories: {
  id: Category | "all";
  name: string;
  singular: string;
  icon: typeof Music2;
}[] = [
  { id: "all", name: "All experiences", singular: "Experience", icon: Compass },
  { id: "concert", name: "Concerts", singular: "Concert", icon: Music2 },
  { id: "rail", name: "Railways", singular: "Railway", icon: TrainFront },
  { id: "bus", name: "Bus travel", singular: "Bus", icon: BusFront },
  { id: "metro", name: "Metro", singular: "Metro", icon: TramFront },
];
const money = (amount: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: amount % 100 ? 2 : 0,
  }).format(amount / 100);
const formatDate = (date: string, options?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    ...options,
  }).format(new Date(date));
const eventDate = (date: string) =>
  formatDate(date, { weekday: "short", day: "numeric", month: "short" });
const eventTime = (date: string) =>
  formatDate(date, { hour: "numeric", minute: "2-digit" });
const categoryName = (category: Category) =>
  categories.find((item) => item.id === category)?.singular;
const imageFor = (event: Experience) =>
  event.image ||
  `/images/${{ concert: "concert", rail: "train", bus: "bus", metro: "metro" }[event.category]}.jpg`;
const nav = [
  { id: "explore" as Page, label: "Explore", icon: Compass },
  { id: "rail" as Page, label: "Rail bookings", icon: TrainFront },
  { id: "tickets" as Page, label: "My tickets", icon: TicketIcon },
  { id: "verify" as Page, label: "Verify ticket", icon: ScanLine },
  { id: "organizer" as Page, label: "Organizer", icon: LayoutDashboard },
];

function pageFromHash(): Page {
  const page = location.hash.slice(1).split("/")[0];
  return nav.some((item) => item.id === page) ? (page as Page) : "explore";
}

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [session, setSession] = useState<Session | null>(readSession);
  const sessionRef = useRef(session);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [events, setEvents] = useState<Experience[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("all");
  const [category, setCategory] = useState<Category | "all">("all");
  const [selected, setSelected] = useState<Experience | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [ticketRevision, setTicketRevision] = useState(0);
  const [railRoute, setRailRoute] = useState({ from: "SBC", to: "MAS" });
  const closeToast = useCallback(() => setToast(""), []);
  const navigate = useCallback((target: Page) => {
    location.hash = target;
    setPage(target);
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const updateSession = useCallback((next: Session | null) => {
    sessionRef.current = next;
    saveSession(next);
    setSession(next);
  }, []);
  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ events: Experience[] }>("/events");
      setEvents(result.events);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadEvents();
    void api<SystemStatus>("/status")
      .then(setStatus)
      .catch(() => {});
  }, [loadEvents]);
  useEffect(() => {
    const listener = () => {
      setPage(pageFromHash());
      setMobileOpen(false);
    };
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    const saved = readSession();
    const controller = new AbortController();
    if (saved)
      void api<{ user: Session["user"] }>("/auth/me", {
        token: saved.token,
        signal: controller.signal,
      })
        .then(({ user }) => {
          if (
            !controller.signal.aborted &&
            sessionRef.current?.token === saved.token
          )
            updateSession({ token: saved.token, user });
        })
        .catch((err) => {
          if (
            !controller.signal.aborted &&
            sessionRef.current?.token === saved.token &&
            err instanceof ApiError &&
            err.status === 401
          ) {
            updateSession(null);
            setToast("Your session expired. Sign in to continue.");
          }
        });
    return () => controller.abort();
  }, [updateSession]);
  const cities = useMemo(
    () => [...new Set(events.map((item) => item.city))].sort(),
    [events],
  );
  const visibleEvents = useMemo(
    () =>
      events.filter(
        (item) =>
          (category === "all" || item.category === category) &&
          (city === "all" || item.city === city) &&
          `${item.title} ${item.subtitle} ${item.city} ${item.venue}`
            .toLowerCase()
            .includes(query.toLowerCase().trim()),
      ),
    [events, category, city, query],
  );
  const featured =
    events.find((item) => item.featured && item.category === "concert") ||
    events.find((item) => item.category === "concert") ||
    events[0];
  async function signOut() {
    if (session)
      try {
        await api("/auth/logout", { method: "POST", token: session.token });
      } catch {
        /* Local credentials are still removed when offline. */
      }
    updateSession(null);
    setToast("You have been signed out.");
  }
  const onBooked = () => {
    setSelected(null);
    setTicketRevision((value) => value + 1);
    void loadEvents();
    navigate("tickets");
    setToast("You’re going! Your tickets are ready.");
  };

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <aside
        className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}
        aria-label="Main navigation"
      >
        <button
          className="brand"
          aria-label="ChainPass home"
          onClick={() => navigate("explore")}
        >
          <img src="/favicon.svg" alt="" />
          <span>
            chainpass<span className="brand-dot">.</span>
          </span>
        </button>
        <div className="sidebar-section-label">YOUR NEXT EXPERIENCE</div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={20} strokeWidth={1.7} />
              <span>{item.label}</span>
              {page === item.id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="trust-note">
            <div className="trust-icon">
              <Fingerprint size={24} strokeWidth={1.4} />
            </div>
            <strong>
              Good times.
              <br />
              Genuine tickets.
            </strong>
            <p>
              Signed, verifiable tickets.
              <br />
              One less thing to worry about.
            </p>
            <button className="text-button" onClick={() => setHelpOpen(true)}>
              How it works <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="help-button" onClick={() => setHelpOpen(true)}>
            <CircleHelp size={18} /> Help & information{" "}
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-footer">
            <span className={`status-dot ${status ? "" : "offline"}`} />
            {status
              ? status.mode === "demo"
                ? "Demo environment"
                : "System connected"
              : "Connecting to system"}
            <span>v1.0</span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="mobile-heading">
            <button
              className="icon-button"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={22} />
            </button>
            <img src="/favicon.svg" alt="ChainPass" />
          </div>
          <div className="breadcrumb">
            Discover <ChevronRight size={14} />
            <span>{nav.find((item) => item.id === page)?.label}</span>
          </div>
          <div className="header-actions">
            <label className="location-select">
              <MapPin size={16} />
              <span className="sr-only">Filter by city</span>
              <select
                value={city}
                onChange={(e) => {
                  setCity(e.target.value);
                  navigate("explore");
                }}
              >
                <option value="all">All cities</option>
                {cities.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <ChevronDown size={13} />
            </label>
            <span className="header-divider" />
            {session ? (
              <>
                <button
                  className="account-button"
                  onClick={() => navigate("tickets")}
                  aria-label={`View tickets for ${session.user.name}`}
                >
                  <span className="avatar">
                    {session.user.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{session.user.name.split(" ")[0]}</span>
                </button>
                <button
                  className="icon-button"
                  onClick={() => setAuthOpen(true)}
                  title="Manage sign-in methods"
                  aria-label="Manage sign-in methods"
                >
                  <Fingerprint size={18} />
                </button>
                <button
                  className="icon-button logout"
                  onClick={() => void signOut()}
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut size={17} />
                </button>
              </>
            ) : (
              <button
                className="signin-button"
                onClick={() => setAuthOpen(true)}
              >
                Sign in <ArrowUpRight size={16} />
              </button>
            )}
          </div>
        </header>

        <main id="main-content" className="main-content" tabIndex={-1}>
          {page === "explore" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow muted">OUT THERE STARTS HERE</div>
                  <h1>
                    Go somewhere. <span>Feel something.</span>
                  </h1>
                  <p>From your daily commute to a night you’ll never forget.</p>
                </div>
                <div className="small-seal">
                  <ShieldCheck size={18} />
                  <span>
                    Every ticket.
                    <br />
                    <strong>Verifiably yours.</strong>
                  </span>
                </div>
              </div>
              <section className="hero" aria-label="Featured experience">
                <img
                  className="hero-image"
                  src="/images/concert.jpg"
                  alt="An electric crowd enjoying a live concert under bright stage lights"
                />
                <div className="hero-shade" />
                <div className="hero-content">
                  <span className="hero-tag">
                    <span /> THE NIGHT IS YOURS
                  </span>
                  <h2>
                    Less scrolling.
                    <br />
                    More <em>encores.</em>
                  </h2>
                  <p>
                    Be in the crowd. Feel every beat.
                    <br />
                    Find your next “I was there” moment.
                  </p>
                  <button
                    className="button primary hero-cta"
                    disabled={!featured}
                    onClick={() => featured && setSelected(featured)}
                  >
                    Explore live music <ArrowUpRight size={18} />
                  </button>
                  <div className="hero-footnote">
                    <Music2 size={14} /> Live music. Real connection.
                  </div>
                </div>
                {featured && (
                  <button
                    className="hero-feature"
                    onClick={() => setSelected(featured)}
                  >
                    <span className="live-label">IN THE SPOTLIGHT</span>
                    <strong>{featured.title}</strong>
                    <span>
                      {featured.city} <span className="middot">·</span>{" "}
                      {eventDate(featured.startsAt)} <ArrowUpRight size={17} />
                    </span>
                  </button>
                )}
                <span className="hero-index">
                  01 <span>/ DISCOVER</span>
                </span>
              </section>

              <section
                className="experience-section"
                aria-labelledby="experiences-heading"
              >
                <div className="section-title">
                  <div>
                    <h2 id="experiences-heading">
                      A ticket to your next thing
                      <span className="accent">.</span>
                    </h2>
                    <p>
                      Big nights, new places, everyday journeys. All right here.
                    </p>
                  </div>
                  <span className="result-count">
                    {loading
                      ? "Finding experiences"
                      : `${visibleEvents.length} experiences to explore`}
                  </span>
                </div>
                <div className="explore-controls">
                  <div
                    className="category-tabs"
                    aria-label="Experience category"
                  >
                    {categories.map((item) => (
                      <button
                        key={item.id}
                        className={`category-tab ${category === item.id ? "selected" : ""}`}
                        aria-pressed={category === item.id}
                        onClick={() => {
                          if (item.id === "rail") {
                            setRailRoute({ from: "SBC", to: "MAS" });
                            navigate("rail");
                          } else setCategory(item.id);
                        }}
                      >
                        <item.icon size={16} />
                        {item.name}
                      </button>
                    ))}
                  </div>
                  <label className="search-box">
                    <Search size={17} />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Find your next experience"
                      aria-label="Search experiences"
                    />
                    {query && (
                      <button
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </label>
                </div>
                {error ? (
                  <ErrorNotice
                    message={error}
                    onRetry={() => void loadEvents()}
                  />
                ) : loading ? (
                  <div className="event-grid">
                    {[0, 1, 2, 3, 4, 5].map((item) => (
                      <div className="event-skeleton" key={item}>
                        <div />
                        <span />
                        <span />
                      </div>
                    ))}
                  </div>
                ) : visibleEvents.length ? (
                  <div className="event-grid">
                    {visibleEvents.map((event) => (
                      <EventCard
                        key={event.id}
                        event={event}
                        onSelect={() => {
                          if (event.category === "rail") {
                            setRailRoute(
                              event.id === "evt-western-line"
                                ? { from: "CSMT", to: "MAO" }
                                : { from: "SBC", to: "MAS" },
                            );
                            navigate("rail");
                          } else setSelected(event);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={Search}
                    title="Your next thing is still out there"
                    text="Try a different city, category, or search to find more experiences."
                    action="Clear filters"
                    onAction={() => {
                      setQuery("");
                      setCity("all");
                      setCategory("all");
                    }}
                  />
                )}
              </section>
              <div className="experience-footer">
                <div>
                  <ShieldCheck size={23} />
                  <span>
                    <strong>Great experiences start with peace of mind.</strong>
                    <br />
                    Every ChainPass ticket has a unique, verifiable identity.
                  </span>
                </div>
                <button
                  className="text-button"
                  onClick={() => navigate("verify")}
                >
                  Verify a ticket <ArrowUpRight size={16} />
                </button>
              </div>
            </>
          )}
          {page === "rail" && (
            <RailPage
              key={session?.user.id || "guest"}
              session={session}
              initialRoute={railRoute}
              onSignIn={() => setAuthOpen(true)}
              onBooked={() => {
                setTicketRevision((value) => value + 1);
                void loadEvents();
              }}
            />
          )}
          {page === "tickets" && (
            <TicketsPage
              key={session?.user.id || "guest"}
              session={session}
              revision={ticketRevision}
              onSignIn={() => setAuthOpen(true)}
              onExplore={() => navigate("explore")}
              notify={setToast}
              onCancelled={() => void loadEvents()}
            />
          )}
          {page === "verify" && <VerifyPage />}
          {page === "organizer" && (
            <OrganizerPage
              session={session}
              onSignIn={() => setAuthOpen(true)}
              onCreated={() => void loadEvents()}
              notify={setToast}
            />
          )}
          <footer className="main-footer">
            <span>© {new Date().getFullYear()} ChainPass</span>
            <span>For the journey. For the moment.</span>
            <button onClick={() => setHelpOpen(true)}>
              About ChainPass <ArrowUpRight size={12} />
            </button>
          </footer>
        </main>
      </div>
      {selected && !authOpen && (
        <BookingModal
          event={events.find((event) => event.id === selected.id) || selected}
          session={session}
          systemStatus={status}
          onClose={() => setSelected(null)}
          onSignIn={() => setAuthOpen(true)}
          onBooked={onBooked}
        />
      )}
      {authOpen && (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onSuccess={(next) => {
            const linking = !!session;
            updateSession(next);
            setAuthOpen(false);
            setToast(
              linking
                ? "Your sign-in method is connected."
                : `Welcome ${next.user.name.split(" ")[0]}. You’re all set.`,
            );
          }}
          demo={status?.mode === "demo"}
          session={session}
        />
      )}
      {helpOpen && (
        <Modal
          title="A little more about us"
          onClose={() => setHelpOpen(false)}
        >
          <div className="dialog-body">
            <span className="dialog-icon">
              <Fingerprint size={28} />
            </span>
            <h2>
              Experiences worth
              <br />
              showing up for.
            </h2>
            <p className="dialog-description">
              ChainPass brings concerts and everyday transport into one ticket
              wallet, with cryptographically signed tickets you can verify.
            </p>
            <div className="info-steps">
              <div>
                <span>01</span>
                <p>
                  <strong>Find your thing</strong>Explore events and journeys,
                  then choose your tickets.
                </p>
              </div>
              <div>
                <span>02</span>
                <p>
                  <strong>Keep it in your pocket</strong>Your unique QR ticket
                  lives in My tickets. Download it before you go.
                </p>
              </div>
              <div>
                <span>03</span>
                <p>
                  <strong>Show up and scan</strong>The organizer validates your
                  signed ticket and records one-time check-in.
                </p>
              </div>
            </div>
            <div className="disclosure">
              <ShieldCheck size={19} />
              <p>
                {status?.mode === "demo"
                  ? "This is a demo. Bookings use simulated checkout and no money is collected. "
                  : ""}
                Blockchain anchoring is{" "}
                {status?.blockchain === "enabled"
                  ? "enabled; a ticket shows its real receipt when anchoring completes."
                  : "currently disabled. Ticket signature verification remains available."}
              </p>
            </div>
            <p className="fine-print">
              Keep your QR private: it is your entry credential. Event times are
              displayed in India Standard Time. A cancelled or used ticket
              cannot be checked in.
            </p>
          </div>
        </Modal>
      )}
      {toast && <Toast message={toast} close={closeToast} />}
    </div>
  );
}

function EventCard({
  event,
  onSelect,
}: {
  event: Experience;
  onSelect: () => void;
}) {
  return (
    <button
      className="event-card"
      onClick={onSelect}
      aria-label={
        event.category === "rail"
          ? `${event.title}, ${event.city}, search demo trains`
          : `${event.title}, ${event.city}, from ${money(event.price)}`
      }
    >
      <div className="event-image">
        <img src={imageFor(event)} alt="" loading="lazy" />
        <span className="event-category">{categoryName(event.category)}</span>
        {event.category !== "rail" && (
          <div className="date-badge">
            <span>
              {formatDate(event.startsAt, { month: "short" }).toUpperCase()}
            </span>
            <strong>{formatDate(event.startsAt, { day: "2-digit" })}</strong>
          </div>
        )}
        {event.category !== "rail" && event.remaining === 0 && (
          <span className="sold-out-overlay">Sold out</span>
        )}
      </div>
      <div className="event-card-body">
        <div className="event-location">
          <MapPin size={12} />
          {event.venue}, {event.city}
        </div>
        <h3>{event.title}</h3>
        <p className="event-subtitle">{event.subtitle}</p>
        <div className="event-card-bottom">
          <span>
            <strong>
              {event.category === "rail" ? "Search trains" : money(event.price)}
            </strong>
            <small>
              {event.category === "rail" ? " / sandbox" : " / person"}
            </small>
          </span>
          <span className="card-arrow">
            <ArrowUpRight size={18} />
          </span>
        </div>
      </div>
    </button>
  );
}

function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  onAction,
}: {
  icon: typeof Search;
  title: string;
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={30} strokeWidth={1.5} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action && (
        <button className="button primary" onClick={onAction}>
          {action}
          <ArrowUpRight size={17} />
        </button>
      )}
    </div>
  );
}

function AuthModal({
  onClose,
  onSuccess,
  demo,
  session,
}: {
  onClose: () => void;
  onSuccess: (session: Session) => void;
  demo: boolean;
  session: Session | null;
}) {
  const [register, setRegister] = useState(false),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [externalDialog, setExternalDialog] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit(
    event?: FormEvent,
    identity?: "explorer" | "organizer",
  ) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = identity
        ? {
            email: `${identity}@chainpass.local`,
            password: identity === "explorer" ? "Explore123!" : "Organize123!",
          }
        : { email, password, ...(register ? { name } : {}) };
      const next = await api<Session>(
        `/auth/${register && !identity ? "register" : "login"}`,
        { method: "POST", body },
      );
      if (mounted.current) onSuccess(next);
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={
        session
          ? "Manage sign-in methods"
          : register
            ? "Create account"
            : "Welcome back"
      }
      externalDialog={externalDialog}
      onClose={() => {
        if (!busy && !providerBusy) onClose();
      }}
    >
      <div className="dialog-body">
        <span className="dialog-icon">
          <TicketIcon size={27} />
        </span>
        <h2>
          {session
            ? "Another way to get here."
            : register
              ? "Your next story starts here."
              : "Good to see you again."}
        </h2>
        <p className="dialog-description">
          {session
            ? "Connect an email/password account to a verified Google account or mobile number."
            : register
              ? "One account. Every experience. Create your free ChainPass account."
              : "Sign in to book your next experience and access your tickets."}
        </p>
        {session && (
          <div className="account-methods-summary">
            <ShieldCheck size={17} />
            <span>
              {session.user.email || session.user.phone || session.user.name}
            </span>
          </div>
        )}
        <ProviderAuth
          session={session}
          disabled={busy}
          onSuccess={onSuccess}
          onBusyChange={setProviderBusy}
          onExternalDialogChange={setExternalDialog}
        />
        {!session && (
          <>
            <div className="divider-label">OR CONTINUE WITH EMAIL</div>
            <form
              className="form-stack"
              onSubmit={(event) => {
                if (providerBusy) event.preventDefault();
                else void submit(event);
              }}
            >
              {register && (
                <label>
                  Full name
                  <input
                    required
                    minLength={2}
                    maxLength={80}
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                  />
                </label>
              )}
              <label>
                Email address
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  required
                  minLength={10}
                  maxLength={128}
                  autoComplete={register ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    register ? "At least 10 characters" : "Your password"
                  }
                />
              </label>
              {error && <ErrorNotice message={error} />}
              <button
                className="button primary full-width"
                disabled={busy || providerBusy}
              >
                {busy ? (
                  <Spinner label="One moment…" />
                ) : (
                  <>
                    {register ? "Create account" : "Sign in"}
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </form>
            <p className="auth-switch">
              {register ? "Already part of the crowd?" : "New around here?"}{" "}
              <button
                disabled={busy || providerBusy}
                onClick={() => {
                  setRegister(!register);
                  setError("");
                }}
              >
                {register ? "Sign in" : "Create an account"}
              </button>
            </p>
            {demo && (
              <div className="demo-signin">
                <div className="divider-label">TAKE IT FOR A SPIN</div>
                <div>
                  <button
                    className="button secondary"
                    disabled={busy || providerBusy}
                    onClick={() => void submit(undefined, "explorer")}
                  >
                    <Compass size={16} />
                    Demo explorer
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy || providerBusy}
                    onClick={() => void submit(undefined, "organizer")}
                  >
                    <LayoutDashboard size={16} />
                    Demo organizer
                  </button>
                </div>
                <p>
                  Demo accounts reset with the local database. No payment
                  details needed.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function BookingModal({
  event,
  session,
  systemStatus,
  onClose,
  onSignIn,
  onBooked,
}: {
  event: Experience;
  session: Session | null;
  systemStatus: SystemStatus | null;
  onClose: () => void;
  onSignIn: () => void;
  onBooked: () => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [quantityHeld, setQuantityHeld] = useState(false);
  const [externalDialog, setExternalDialog] = useState(false);
  const holdQuantity = useCallback((held: number | null) => {
    setQuantityHeld(held !== null);
    if (held !== null) setQuantity(held);
  }, []);
  return (
    <Modal
      title="Your next experience"
      wide
      externalDialog={externalDialog}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="booking-layout">
        <div className="booking-info">
          <img
            className="booking-image"
            src={imageFor(event)}
            alt={event.title}
          />
          <div className="booking-copy">
            <span className="eyebrow accent">
              {categoryName(event.category)} / {event.city}
            </span>
            <h2>{event.title}</h2>
            <p className="dialog-description">{event.description}</p>
            <div className="detail-row">
              <CalendarDays size={18} />
              <span>
                <strong>{eventDate(event.startsAt)}</strong>
                {eventTime(event.startsAt)} – {eventTime(event.endsAt)} IST
              </span>
            </div>
            <div className="detail-row">
              <MapPin size={18} />
              <span>
                <strong>{event.venue}</strong>
                {event.city}
              </span>
            </div>
            <div className="detail-row">
              <ShieldCheck size={18} />
              <span>
                <strong>A ticket that’s verifiably yours</strong>Signed QR code
                · one-time entry
              </span>
            </div>
          </div>
        </div>
        <div className="booking-summary">
          <span className="eyebrow muted">MAKE IT A PLAN</span>
          <h3>Your tickets</h3>
          <div className="ticket-type">
            <div>
              <strong>Standard admission</strong>
              <span>
                {event.remaining > 0
                  ? `${event.remaining} available`
                  : "Currently sold out"}
              </span>
            </div>
            <strong>{money(event.price)}</strong>
          </div>
          <div className="quantity-row">
            <label id="quantity-label">Number of tickets</label>
            <div
              className="quantity-control"
              role="group"
              aria-labelledby="quantity-label"
            >
              <button
                disabled={quantity <= 1 || busy || quantityHeld}
                aria-label="Remove one ticket"
                onClick={() => setQuantity((value) => value - 1)}
              >
                <Minus size={15} />
              </button>
              <output aria-live="polite">{quantity}</output>
              <button
                disabled={
                  quantity >= Math.min(6, event.remaining) ||
                  busy ||
                  quantityHeld
                }
                aria-label="Add one ticket"
                onClick={() => setQuantity((value) => value + 1)}
              >
                <Plus size={15} />
              </button>
            </div>
          </div>
          <div className="price-breakdown">
            <div>
              <span>
                {quantity} {quantity === 1 ? "ticket" : "tickets"} ×{" "}
                {money(event.price)}
              </span>
              <span>{money(event.price * quantity)}</span>
            </div>
            <div>
              <span>Booking fees</span>
              <span>No fees</span>
            </div>
          </div>
          <div className="total-row">
            <span>Total</span>
            <strong>{money(event.price * quantity)}</strong>
          </div>
          <PaymentCheckout
            key={`${session?.token ?? "guest"}:${event.id}`}
            eventId={event.id}
            title={event.title}
            quantity={quantity}
            session={session}
            demo={systemStatus?.mode === "demo"}
            soldOut={event.remaining === 0}
            bookingClosed={new Date(event.startsAt).getTime() <= Date.now()}
            onSignIn={onSignIn}
            onBooked={onBooked}
            onBusyChange={setBusy}
            onExternalDialogChange={setExternalDialog}
            onQuantityHeld={holdQuantity}
          />
        </div>
      </div>
    </Modal>
  );
}

function TicketsPage({
  session,
  revision,
  onSignIn,
  onExplore,
  notify,
  onCancelled,
}: {
  session: Session | null;
  revision: number;
  onSignIn: () => void;
  onExplore: () => void;
  notify: (message: string) => void;
  onCancelled: () => void;
}) {
  const [tickets, setTickets] = useState<Ticket[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<Ticket | null>(null),
    [filter, setFilter] = useState("all");
  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError("");
    try {
      setTickets(
        (await api<{ tickets: Ticket[] }>("/tickets", { token: session.token }))
          .tickets,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [session]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  const filtered = tickets.filter(
    (ticket) => filter === "all" || ticket.status === filter,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">ALL YOUR PLANS, IN ONE PLACE</div>
          <h1>
            Good times. <span>On the way.</span>
          </h1>
          <p>Your tickets, ready whenever you are.</p>
        </div>
        <button className="button secondary" onClick={onExplore}>
          Explore more <ArrowUpRight size={17} />
        </button>
      </div>
      {!session ? (
        <EmptyState
          icon={TicketIcon}
          title="Your next chapter is waiting"
          text="Sign in to keep your concerts, commutes, and adventures together in one place."
          action="Sign in to view tickets"
          onAction={onSignIn}
        />
      ) : (
        <>
          <div className="wallet-toolbar">
            <div className="category-tabs">
              {[
                { id: "all", label: "All tickets" },
                { id: "valid", label: "Upcoming" },
                { id: "used", label: "Checked in" },
                { id: "cancelled", label: "Cancelled" },
              ].map((item) => (
                <button
                  key={item.id}
                  className={`category-tab ${filter === item.id ? "selected" : ""}`}
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                  <span className="tab-count">
                    {
                      tickets.filter(
                        (ticket) =>
                          item.id === "all" || ticket.status === item.id,
                      ).length
                    }
                  </span>
                </button>
              ))}
            </div>
            <button
              className="text-button"
              onClick={() => void load()}
              disabled={loading}
            >
              Refresh <ArrowUpRight size={14} />
            </button>
          </div>
          <PaymentHistory session={session} onIssued={() => void load()} />
          {error && <ErrorNotice message={error} onRetry={() => void load()} />}
          {loading ? (
            <div className="loading-panel">
              <Spinner label="Finding your tickets…" />
            </div>
          ) : !filtered.length ? (
            <EmptyState
              icon={TicketIcon}
              title={
                tickets.length
                  ? "Nothing here just yet"
                  : "More memories. Fewer maybes."
              }
              text={
                tickets.length
                  ? "Tickets with this status will appear here."
                  : "Your first great plan is one booking away. Find something you’ll love."
              }
              action="Find an experience"
              onAction={onExplore}
            />
          ) : (
            <div className="wallet-grid">
              {filtered.map((ticket) => (
                <button
                  className={`wallet-card ${ticket.status === "cancelled" ? "cancelled" : ""}`}
                  key={ticket.id}
                  onClick={() => setSelected(ticket)}
                >
                  <div className="wallet-image">
                    <img src={imageFor(ticket.event)} alt="" />
                    <span className={`ticket-status ${ticket.status}`}>
                      {ticket.status === "valid"
                        ? ticket.rail
                          ? "Demo reservation"
                          : ticket.payment?.mode === "test"
                            ? "Razorpay test ticket"
                            : "Ready to go"
                        : ticket.status === "used"
                          ? "Checked in"
                          : "Cancelled"}
                    </span>
                  </div>
                  <div className="wallet-copy">
                    <span className="eyebrow muted">
                      {categoryName(ticket.event.category)} /{" "}
                      {ticket.event.city}
                    </span>
                    <h3>{ticket.event.title}</h3>
                    <div className="wallet-meta">
                      <CalendarDays size={14} />
                      {eventDate(ticket.event.startsAt)}
                      <span>·</span>
                      {eventTime(ticket.event.startsAt)}
                    </div>
                    <div className="wallet-meta">
                      <MapPin size={14} />
                      {ticket.event.venue}
                    </div>
                    {ticket.rail && (
                      <div className="wallet-meta">
                        <TrainFront size={14} />
                        {ticket.rail.passenger.name} · {ticket.rail.coach} /{" "}
                        {ticket.rail.seat}
                      </div>
                    )}
                  </div>
                  <div className="ticket-tear">
                    <span>{ticket.code}</span>
                    <span>
                      View ticket <QrCode size={17} />
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {selected && session && (
        <TicketModal
          ticket={selected}
          session={session}
          onClose={() => setSelected(null)}
          notify={notify}
          onCancelled={(ticket) => {
            setTickets((items) =>
              items.map((item) => (item.id === ticket.id ? ticket : item)),
            );
            setSelected(ticket);
            onCancelled();
          }}
        />
      )}
    </>
  );
}

function TicketModal({
  ticket,
  session,
  onClose,
  notify,
  onCancelled,
}: {
  ticket: Ticket;
  session: Session;
  onClose: () => void;
  notify: (message: string) => void;
  onCancelled: (ticket: Ticket) => void;
}) {
  const [qr, setQr] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmCancel, setConfirmCancel] = useState(false),
    [receiptOpen, setReceiptOpen] = useState(false),
    [reservation, setReservation] = useState<RailBooking | null>(null);
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(ticket.qrPayload, {
      width: 460,
      margin: 3,
      errorCorrectionLevel: "M",
      color: { dark: "#141612", light: "#ffffff" },
    })
      .then((value) => {
        if (active) setQr(value);
      })
      .catch(() => {
        if (active)
          setError(
            "The QR could not be generated. Reopen your ticket to try again.",
          );
      });
    return () => {
      active = false;
    };
  }, [ticket.qrPayload]);
  async function download() {
    if (!qr) return;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("This browser does not support ticket downloads.");
      return;
    }
    ctx.fillStyle = "#f4f4e9";
    ctx.fillRect(0, 0, 900, 1200);
    ctx.fillStyle = "#151813";
    ctx.font = "bold 35px Arial";
    ctx.fillText("chainpass.", 70, 85);
    ctx.font = "bold 35px Arial";
    const title =
      ticket.event.title.length > 34
        ? `${ticket.event.title.slice(0, 32)}…`
        : ticket.event.title;
    ctx.fillText(title, 70, 170);
    ctx.font = "24px Arial";
    ctx.fillText(
      `${eventDate(ticket.event.startsAt)} · ${eventTime(ticket.event.startsAt)} IST`,
      70,
      220,
    );
    ctx.fillText(ticket.event.venue.slice(0, 46), 70, 265);
    ctx.fillText(ticket.event.city, 70, 305);
    const img = new Image();
    img.src = qr;
    await img.decode();
    ctx.drawImage(img, 150, 360, 600, 600);
    ctx.textAlign = "center";
    ctx.font = "bold 23px monospace";
    ctx.fillText(ticket.code, 450, 1010);
    ctx.font = "20px Arial";
    ctx.fillText(
      `Status: ${ticket.status.toUpperCase()} · ${money(ticket.pricePaid)}`,
      450,
      1060,
    );
    ctx.font = "17px Arial";
    ctx.fillText(
      ticket.rail
        ? "SANDBOX ONLY — NOT VALID FOR TRAVEL"
        : ticket.payment?.mode === "test"
          ? "RAZORPAY TEST PAYMENT — NO MONEY CHARGED"
          : "Keep this ticket private. QR admits one person, once.",
      450,
      1120,
    );
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `chainpass-${ticket.code}.png`;
    link.click();
    notify("Ticket downloaded. Keep your QR private.");
  }
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ ticket: Ticket }>(
        `/tickets/${ticket.id}/cancel`,
        { method: "POST", token: session.token },
      );
      onCancelled(result.ticket);
      setConfirmCancel(false);
      notify("Your ticket has been cancelled.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(message);
    } catch {
      setError(
        "Clipboard is unavailable in this browser. Select the code to copy it manually.",
      );
    }
  }
  async function showReceipt() {
    if (!ticket.rail) return;
    setBusy(true);
    setError("");
    try {
      setReservation(
        await api<RailBooking>(
          `/rail/bookings/${encodeURIComponent(ticket.rail.reservationId)}`,
          { token: session.token },
        ),
      );
      setReceiptOpen(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  if (receiptOpen && ticket.rail && reservation) {
    return (
      <Modal
        title="Rail reservation slip"
        wide
        onClose={() => setReceiptOpen(false)}
      >
        <RailReceipt
          tickets={reservation.tickets}
          pnr={reservation.pnr}
          total={reservation.total}
          onClose={() => setReceiptOpen(false)}
        />
      </Modal>
    );
  }
  return (
    <Modal
      title="Your ticket"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="dialog-body ticket-dialog">
        <div className="ticket-dialog-heading">
          <span className={`ticket-status ${ticket.status}`}>
            {ticket.status === "valid"
              ? ticket.rail
                ? "Demo reservation"
                : ticket.payment?.mode === "test"
                  ? "Razorpay test ticket"
                  : "Ready to go"
              : ticket.status === "used"
                ? "Checked in"
                : "Cancelled"}
          </span>
          <span className="eyebrow muted">
            {ticket.rail ? "SANDBOX RAIL" : "ADMIT ONE"}
          </span>
        </div>
        <h2>{ticket.event.title}</h2>
        {ticket.payment && (
          <div className="payment-pending">
            <strong>
              {ticket.payment.mode === "test"
                ? "Razorpay test payment"
                : "Payment confirmed"}
            </strong>
            <p>
              {ticket.payment.mode === "test"
                ? "This ticket was issued using a simulated provider payment. No money was charged."
                : "For cancellation or refund assistance, contact the organizer."}
            </p>
            <p className="payment-reference">Order: {ticket.payment.orderId}</p>
          </div>
        )}
        <p className="dialog-description">
          {eventDate(ticket.event.startsAt)} ·{" "}
          {eventTime(ticket.event.startsAt)} IST
          <br />
          {ticket.event.venue}, {ticket.event.city}
        </p>
        <div
          className={`qr-ticket ${ticket.status !== "valid" ? "qr-inactive" : ""}`}
        >
          {qr ? (
            <img
              src={qr}
              alt={`Signed QR entry credential for ticket ${ticket.code}`}
            />
          ) : (
            <Spinner label="Generating QR…" />
          )}
          {ticket.status !== "valid" && (
            <span>
              {ticket.status === "used"
                ? "Already checked in"
                : "Ticket cancelled"}
            </span>
          )}
        </div>
        <div className="ticket-code">
          <code>{ticket.code}</code>
          <button
            className="text-button"
            onClick={() => void copy(ticket.code, "Verification code copied.")}
          >
            Copy code
          </button>
        </div>
        <p className="fine-print centered">
          {ticket.rail
            ? "Simulated railway reservation. Not valid for travel."
            : "Your QR is your entry pass. Keep it private. The organizer scans it when you arrive."}
        </p>
        {ticket.rail && (
          <button
            className="button secondary full-width"
            disabled={busy}
            onClick={() => void showReceipt()}
          >
            <TrainFront size={17} /> View reservation slip
          </button>
        )}
        <div className="chain-state">
          <ShieldCheck size={18} />
          <div>
            <strong>
              {ticket.chainStatus === "anchored"
                ? "Anchored on blockchain"
                : ticket.chainStatus === "pending"
                  ? "Blockchain anchoring pending"
                  : "Cryptographically signed"}
            </strong>
            <span>
              {ticket.chainStatus === "disabled"
                ? "Blockchain anchoring is disabled in this environment."
                : ticket.chainStatus === "pending"
                  ? "Your ticket is valid. The on-chain receipt is being processed."
                  : "The ticket commitment has an on-chain receipt."}
            </span>
            {ticket.transactionHash && (
              <code title={ticket.transactionHash}>
                {ticket.transactionHash}
              </code>
            )}
          </div>
        </div>
        <details className="technical-details">
          <summary>Verification details</summary>
          <p>Commitment</p>
          <code>{ticket.commitment}</code>
          <button
            className="text-button"
            onClick={() =>
              void copy(
                ticket.qrPayload,
                "Private check-in payload copied. Only share with the organizer.",
              )
            }
          >
            Copy private check-in payload <QrCode size={14} />
          </button>
        </details>
        {error && <ErrorNotice message={error} />}
        <button
          className="button primary full-width"
          disabled={!qr || ticket.status !== "valid"}
          onClick={() =>
            void download().catch((err) => setError(errorMessage(err)))
          }
        >
          <ArrowDownToLine size={17} />
          Download ticket
        </button>
        {ticket.payment && ticket.status === "valid" && (
          <p className="fine-print centered">
            Contact the organizer for cancellation and refund assistance. Online
            cancellation is unavailable for provider-paid tickets.
          </p>
        )}
        {!ticket.payment &&
          ticket.status === "valid" &&
          new Date(ticket.event.startsAt).getTime() > Date.now() &&
          (confirmCancel ? (
            <div className="cancel-confirm">
              <strong>Cancel this ticket?</strong>
              <p>
                This releases your place and permanently invalidates this QR
                code.
              </p>
              <div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirmCancel(false)}
                >
                  Keep ticket
                </button>
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  {busy ? "Cancelling…" : "Yes, cancel ticket"}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="cancel-link"
              onClick={() => setConfirmCancel(true)}
            >
              Cancel ticket
            </button>
          ))}
      </div>
    </Modal>
  );
}

type Verification = {
  valid: boolean;
  status: string;
  eventTitle: string;
  commitment: string;
  chainStatus: string;
  transactionHash: string | null;
  sandboxRail?: boolean;
};
function VerifyPage() {
  const [code, setCode] = useState(() => {
      try {
        return decodeURIComponent(location.hash.split("/")[1] || "");
      } catch {
        return "";
      }
    }),
    [result, setResult] = useState<Verification | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(
        await api<Verification>(`/verify/${encodeURIComponent(code.trim())}`),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">
            A LITTLE CERTAINTY GOES A LONG WAY
          </div>
          <h1>
            Real ticket. <span>Real peace of mind.</span>
          </h1>
          <p>Check a ticket’s current status, without signing in.</p>
        </div>
      </div>
      <div className="verify-layout">
        <section className="verification-panel">
          <span className="large-icon">
            <ScanLine size={36} strokeWidth={1.4} />
          </span>
          <h2>Make sure it’s the real thing.</h2>
          <p>
            Enter the verification code printed below the QR on your ChainPass
            ticket.
          </p>
          <form className="form-stack" onSubmit={verify}>
            <label>
              Ticket verification code
              <input
                required
                maxLength={100}
                placeholder="Enter your ticket code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setResult(null);
                  setError("");
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              className="button primary full-width"
              disabled={busy || !code.trim()}
            >
              {busy ? (
                <Spinner label="Verifying ticket…" />
              ) : (
                <>
                  Verify ticket <ShieldCheck size={18} />
                </>
              )}
            </button>
          </form>
          {error && <ErrorNotice message={error} />}
          {result && (
            <div
              className={`verification-result ${result.valid ? "verified" : "invalid"}`}
              role="status"
            >
              <div className="result-icon">
                {result.valid ? <ShieldCheck size={29} /> : <X size={29} />}
              </div>
              <div>
                <h3>
                  {result.valid
                    ? result.sandboxRail
                      ? "Valid sandbox reservation"
                      : "This ticket is valid"
                    : `Ticket ${result.status}`}
                </h3>
                <p>{result.eventTitle}</p>
                <span>
                  {result.sandboxRail
                    ? "Simulated railway ticket. Not valid for travel."
                    : result.valid
                      ? "Ticket is currently eligible for check-in."
                      : "This ticket cannot be used for entry."}
                </span>
              </div>
              <div className="verification-proof">
                <span>Blockchain</span>
                <strong>
                  {result.chainStatus === "anchored"
                    ? "Anchored"
                    : result.chainStatus === "pending"
                      ? "Pending"
                      : "Disabled"}
                </strong>
                <span>Ticket commitment</span>
                <code>{result.commitment}</code>
                {result.transactionHash && (
                  <>
                    <span>Transaction</span>
                    <code>{result.transactionHash}</code>
                  </>
                )}
              </div>
            </div>
          )}
        </section>
        <aside className="verification-info">
          <div className="eyebrow accent">TRUST, BUILT IN</div>
          <h2>
            Your moment.
            <br />
            Protected.
          </h2>
          <div className="info-steps">
            <div>
              <span>
                <Fingerprint size={20} />
              </span>
              <p>
                <strong>A unique identity</strong>Every ticket gets a signed QR
                code, tied to one event and one entry.
              </p>
            </div>
            <div>
              <span>
                <ShieldCheck size={20} />
              </span>
              <p>
                <strong>A status you can check</strong>See whether a ticket is
                valid, already used, or cancelled, in real time.
              </p>
            </div>
            <div>
              <span>
                <ScanLine size={20} />
              </span>
              <p>
                <strong>One scan. One entry.</strong>Check-in updates your
                ticket status immediately, preventing reuse.
              </p>
            </div>
          </div>
          <div className="disclosure">
            <CircleHelp size={18} />
            <p>
              Verification checks ticket status. It does not transfer ownership
              or reserve entry. Keep the signed QR private.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}

function OrganizerPage({
  session,
  onSignIn,
  onCreated,
  notify,
}: {
  session: Session | null;
  onSignIn: () => void;
  onCreated: () => void;
  notify: (message: string) => void;
}) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [createOpen, setCreateOpen] = useState(false),
    [scannerOpen, setScannerOpen] = useState(false);
  const load = useCallback(async () => {
    if (!session || session.user.role !== "organizer") return;
    setLoading(true);
    setError("");
    try {
      setDashboard(
        await api<Dashboard>("/organizer/dashboard", { token: session.token }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [session]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">BEHIND EVERY GREAT EXPERIENCE</div>
          <h1>
            Make it happen<span className="accent">.</span>
          </h1>
          <p>Your experiences, your audience, your control room.</p>
        </div>
        {session?.user.role === "organizer" && (
          <button
            className="button primary"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={17} />
            Create experience
          </button>
        )}
      </div>
      {!session ? (
        <EmptyState
          icon={LayoutDashboard}
          title="Bring people together"
          text="Sign in with your organizer account to create experiences, see your bookings, and check in guests."
          action="Sign in as organizer"
          onAction={onSignIn}
        />
      ) : session.user.role !== "organizer" ? (
        <EmptyState
          icon={ShieldCheck}
          title="This space is for organizers"
          text="Your current account is an explorer account. Sign out and use an organizer account to manage experiences."
        />
      ) : (
        <>
          {error && <ErrorNotice message={error} onRetry={() => void load()} />}
          {loading && !dashboard ? (
            <div className="loading-panel">
              <Spinner label="Opening your control room…" />
            </div>
          ) : (
            dashboard && (
              <>
                <div className="stats-grid">
                  {[
                    {
                      title: "Tickets booked",
                      value: dashboard.totalTickets.toLocaleString("en-IN"),
                      icon: TicketIcon,
                      note: "Across your experiences",
                    },
                    {
                      title: "Sandbox booking value",
                      value: money(dashboard.totalRevenue),
                      icon: BarChart3,
                      note: "Demo value; no money collected",
                    },
                    {
                      title: "Guests checked in",
                      value: dashboard.checkedIn.toLocaleString("en-IN"),
                      icon: ScanLine,
                      note: "Successfully admitted",
                    },
                    {
                      title: "Active experiences",
                      value: dashboard.activeEvents.toLocaleString("en-IN"),
                      icon: CalendarDays,
                      note: "Ready for your audience",
                    },
                  ].map((stat) => (
                    <div className="stat-card" key={stat.title}>
                      <div>
                        <span>{stat.title}</span>
                        <stat.icon size={18} />
                      </div>
                      <strong>{stat.value}</strong>
                      <small>{stat.note}</small>
                    </div>
                  ))}
                </div>
                <div className="checkin-banner">
                  <span className="checkin-icon">
                    <QrCode size={30} />
                  </span>
                  <div>
                    <h2>They’re here for a good time.</h2>
                    <p>Validate a signed QR and welcome your next guest.</p>
                  </div>
                  <button
                    className="button primary"
                    onClick={() => setScannerOpen(true)}
                  >
                    <ScanLine size={18} />
                    Open check-in
                  </button>
                </div>
                <section className="organizer-events">
                  <div className="section-title">
                    <div>
                      <h2>Your experiences</h2>
                      <p>
                        Keep an eye on every plan you’ve put out into the world.
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => void load()}
                      disabled={loading}
                    >
                      Refresh <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {dashboard.events.length ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Experience</th>
                            <th>Date</th>
                            <th>Bookings</th>
                            <th>Ticket price</th>
                            <th>Availability</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dashboard.events.map((event) => (
                            <tr key={event.id}>
                              <td>
                                <div className="table-event">
                                  <img src={imageFor(event)} alt="" />
                                  <div>
                                    <strong>{event.title}</strong>
                                    <span>
                                      {event.city} ·{" "}
                                      {categoryName(event.category)}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td>
                                {eventDate(event.startsAt)}
                                <small>{eventTime(event.startsAt)} IST</small>
                              </td>
                              <td>
                                {event.capacity - event.remaining}
                                <span className="muted">
                                  {" "}
                                  / {event.capacity}
                                </span>
                                <div className="capacity-bar">
                                  <span
                                    style={{
                                      width: `${((event.capacity - event.remaining) / event.capacity) * 100}%`,
                                    }}
                                  />
                                </div>
                              </td>
                              <td>{money(event.price)}</td>
                              <td>
                                <span
                                  className={`availability ${event.remaining === 0 ? "full" : ""}`}
                                >
                                  <span />
                                  {new Date(event.startsAt).getTime() <=
                                  Date.now()
                                    ? "Started"
                                    : event.remaining === 0
                                      ? "Sold out"
                                      : "On sale"}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyState
                      icon={CalendarDays}
                      title="Every great event starts somewhere"
                      text="Create your first experience and give people something to look forward to."
                      action="Create experience"
                      onAction={() => setCreateOpen(true)}
                    />
                  )}
                </section>
                {dashboard.recentTickets.length > 0 && (
                  <section className="recent-bookings">
                    <div className="section-title">
                      <h2>Recent tickets</h2>
                      <span className="result-count">
                        Latest booking activity
                      </span>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Ticket</th>
                            <th>Experience</th>
                            <th>Status</th>
                            <th>Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dashboard.recentTickets.slice(0, 8).map((ticket) => (
                            <tr key={ticket.id}>
                              <td>
                                <code>{ticket.code}</code>
                                <small>{eventDate(ticket.createdAt)}</small>
                              </td>
                              <td>{ticket.event.title}</td>
                              <td>
                                <span
                                  className={`ticket-status ${ticket.status}`}
                                >
                                  {ticket.status}
                                </span>
                              </td>
                              <td>{money(ticket.pricePaid)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
              </>
            )
          )}
        </>
      )}
      {createOpen && session && (
        <CreateEventModal
          session={session}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void load();
            onCreated();
            notify("Your experience is live and ready to book.");
          }}
        />
      )}
      {scannerOpen && session && (
        <CheckInModal
          session={session}
          onClose={() => setScannerOpen(false)}
          onSuccess={() => {
            void load();
          }}
        />
      )}
    </>
  );
}

function CreateEventModal({
  session,
  onClose,
  onCreated,
}: {
  session: Session;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [category, setCategory] = useState<Category>("concert");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const startsAt = new Date(String(data.get("startsAt"))).toISOString(),
        endsAt = new Date(String(data.get("endsAt"))).toISOString();
      if (endsAt <= startsAt)
        throw new Error("The end time must be after the start time.");
      await api("/organizer/events", {
        method: "POST",
        token: session.token,
        body: {
          title: String(data.get("title")).trim(),
          subtitle: String(data.get("subtitle")).trim(),
          category,
          city: String(data.get("city")).trim(),
          venue: String(data.get("venue")).trim(),
          startsAt,
          endsAt,
          price: Math.round(Number(data.get("price")) * 100),
          currency: "INR",
          capacity: Number(data.get("capacity")),
          image: `/images/${{ concert: "concert", rail: "train", bus: "bus", metro: "metro" }[category]}.jpg`,
          featured: false,
          description: String(data.get("description")).trim(),
        },
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create experience"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="dialog-body">
        <h2>
          Give them something
          <br />
          to look forward to.
        </h2>
        <p className="dialog-description">
          Publish an experience. Start taking bookings.
        </p>
        <form className="form-stack create-form" onSubmit={submit}>
          <div className="form-columns">
            <label>
              Experience title
              <input
                name="title"
                required
                minLength={3}
                maxLength={100}
                placeholder="The next unforgettable night"
              />
            </label>
            <label>
              Category
              <select
                value={category}
                onChange={(event) =>
                  setCategory(event.target.value as Category)
                }
              >
                {categories
                  .filter((item) => item.id !== "all")
                  .map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label>
            Short description
            <input
              name="subtitle"
              required
              minLength={3}
              maxLength={160}
              placeholder="A little taste of what’s in store"
            />
          </label>
          <div className="form-columns">
            <label>
              City
              <input
                name="city"
                required
                minLength={2}
                maxLength={80}
                placeholder="Bengaluru"
              />
            </label>
            <label>
              Venue / departure point
              <input
                name="venue"
                required
                minLength={2}
                maxLength={160}
                placeholder="Where it all begins"
              />
            </label>
          </div>
          <div className="form-columns">
            <label>
              Starts at
              <input name="startsAt" type="datetime-local" required />
            </label>
            <label>
              Ends at
              <input name="endsAt" type="datetime-local" required />
            </label>
          </div>
          <p className="field-help">
            Enter dates in your device’s local timezone. Published times display
            in India Standard Time.
          </p>
          <div className="form-columns">
            <label>
              Price per ticket (₹)
              <input
                name="price"
                type="number"
                min="0"
                max="1000000"
                step="0.01"
                required
                placeholder="1499"
              />
            </label>
            <label>
              Capacity
              <input
                name="capacity"
                type="number"
                min="1"
                max="1000000"
                step="1"
                required
                placeholder="500"
              />
            </label>
          </div>
          <label>
            About this experience
            <textarea
              name="description"
              required
              minLength={20}
              maxLength={5000}
              rows={4}
              placeholder="Tell people what to expect, what makes it special, and what they should know before coming."
            />
          </label>
          <div className="disclosure">
            <Sparkles size={18} />
            <p>
              Your experience uses a curated image for its category and becomes
              available immediately after publishing.
            </p>
          </div>
          {error && <ErrorNotice message={error} />}
          <button className="button primary full-width" disabled={busy}>
            {busy ? (
              <Spinner label="Publishing experience…" />
            ) : (
              <>
                Publish experience <ArrowUpRight size={18} />
              </>
            )}
          </button>
        </form>
      </div>
    </Modal>
  );
}

type Detector = {
  detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
};
function CheckInModal({
  session,
  onClose,
  onSuccess,
}: {
  session: Session;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [payload, setPayload] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ticket, setTicket] = useState<Ticket | null>(null),
    [cameraActive, setCameraActive] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null);
  const cameraSupported =
    "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setCameraActive(false);
  }, []);
  useEffect(
    () => () => {
      stream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );
  useEffect(() => {
    if (!cameraActive) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const DetectorClass = (
      window as unknown as {
        BarcodeDetector: new (options: { formats: string[] }) => Detector;
      }
    ).BarcodeDetector;
    const detector = new DetectorClass({ formats: ["qr_code"] });
    const scan = async () => {
      if (stopped) return;
      try {
        if (video.current && video.current.readyState >= 2) {
          const results = await detector.detect(video.current);
          if (!stopped && results[0]?.rawValue) {
            setPayload(results[0].rawValue);
            setTicket(null);
            stopCamera();
            return;
          }
        }
      } catch {
        /* A video frame can be unavailable while the stream starts. */
      }
      if (!stopped) timer = setTimeout(() => void scan(), 300);
    };
    void scan();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [cameraActive, stopCamera]);
  async function startCamera() {
    setError("");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      setCameraActive(true);
      requestAnimationFrame(() => {
        if (video.current && stream.current) {
          video.current.srcObject = stream.current;
          void video.current.play().catch(() => {
            setError(
              "The camera could not start. Paste the signed QR payload below.",
            );
            stopCamera();
          });
        }
      });
    } catch {
      setError(
        "Camera access is unavailable. Allow camera permission or paste the signed QR payload below.",
      );
      stopCamera();
    }
  }
  async function checkIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setTicket(null);
    stopCamera();
    try {
      const result = await api<{ ticket: Ticket }>("/check-in", {
        method: "POST",
        token: session.token,
        body: { qrPayload: payload.trim() },
      });
      setTicket(result.ticket);
      setPayload("");
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Guest check-in"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="dialog-body">
        <span className="dialog-icon">
          <ScanLine size={28} />
        </span>
        <h2>Welcome to the moment.</h2>
        <p className="dialog-description">
          Scan the guest’s QR or paste its signed payload. Confirm check-in to
          admit one guest.
        </p>
        {cameraSupported && (
          <button
            className="button secondary full-width"
            disabled={busy}
            onClick={() => (cameraActive ? stopCamera() : void startCamera())}
          >
            <QrCode size={17} />
            {cameraActive ? "Stop camera" : "Scan with camera"}
          </button>
        )}
        {cameraActive && (
          <div className="camera-preview">
            <video ref={video} muted playsInline autoPlay />
            <span>Position the ticket QR inside the camera view</span>
          </div>
        )}
        <form className="form-stack checkin-form" onSubmit={checkIn}>
          <label>
            Signed QR payload
            <textarea
              value={payload}
              onChange={(e) => {
                setPayload(e.target.value);
                setTicket(null);
              }}
              required
              rows={4}
              maxLength={8192}
              placeholder="Scan a QR, or paste its signed content here"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <p className="field-help">
            A public verification code cannot be used to check in. The signed QR
            proves possession of the ticket.
          </p>
          {error && <ErrorNotice message={error} />}
          <button
            className="button primary full-width"
            disabled={busy || !payload.trim()}
          >
            {busy ? (
              <Spinner label="Validating ticket…" />
            ) : (
              <>
                Confirm check-in <ArrowRight size={17} />
              </>
            )}
          </button>
        </form>
        {ticket && (
          <div className="checkin-success" role="status">
            <Check size={30} />
            <h3>You’re in. Have a great time.</h3>
            <p>{ticket.event.title}</p>
            <code>{ticket.code}</code>
            <span>This ticket is now marked as used.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
