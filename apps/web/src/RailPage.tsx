import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ArrowLeftRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  CreditCard,
  Fingerprint,
  Info,
  Landmark,
  LockKeyhole,
  MapPin,
  Plus,
  Search,
  ShieldCheck,
  Smartphone,
  TrainFront,
  Trash2,
  Users,
} from "lucide-react";
import type {
  BerthPreference,
  RailBooking,
  RailBookingRequest,
  RailClassAvailability,
  RailClassCode,
  RailGender,
  RailIdentity,
  RailIdentityChallenge,
  RailOptions,
  RailPassenger,
  RailQuota,
  RailTrain,
  Session,
} from "@chainpass/shared";
import { api, errorMessage } from "./api";
import { ErrorNotice, Spinner } from "./components";
import {
  RailReceipt,
  railDate,
  railLabel,
  railMoney,
  railTime,
} from "./RailReceipt";
import "./rail.css";

type Step =
  "search" | "passengers" | "identity" | "review" | "payment" | "confirmation";
type SearchQuery = {
  from: string;
  to: string;
  date: string;
  quota: RailQuota;
  travelClass: RailClassCode | "ALL";
};
type Selection = { train: RailTrain; travelClass: RailClassAvailability };
const freshPassenger = (): RailPassenger => ({
  name: "",
  age: 30,
  gender: "M",
  berthPreference: "ANY",
});
const genderOptions = (
  <>
    <option value="M">Male</option>
    <option value="F">Female</option>
    <option value="X">Other</option>
  </>
);
const berthOptions: BerthPreference[] = [
  "ANY",
  "LOWER",
  "MIDDLE",
  "UPPER",
  "SIDE_LOWER",
  "SIDE_UPPER",
  "WINDOW",
  "AISLE",
];
const steps = [
  "Search",
  "Passengers",
  "Account check",
  "Review",
  "Payment",
  "Your reservation",
];
const stepKeys: Step[] = [
  "search",
  "passengers",
  "identity",
  "review",
  "payment",
  "confirmation",
];

export default function RailPage({
  session,
  onSignIn,
  onBooked,
  initialRoute,
}: {
  session: Session | null;
  onSignIn: () => void;
  onBooked: () => void;
  initialRoute?: { from: string; to: string };
}) {
  const [options, setOptions] = useState<RailOptions | null>(null);
  const [search, setSearch] = useState<SearchQuery>({
    from: initialRoute?.from || "SBC",
    to: initialRoute?.to || "MAS",
    date: "",
    quota: "GENERAL",
    travelClass: "ALL",
  });
  const [searched, setSearched] = useState<SearchQuery | null>(null);
  const [trains, setTrains] = useState<RailTrain[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [step, setStep] = useState<Step>("search");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [passengers, setPassengers] = useState<RailPassenger[]>([
    freshPassenger(),
  ]);
  const [boardingStation, setBoardingStation] = useState("");
  const [contactEmail, setContactEmail] = useState(session?.user.email || "");
  const [contactMobile, setContactMobile] = useState("9999999999");
  const [identity, setIdentity] = useState<RailIdentity | null>(null);
  const [identityName, setIdentityName] = useState(session?.user.name || "");
  const [dateOfBirth, setDateOfBirth] = useState("1995-01-01");
  const [gender, setGender] = useState<RailGender>("M");
  const [documentType, setDocumentType] = useState<"AADHAAR" | "VID">(
    "AADHAAR",
  );
  const [consent, setConsent] = useState(false);
  const [challenge, setChallenge] = useState<RailIdentityChallenge | null>(
    null,
  );
  const [otp, setOtp] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [paymentMethod, setPaymentMethod] =
    useState<RailBookingRequest["paymentMethod"]>("DEMO_UPI");
  const [booking, setBooking] = useState<RailBooking | null>(null);
  const sessionRef = useRef(session?.token);
  sessionRef.current = session?.token;
  const bookingLock = useRef(false);
  const idempotency = useRef<{ body: string; key: string } | null>(null);
  const searchSequence = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api<RailOptions>("/rail/options", { signal: controller.signal })
      .then((result) => {
        setOptions(result);
        setSearch((value) => ({
          ...value,
          date: value.date || result.suggestedDate,
        }));
      })
      .catch((err) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setIdentity(null);
    setChallenge(null);
    setOtp("");
    setConsent(false);
    setBooking(null);
    setPassengers([freshPassenger()]);
    setContactEmail(session?.user.email || "");
    setContactMobile("9999999999");
    setIdentityName(session?.user.name || "");
    setDateOfBirth("1995-01-01");
    setGender("M");
    setDocumentType("AADHAAR");
    setAcceptedTerms(false);
    setPaymentMethod("DEMO_UPI");
    setError("");
    setBusy("");
    bookingLock.current = false;
    idempotency.current = null;
    setStep((value) => (value === "search" ? "search" : "passengers"));
    if (!session) return;
    const controller = new AbortController();
    void api<RailIdentity>("/rail/identity", {
      token: session.token,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setIdentity(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [session?.token]);

  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  const go = (next: Step) => {
    setError("");
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  async function searchTrains(event?: FormEvent, preset?: SearchQuery) {
    event?.preventDefault();
    const query = preset || search;
    const sequence = ++searchSequence.current;
    setBusy("search");
    setError("");
    setSearched(null);
    setTrains([]);
    try {
      const result = await api<{ trains: RailTrain[] }>(
        `/rail/trains?${new URLSearchParams(query)}`,
      );
      if (active.current && sequence === searchSequence.current) {
        setTrains(result.trains);
        setSearched({ ...query });
      }
    } catch (err) {
      if (active.current && sequence === searchSequence.current)
        setError(errorMessage(err));
    } finally {
      if (active.current && sequence === searchSequence.current) setBusy("");
    }
  }
  function chooseTrain(train: RailTrain, travelClass: RailClassAvailability) {
    setSelection({ train, travelClass });
    setBoardingStation(train.from.code);
    setPassengers([freshPassenger()]);
    setAcceptedTerms(false);
    setBooking(null);
    idempotency.current = null;
    go("passengers");
  }
  function updatePassenger(index: number, patch: Partial<RailPassenger>) {
    setPassengers((value) =>
      value.map((passenger, i) =>
        i === index ? { ...passenger, ...patch } : passenger,
      ),
    );
  }
  async function continuePassengers(event: FormEvent) {
    event.preventDefault();
    if (!session) {
      onSignIn();
      return;
    }
    if (
      !selection ||
      passengers.length > (selection.train.quota === "TATKAL" ? 4 : 6)
    )
      return;
    const token = session.token;
    setBusy("identity-status");
    setError("");
    try {
      const result = await api<RailIdentity>("/rail/identity", { token });
      if (!active.current || token !== sessionRef.current) return;
      setIdentity(result);
      if (result.mode !== "sandbox")
        throw new Error(
          "The railway sandbox is unavailable in this environment.",
        );
      go(result.verified ? "review" : "identity");
    } catch (err) {
      if (active.current && token === sessionRef.current)
        setError(errorMessage(err));
    } finally {
      if (active.current && token === sessionRef.current) setBusy("");
    }
  }
  async function startIdentity(event?: FormEvent) {
    event?.preventDefault();
    if (!session || !consent) return;
    const token = session.token;
    setBusy("otp-start");
    setError("");
    try {
      const result = await api<RailIdentityChallenge>("/rail/identity/start", {
        method: "POST",
        token,
        body: {
          name: identityName,
          dateOfBirth,
          gender,
          documentType,
          identifier:
            documentType === "AADHAAR" ? "000000000000" : "0000000000000000",
          consent: true,
        },
      });
      if (!active.current || token !== sessionRef.current) return;
      setChallenge(result);
      setOtp("");
      setClock(Date.now());
      setResendAt(Date.now() + result.resendAfterSeconds * 1000);
    } catch (err) {
      if (active.current && token === sessionRef.current)
        setError(errorMessage(err));
    } finally {
      if (active.current && token === sessionRef.current) setBusy("");
    }
  }
  async function verifyIdentity(event: FormEvent) {
    event.preventDefault();
    if (!session || !challenge) return;
    const token = session.token;
    setBusy("otp-verify");
    setError("");
    try {
      const result = await api<RailIdentity>("/rail/identity/verify", {
        method: "POST",
        token,
        body: { challengeId: challenge.challengeId, otp },
      });
      if (!active.current || token !== sessionRef.current) return;
      setIdentity(result);
      setChallenge(null);
      setOtp("");
      go("review");
    } catch (err) {
      if (active.current && token === sessionRef.current)
        setError(errorMessage(err));
    } finally {
      if (active.current && token === sessionRef.current) setBusy("");
    }
  }
  async function confirmBooking(event: FormEvent) {
    event.preventDefault();
    if (!session || !selection || !acceptedTerms || bookingLock.current) return;
    bookingLock.current = true;
    const token = session.token;
    const body: RailBookingRequest = {
      trainId: selection.train.id,
      journeyDate: selection.train.journeyDate,
      travelClass: selection.travelClass.code,
      quota: selection.train.quota,
      boardingStation,
      passengers,
      contactEmail,
      contactMobile,
      paymentMethod,
      acceptedTerms: true,
    };
    const fingerprint = JSON.stringify(body);
    if (idempotency.current?.body !== fingerprint)
      idempotency.current = { body: fingerprint, key: crypto.randomUUID() };
    setBusy("booking");
    setError("");
    try {
      const result = await api<RailBooking>("/rail/bookings", {
        method: "POST",
        token,
        body,
        idempotencyKey: idempotency.current.key,
      });
      if (!active.current || token !== sessionRef.current) return;
      setBooking(result);
      go("confirmation");
      onBooked();
    } catch (err) {
      if (active.current && token === sessionRef.current)
        setError(errorMessage(err));
    } finally {
      if (active.current && token === sessionRef.current) {
        setBusy("");
        bookingLock.current = false;
      }
    }
  }
  const total = selection ? selection.travelClass.fare * passengers.length : 0;
  const currentStep = stepKeys.indexOf(step);
  const maxPassengers = selection?.train.quota === "TATKAL" ? 4 : 6;
  const cooldown = Math.max(0, Math.ceil((resendAt - clock) / 1000));
  const expired = challenge ? Date.parse(challenge.expiresAt) <= clock : false;
  const unavailable = options?.mode === "unavailable";

  return (
    <div className="rail-page">
      {step === "search" ? (
        <>
          <section className="rail-hero" aria-label="Railway booking">
            <img
              src="/images/train.jpg"
              alt="A train travelling through a green landscape"
            />
            <div className="rail-hero-copy">
              <div className="eyebrow">THE JOURNEY IS PART OF THE STORY</div>
              <h1>
                Window seat.
                <br />
                <em>Wider horizons.</em>
              </h1>
              <p>
                Find your train, choose your class, and make room for your next
                adventure.
              </p>
              <span className="rail-sandbox-badge">
                <ShieldCheck size={14} /> Railway booking sandbox · no real
                travel
              </span>
            </div>
          </section>
          {loadError && (
            <ErrorNotice
              message={loadError}
              onRetry={() => window.location.reload()}
            />
          )}
          {!options && !loadError && (
            <div className="rail-panel">
              <Spinner label="Loading railway search" />
            </div>
          )}
          {options && (
            <form
              className="rail-panel rail-search"
              onSubmit={(event) => void searchTrains(event)}
              aria-label="Search railway journeys"
            >
              <div className="rail-search-grid">
                <label className="rail-field">
                  <span>
                    <MapPin size={14} /> From station
                  </span>
                  <select
                    aria-label="From station"
                    value={search.from}
                    onChange={(event) =>
                      setSearch({ ...search, from: event.target.value })
                    }
                  >
                    {options.stations.map((station) => (
                      <option key={station.code} value={station.code}>
                        {station.city} · {station.code}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="rail-swap"
                  type="button"
                  aria-label="Swap stations"
                  onClick={() =>
                    setSearch({ ...search, from: search.to, to: search.from })
                  }
                >
                  <ArrowLeftRight size={16} />
                </button>
                <label className="rail-field">
                  <span>
                    <MapPin size={14} /> To station
                  </span>
                  <select
                    aria-label="To station"
                    value={search.to}
                    onChange={(event) =>
                      setSearch({ ...search, to: event.target.value })
                    }
                  >
                    {options.stations.map((station) => (
                      <option key={station.code} value={station.code}>
                        {station.city} · {station.code}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="rail-field">
                  <span>
                    <CalendarDays size={14} /> Journey date
                  </span>
                  <input
                    aria-label="Journey date"
                    type="date"
                    required
                    min={
                      search.quota === "TATKAL"
                        ? options.suggestedDate
                        : options.minDate
                    }
                    max={
                      search.quota === "TATKAL"
                        ? options.suggestedDate
                        : options.maxDate
                    }
                    value={search.date}
                    onChange={(event) =>
                      setSearch({ ...search, date: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="rail-search-bottom">
                <label className="rail-field">
                  Quota
                  <select
                    aria-label="Quota"
                    value={search.quota}
                    onChange={(event) =>
                      setSearch({
                        ...search,
                        quota: event.target.value as RailQuota,
                        date:
                          event.target.value === "TATKAL"
                            ? options.suggestedDate
                            : search.date,
                      })
                    }
                  >
                    <option value="GENERAL">General</option>
                    <option value="TATKAL">Tatkal · sandbox</option>
                  </select>
                </label>
                <label className="rail-field">
                  Travel class
                  <select
                    aria-label="Travel class"
                    value={search.travelClass}
                    onChange={(event) =>
                      setSearch({
                        ...search,
                        travelClass: event.target
                          .value as SearchQuery["travelClass"],
                      })
                    }
                  >
                    <option value="ALL">All classes</option>
                    {options.classes.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label} ({item.code})
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  Illustrative schedules and fares.
                  <br />
                  Every journey is a simulation.
                </p>
                <button
                  className="button primary"
                  disabled={!!busy || unavailable}
                  type="submit"
                >
                  {busy === "search" ? (
                    <Spinner label="Searching" />
                  ) : (
                    <>
                      <Search size={17} /> Search trains
                    </>
                  )}
                </button>
              </div>
              {search.quota === "TATKAL" && (
                <div className="rail-inline-note" style={{ marginTop: 17 }}>
                  <Info size={15} />
                  <span>
                    Sandbox Tatkal is for tomorrow only, with up to 4
                    passengers. Actual railway opening times are not simulated.
                  </span>
                </div>
              )}
              <div className="rail-route-suggestions">
                <span>TRY A DEMO ROUTE</span>
                {[
                  { from: "SBC", to: "MAS", label: "Bengaluru → Chennai" },
                  { from: "CSMT", to: "MAO", label: "Mumbai → Goa" },
                  { from: "NDLS", to: "AGC", label: "Delhi → Agra" },
                ].map((route) => (
                  <button
                    type="button"
                    disabled={!!busy || unavailable}
                    key={route.from}
                    onClick={() => {
                      const next = {
                        ...search,
                        from: route.from,
                        to: route.to,
                      };
                      setSearch(next);
                      void searchTrains(undefined, next);
                    }}
                  >
                    {route.label}
                  </button>
                ))}
              </div>
            </form>
          )}
          {unavailable && (
            <ErrorNotice message="Railway reservations are unavailable in this environment. An authorized railway and identity integration is required for production." />
          )}
          {error && <ErrorNotice message={error} />}
          {searched ? (
            <>
              <div className="rail-results-heading">
                <div>
                  <h2>
                    {trains.length} {trains.length === 1 ? "train" : "trains"}{" "}
                    for your journey<span className="accent">.</span>
                  </h2>
                  <p>
                    {
                      options?.stations.find(
                        (station) => station.code === searched.from,
                      )?.city
                    }{" "}
                    →{" "}
                    {
                      options?.stations.find(
                        (station) => station.code === searched.to,
                      )?.city
                    }{" "}
                    ·{" "}
                    {railDate(searched.date, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}{" "}
                    · {railLabel(searched.quota)} quota
                  </p>
                </div>
                <span>
                  <Clock3 size={13} /> All times IST · demo inventory
                </span>
              </div>
              <div className="rail-results">
                {trains.map((train) => (
                  <article className="rail-train" key={train.id}>
                    <div className="rail-train-header">
                      <span className="rail-train-icon">
                        <TrainFront size={22} />
                      </span>
                      <div>
                        <h3>{train.name}</h3>
                        <p>{train.number} · Illustrative service</p>
                      </div>
                      <span>{railLabel(train.quota)}</span>
                    </div>
                    <div className="rail-timetable">
                      <div>
                        <strong>{railTime(train.departureAt)}</strong>
                        <b>{train.from.name}</b>
                        <small>
                          {train.from.code} ·{" "}
                          {railDate(train.departureAt, {
                            day: "numeric",
                            month: "short",
                          })}
                        </small>
                      </div>
                      <div className="rail-duration">
                        {Math.floor(train.durationMinutes / 60)}h{" "}
                        {train.durationMinutes % 60
                          ? `${train.durationMinutes % 60}m`
                          : ""}
                        <span>
                          <TrainFront size={15} />
                        </span>
                        Journey duration
                      </div>
                      <div>
                        <strong>{railTime(train.arrivalAt)}</strong>
                        <b>{train.to.name}</b>
                        <small>
                          {train.to.code} ·{" "}
                          {railDate(train.arrivalAt, {
                            day: "numeric",
                            month: "short",
                          })}
                        </small>
                      </div>
                    </div>
                    <div className="rail-classes">
                      {train.classes.map((travelClass) => (
                        <button
                          className="rail-class"
                          aria-label={`Book ${travelClass.code} on ${train.name}`}
                          key={travelClass.code}
                          disabled={travelClass.status !== "AVAILABLE"}
                          onClick={() => chooseTrain(train, travelClass)}
                        >
                          <span>
                            <b>{travelClass.code}</b>
                            <strong>{railMoney(travelClass.fare)}</strong>
                          </span>
                          <small>{travelClass.label}</small>
                          <b>
                            {travelClass.remaining > 0 ? (
                              <>
                                <CheckCircle2 size={12} />{" "}
                                {travelClass.remaining} demo seats available
                              </>
                            ) : (
                              "Not available"
                            )}
                          </b>
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              {!trains.length && (
                <div className="rail-search-empty">
                  <Search size={30} />
                  <h3>No demo trains on this route</h3>
                  <p>
                    Try Bengaluru–Chennai, Mumbai–Goa, or Delhi–Agra with all
                    classes. Availability is simulated, and only the listed
                    routes are supported.
                  </p>
                </div>
              )}
            </>
          ) : (
            !busy &&
            !unavailable && (
              <div className="rail-search-empty">
                <TrainFront size={31} />
                <h3>A familiar booking flow, a new view.</h3>
                <p>
                  Search for a train to choose your class, add passengers,
                  complete a test account verification, and receive your sandbox
                  reservation slip.
                </p>
              </div>
            )
          )}
        </>
      ) : step === "confirmation" && booking ? (
        <div className="rail-confirmation">
          <div className="rail-confirmation-heading">
            <span>
              <Check size={29} />
            </span>
            <h1>
              Your sandbox reservation is ready<span className="accent">.</span>
            </h1>
            <p>
              {booking.tickets.length}{" "}
              {booking.tickets.length === 1 ? "passenger" : "passengers"} booked
              in the simulator. No money was collected.
              <br />
              Your reservation and individual tickets are saved in My tickets.
            </p>
          </div>
          <RailReceipt
            tickets={booking.tickets}
            pnr={booking.pnr}
            total={booking.total}
          />
          <div className="rail-confirmation-links">
            <a className="button secondary" href="#tickets">
              View my tickets <ArrowUpRight size={15} />
            </a>
            <button
              className="button secondary"
              onClick={() => {
                setBooking(null);
                go("search");
                void searchTrains();
              }}
            >
              Plan another journey <ArrowRight size={15} />
            </button>
          </div>
        </div>
      ) : (
        selection && (
          <>
            <div className="rail-workflow-heading">
              <div>
                <div className="eyebrow muted">
                  YOUR JOURNEY, ONE STEP CLOSER
                </div>
                <h1>
                  {step === "passengers"
                    ? "Who’s coming along?"
                    : step === "identity"
                      ? "A quick account check."
                      : step === "review"
                        ? "Let’s check the details."
                        : "Make it a reservation."}
                </h1>
                <p>
                  {step === "passengers"
                    ? "Add your passengers and choose where to board."
                    : step === "identity"
                      ? "An Aadhaar-style practice flow using a test identity and test OTP."
                      : step === "review"
                        ? "Review every name, station, and date before you continue."
                        : "Choose a simulated payment method. No payment details required."}
                </p>
              </div>
              <span className="rail-sandbox-badge">
                <ShieldCheck size={13} /> Sandbox
              </span>
            </div>
            <ol className="rail-steps" aria-label="Booking progress">
              {steps.map((label, index) => (
                <li
                  key={label}
                  className={
                    index === currentStep
                      ? "active"
                      : index < currentStep
                        ? "complete"
                        : ""
                  }
                  aria-current={index === currentStep ? "step" : undefined}
                >
                  <span>
                    {index < currentStep ? <Check size={13} /> : index + 1}
                  </span>
                  {label}
                </li>
              ))}
            </ol>
            {error && <ErrorNotice message={error} />}
            <div className="rail-layout">
              <div>
                {!session ? (
                  <div className="rail-panel rail-auth-callout">
                    <LockKeyhole size={35} />
                    <h2>Sign in to book your journey</h2>
                    <p>
                      Your sandbox identity check and reservations belong to
                      your account.
                      <br />
                      After signing in, choose your train to continue.
                    </p>
                    <button className="button primary" onClick={onSignIn}>
                      Sign in to continue <ArrowUpRight size={16} />
                    </button>
                  </div>
                ) : step === "passengers" ? (
                  <form
                    onSubmit={(event) => void continuePassengers(event)}
                    className="rail-form-stack"
                  >
                    <section className="rail-panel">
                      <div className="rail-section-title">
                        <div>
                          <span>
                            <Users size={17} />
                          </span>
                          <h2>Passenger details</h2>
                        </div>
                        <small>Up to {maxPassengers} passengers</small>
                      </div>
                      <p>
                        Reserved seats for ages 5–120 in this sandbox. Enter
                        test passenger details.
                      </p>
                      {passengers.map((passenger, index) => (
                        <div className="rail-passenger" key={index}>
                          <div>
                            <strong>PASSENGER {index + 1}</strong>
                            {passengers.length > 1 && (
                              <button
                                className="text-button"
                                type="button"
                                aria-label={`Remove passenger ${index + 1}`}
                                onClick={() =>
                                  setPassengers((items) =>
                                    items.filter((_, i) => i !== index),
                                  )
                                }
                              >
                                <Trash2 size={13} /> Remove
                              </button>
                            )}
                          </div>
                          <div className="rail-fields three">
                            <label className="rail-field rail-field-wide">
                              Full name
                              <input
                                aria-label={`Passenger ${index + 1} full name`}
                                value={passenger.name}
                                onChange={(event) =>
                                  updatePassenger(index, {
                                    name: event.target.value,
                                  })
                                }
                                placeholder="As shown on the passenger’s ID"
                                minLength={2}
                                maxLength={80}
                                required
                                autoComplete="off"
                              />
                            </label>
                            <label className="rail-field">
                              Age
                              <input
                                aria-label={`Passenger ${index + 1} age`}
                                value={
                                  Number.isNaN(passenger.age)
                                    ? ""
                                    : passenger.age
                                }
                                type="number"
                                min={5}
                                max={120}
                                step={1}
                                required
                                onChange={(event) =>
                                  updatePassenger(index, {
                                    age: event.target.valueAsNumber,
                                  })
                                }
                              />
                            </label>
                            <label className="rail-field">
                              Gender
                              <select
                                aria-label={`Passenger ${index + 1} gender`}
                                value={passenger.gender}
                                onChange={(event) =>
                                  updatePassenger(index, {
                                    gender: event.target.value as RailGender,
                                  })
                                }
                              >
                                {genderOptions}
                              </select>
                            </label>
                            <label className="rail-field">
                              Berth preference
                              <select
                                aria-label={`Passenger ${index + 1} berth preference`}
                                value={passenger.berthPreference}
                                onChange={(event) =>
                                  updatePassenger(index, {
                                    berthPreference: event.target
                                      .value as BerthPreference,
                                  })
                                }
                              >
                                {berthOptions.map((value) => (
                                  <option value={value} key={value}>
                                    {value === "ANY"
                                      ? "No preference"
                                      : railLabel(value)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        </div>
                      ))}
                      <div className="rail-passenger-add">
                        <button
                          type="button"
                          className="button secondary"
                          disabled={passengers.length >= maxPassengers}
                          onClick={() =>
                            setPassengers((items) => [
                              ...items,
                              freshPassenger(),
                            ])
                          }
                        >
                          <Plus size={15} /> Add passenger
                        </button>
                        <small>Berth preferences are not guaranteed.</small>
                      </div>
                    </section>
                    <section className="rail-panel">
                      <div className="rail-section-title">
                        <div>
                          <span>
                            <MapPin size={17} />
                          </span>
                          <h2>Boarding & contact</h2>
                        </div>
                      </div>
                      <div className="rail-fields">
                        <label className="rail-field rail-field-wide">
                          Boarding station
                          <select
                            aria-label="Boarding station"
                            value={boardingStation}
                            onChange={(event) =>
                              setBoardingStation(event.target.value)
                            }
                          >
                            {selection.train.boardingStations.map((station) => (
                              <option value={station.code} key={station.code}>
                                {station.name} ({station.code})
                              </option>
                            ))}
                          </select>
                          <small>
                            Journey times shown are for the origin and
                            destination. Intermediate boarding times are not
                            simulated.
                          </small>
                        </label>
                        <label className="rail-field">
                          Contact email
                          <input
                            aria-label="Contact email"
                            type="email"
                            required
                            maxLength={254}
                            value={contactEmail}
                            onChange={(event) =>
                              setContactEmail(event.target.value)
                            }
                          />
                        </label>
                        <label className="rail-field">
                          Contact mobile
                          <input
                            aria-label="Contact mobile"
                            type="tel"
                            inputMode="numeric"
                            pattern="[6-9][0-9]{9}"
                            maxLength={10}
                            required
                            value={contactMobile}
                            onChange={(event) =>
                              setContactMobile(
                                event.target.value.replace(/\D/g, ""),
                              )
                            }
                          />
                          <small>
                            Test Indian mobile format. No SMS or email is sent.
                          </small>
                        </label>
                      </div>
                    </section>
                    {identity?.verified && (
                      <div className="rail-inline-note">
                        <ShieldCheck size={17} />
                        <span>
                          Your account’s sandbox identity check is already
                          complete. Passenger details remain self-declared.
                        </span>
                      </div>
                    )}
                    <div className="rail-form-actions">
                      <button
                        className="text-button"
                        type="button"
                        disabled={!!busy}
                        onClick={() => go("search")}
                      >
                        <ArrowLeft size={15} /> Change train
                      </button>
                      <button
                        type="submit"
                        className="button primary"
                        disabled={!!busy}
                      >
                        {busy ? (
                          <Spinner label="Checking account" />
                        ) : (
                          <>
                            Continue to verification <ArrowRight size={16} />
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                ) : step === "identity" ? (
                  <section className="rail-panel">
                    <div className="rail-identity-heading">
                      <span>
                        <Fingerprint size={28} />
                      </span>
                      <div>
                        <h2>Sandbox account verification</h2>
                        <p>Test identity · consent · test OTP</p>
                      </div>
                    </div>
                    <div className="rail-inline-note">
                      <Info size={16} />
                      <span>
                        This simulates an Aadhaar-style account check.{" "}
                        <strong>Do not enter a real Aadhaar or VID.</strong> The
                        identifier below is an invalid, fixed test value. This
                        is not UIDAI verification.
                      </span>
                    </div>
                    {!challenge ? (
                      <form
                        className="rail-form-stack"
                        style={{ marginTop: 22 }}
                        onSubmit={(event) => void startIdentity(event)}
                      >
                        <div className="rail-fields">
                          <label className="rail-field rail-field-wide">
                            Account holder name
                            <input
                              aria-label="Account holder name"
                              value={identityName}
                              onChange={(event) =>
                                setIdentityName(event.target.value)
                              }
                              minLength={2}
                              maxLength={80}
                              required
                              autoComplete="off"
                            />
                          </label>
                          <label className="rail-field">
                            Account date of birth
                            <input
                              aria-label="Account date of birth"
                              type="date"
                              value={dateOfBirth}
                              max={options?.minDate}
                              min="1900-01-01"
                              required
                              onChange={(event) =>
                                setDateOfBirth(event.target.value)
                              }
                            />
                          </label>
                          <label className="rail-field">
                            Account gender
                            <select
                              aria-label="Account gender"
                              value={gender}
                              onChange={(event) =>
                                setGender(event.target.value as RailGender)
                              }
                            >
                              {genderOptions}
                            </select>
                          </label>
                          <label className="rail-field">
                            Test document type
                            <select
                              aria-label="Test document type"
                              value={documentType}
                              onChange={(event) =>
                                setDocumentType(
                                  event.target.value as "AADHAAR" | "VID",
                                )
                              }
                            >
                              <option value="AADHAAR">
                                Aadhaar · test only
                              </option>
                              <option value="VID">VID · test only</option>
                            </select>
                          </label>
                          <label className="rail-field">
                            Test identifier
                            <input
                              aria-label="Test identifier"
                              readOnly
                              value={
                                documentType === "AADHAAR"
                                  ? "000000000000"
                                  : "0000000000000000"
                              }
                            />
                            <small>
                              Fixed dummy identifier. Real IDs are rejected.
                            </small>
                          </label>
                        </div>
                        <label className="rail-check">
                          <input
                            type="checkbox"
                            required
                            checked={consent}
                            onChange={(event) =>
                              setConsent(event.target.checked)
                            }
                          />
                          <span>
                            I consent to sandbox account verification and
                            understand that this test does not verify my
                            identity with UIDAI or authenticate other
                            passengers.
                          </span>
                        </label>
                        <div className="rail-form-actions">
                          <button
                            className="text-button"
                            type="button"
                            onClick={() => go("passengers")}
                          >
                            <ArrowLeft size={14} /> Passenger details
                          </button>
                          <button
                            className="button primary"
                            disabled={!!busy || !consent}
                          >
                            {busy ? (
                              <Spinner label="Generating" />
                            ) : (
                              <>
                                Generate test OTP <ArrowRight size={16} />
                              </>
                            )}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <form
                        onSubmit={(event) => void verifyIdentity(event)}
                        className="rail-form-stack"
                        style={{ marginTop: 22 }}
                      >
                        <div className="rail-test-otp">
                          <span>YOUR SANDBOX OTP</span>
                          <strong data-testid="sandbox-otp">
                            {challenge.demoOtp}
                          </strong>
                          <p>Displayed here for testing. No SMS was sent.</p>
                        </div>
                        <label className="rail-field">
                          Sandbox OTP
                          <input
                            aria-label="Sandbox OTP"
                            autoComplete="one-time-code"
                            inputMode="numeric"
                            pattern="[0-9]{6}"
                            minLength={6}
                            maxLength={6}
                            required
                            placeholder="Enter the 6-digit test code"
                            value={otp}
                            onChange={(event) =>
                              setOtp(event.target.value.replace(/\D/g, ""))
                            }
                          />
                          <small>
                            {expired
                              ? "This code has expired. Generate another test OTP below."
                              : `Expires at ${railTime(challenge.expiresAt)} IST. Maximum 5 attempts.`}
                          </small>
                        </label>
                        <button
                          className="text-button"
                          disabled={!!busy || cooldown > 0}
                          type="button"
                          onClick={() => void startIdentity()}
                        >
                          {cooldown > 0
                            ? `Resend test OTP in ${cooldown}s`
                            : "Resend test OTP"}
                        </button>
                        <div className="rail-form-actions">
                          <button
                            className="text-button"
                            type="button"
                            disabled={!!busy}
                            onClick={() => {
                              setChallenge(null);
                              setOtp("");
                            }}
                          >
                            <ArrowLeft size={14} /> Edit account details
                          </button>
                          <button
                            className="button primary"
                            disabled={!!busy || expired || otp.length !== 6}
                          >
                            {busy ? (
                              <Spinner label="Verifying" />
                            ) : (
                              <>
                                Verify test OTP <ShieldCheck size={16} />
                              </>
                            )}
                          </button>
                        </div>
                      </form>
                    )}
                  </section>
                ) : step === "review" ? (
                  <div className="rail-form-stack">
                    <section className="rail-panel">
                      <div className="rail-section-title">
                        <div>
                          <span>
                            <Users size={17} />
                          </span>
                          <h2>Passenger summary</h2>
                        </div>
                        <button
                          className="text-button"
                          onClick={() => go("passengers")}
                        >
                          Edit <ArrowUpRight size={13} />
                        </button>
                      </div>
                      {passengers.map((passenger, index) => (
                        <div className="rail-review-passenger" key={index}>
                          <span>{index + 1}</span>
                          <div>
                            <strong>{passenger.name}</strong>
                            <p>
                              {passenger.age} years ·{" "}
                              {passenger.gender === "M"
                                ? "Male"
                                : passenger.gender === "F"
                                  ? "Female"
                                  : "Other"}{" "}
                              ·{" "}
                              {passenger.berthPreference === "ANY"
                                ? "No berth preference"
                                : `${railLabel(passenger.berthPreference)} preference`}
                            </p>
                          </div>
                          <small>Seat assigned after booking</small>
                        </div>
                      ))}
                    </section>
                    <section className="rail-panel">
                      <div className="rail-section-title">
                        <h2>Boarding & contact</h2>
                        <button
                          className="text-button"
                          onClick={() => go("passengers")}
                        >
                          Edit <ArrowUpRight size={13} />
                        </button>
                      </div>
                      <div className="rail-review-contact">
                        <strong>
                          {
                            selection.train.boardingStations.find(
                              (station) => station.code === boardingStation,
                            )?.name
                          }{" "}
                          ({boardingStation})
                        </strong>
                        <span>{contactEmail}</span>
                        <span>+91 {contactMobile} · test contact only</span>
                      </div>
                    </section>
                    <div className="rail-verified">
                      <ShieldCheck size={23} />
                      <div>
                        <strong>Account check complete · sandbox</strong>
                        <p>
                          {identity?.name} · test OTP simulation. Passenger
                          identities have not been verified.
                        </p>
                      </div>
                    </div>
                    <div className="rail-inline-note">
                      <Info size={16} />
                      <span>
                        Fares and availability are illustrative. Seats are
                        assigned when you confirm. No waitlist or RAC tickets
                        are issued in this simulator.
                      </span>
                    </div>
                    <div className="rail-form-actions">
                      <button
                        className="text-button"
                        onClick={() => go("passengers")}
                      >
                        <ArrowLeft size={15} /> Passenger details
                      </button>
                      <button
                        className="button primary"
                        onClick={() => go("payment")}
                      >
                        Continue to payment <ArrowRight size={16} />
                      </button>
                    </div>
                  </div>
                ) : step === "payment" ? (
                  <form
                    className="rail-form-stack"
                    onSubmit={(event) => void confirmBooking(event)}
                  >
                    <section className="rail-panel">
                      <div className="rail-section-title">
                        <div>
                          <span>
                            <CreditCard size={17} />
                          </span>
                          <h2>Simulated payment</h2>
                        </div>
                      </div>
                      <p style={{ marginBottom: 21 }}>
                        Choose a test method to finish the booking. No UPI ID,
                        bank account, card details, or money is needed.
                      </p>
                      <div className="rail-payment-options">
                        {(
                          [
                            {
                              value: "DEMO_UPI",
                              name: "UPI",
                              description: "Instant test confirmation",
                              icon: Smartphone,
                            },
                            {
                              value: "DEMO_CARD",
                              name: "Debit / credit card",
                              description: "No card details collected",
                              icon: CreditCard,
                            },
                            {
                              value: "DEMO_NETBANKING",
                              name: "Net banking",
                              description: "No bank login required",
                              icon: Landmark,
                            },
                          ] as const
                        ).map((method) => (
                          <label
                            className={`rail-payment-option ${paymentMethod === method.value ? "selected" : ""}`}
                            key={method.value}
                          >
                            <input
                              type="radio"
                              name="rail-payment"
                              value={method.value}
                              checked={paymentMethod === method.value}
                              onChange={() => setPaymentMethod(method.value)}
                              disabled={!!busy}
                            />
                            <method.icon size={23} />
                            <span>
                              <strong>{method.name} · demo</strong>
                              <small>{method.description}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    </section>
                    <label className="rail-check">
                      <input
                        type="checkbox"
                        required
                        checked={acceptedTerms}
                        onChange={(event) =>
                          setAcceptedTerms(event.target.checked)
                        }
                        disabled={!!busy}
                      />
                      <span>
                        I understand this is a sandbox reservation, no payment
                        is collected, and the reservation slip is not valid for
                        travel.
                      </span>
                    </label>
                    <div className="rail-form-actions">
                      <button
                        className="text-button"
                        type="button"
                        disabled={!!busy}
                        onClick={() => go("review")}
                      >
                        <ArrowLeft size={15} /> Review details
                      </button>
                      <button
                        className="button primary"
                        type="submit"
                        disabled={!!busy || !acceptedTerms}
                      >
                        {busy ? (
                          <Spinner label="Booking your test seats" />
                        ) : (
                          <>
                            Confirm sandbox booking <ArrowRight size={16} />
                          </>
                        )}
                      </button>
                    </div>
                    <p className="fine-print">
                      If your connection drops, retry here. The same unchanged
                      request will not create a second booking.
                    </p>
                  </form>
                ) : null}
              </div>
              <aside
                className="rail-panel rail-order"
                aria-label="Journey summary"
              >
                <div className="eyebrow">YOUR JOURNEY</div>
                <h3>{selection.train.name}</h3>
                <p>
                  {selection.train.number} ·{" "}
                  {railDate(selection.train.journeyDate)}
                </p>
                <div className="rail-order-route">
                  <div>
                    <strong>
                      {selection.train.from.name} ({selection.train.from.code})
                    </strong>
                    <span>
                      {railTime(selection.train.departureAt)} · departure IST
                    </span>
                  </div>
                  <div>
                    <strong>
                      {selection.train.to.name} ({selection.train.to.code})
                    </strong>
                    <span>
                      {railTime(selection.train.arrivalAt)} ·{" "}
                      {railDate(selection.train.arrivalAt, {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                  </div>
                </div>
                <div className="rail-order-details">
                  <div>
                    <span>Class</span>
                    <b>
                      {selection.travelClass.label} (
                      {selection.travelClass.code})
                    </b>
                  </div>
                  <div>
                    <span>Quota</span>
                    <b>{railLabel(selection.train.quota)}</b>
                  </div>
                  <div>
                    <span>Passengers</span>
                    <b>{passengers.length}</b>
                  </div>
                  <div>
                    <span>Fare per passenger</span>
                    <b>{railMoney(selection.travelClass.fare)}</b>
                  </div>
                </div>
                <div className="rail-order-total">
                  <span>Demo total</span>
                  <strong>{railMoney(total)}</strong>
                </div>
                <small>
                  Simulated fare only. No real payment.
                  <br />
                  Availability is checked again at confirmation.
                </small>
              </aside>
            </div>
          </>
        )
      )}
    </div>
  );
}
