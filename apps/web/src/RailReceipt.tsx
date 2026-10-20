import { useEffect, useState } from "react";
import { ArrowUpRight, Printer, TrainFront } from "lucide-react";
import QRCode from "qrcode";
import type { Ticket } from "@chainpass/shared";
import "./rail.css";

export const railMoney = (amount: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: amount % 100 ? 2 : 0,
  }).format(amount / 100);
export const railDate = (
  value: string,
  options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  },
) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    ...options,
  }).format(new Date(value.length === 10 ? `${value}T12:00:00+05:30` : value));
export const railTime = (value: string) =>
  railDate(value, { hour: "2-digit", minute: "2-digit", hour12: false });
export const railLabel = (value: string) =>
  value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());

function PassengerQR({ ticket }: { ticket: Ticket }) {
  const [image, setImage] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setImage("");
    setFailed(false);
    void QRCode.toDataURL(ticket.qrPayload, {
      width: 180,
      margin: 1,
      errorCorrectionLevel: "M",
    })
      .then((value) => {
        if (active) setImage(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [ticket.qrPayload]);
  return (
    <div className="rail-receipt-qr">
      {image && (
        <img
          src={image}
          alt={`ChainPass sandbox QR for ${ticket.rail?.passenger.name}`}
        />
      )}
      {failed && <small>QR unavailable. Use the ticket code.</small>}
      <code>{ticket.code}</code>
    </div>
  );
}

export function RailReceipt({
  tickets,
  pnr,
  total,
  onClose,
}: {
  tickets: Ticket[];
  pnr: string;
  total: number;
  onClose?: () => void;
}) {
  const railTickets = tickets.filter((ticket) => ticket.rail?.pnr === pnr);
  const journey = railTickets[0]?.rail;
  if (!journey)
    return (
      <div className="rail-panel">Reservation details are unavailable.</div>
    );
  return (
    <article
      className="rail-receipt"
      aria-label="Sandbox electronic reservation slip"
    >
      <header className="rail-receipt-header">
        <div>
          <span className="rail-receipt-brand">
            <TrainFront size={24} /> chainpass.
          </span>
          <p>Electronic reservation slip</p>
        </div>
        <span className="rail-receipt-stamp">
          SANDBOX
          <br />
          NOT VALID FOR TRAVEL
        </span>
      </header>
      <div className="rail-receipt-pnr">
        <div>
          <span>DEMO RESERVATION REFERENCE</span>
          <strong>{pnr}</strong>
        </div>
        <div>
          <span>BOOKING DATE · IST</span>
          <strong>{railDate(railTickets[0]!.createdAt)}</strong>
        </div>
      </div>
      <div className="rail-receipt-train">
        <h2>{journey.trainName}</h2>
        <p>
          {journey.trainNumber} · {journey.travelClass} ·{" "}
          {railLabel(journey.quota)} quota
        </p>
      </div>
      <div className="rail-receipt-route">
        <div>
          <span>{railDate(journey.departureAt)}</span>
          <strong>{railTime(journey.departureAt)}</strong>
          <b>
            {journey.from.name} ({journey.from.code})
          </b>
        </div>
        <span className="rail-receipt-route-line">
          <TrainFront size={19} />
        </span>
        <div>
          <span>{railDate(journey.arrivalAt)}</span>
          <strong>{railTime(journey.arrivalAt)}</strong>
          <b>
            {journey.to.name} ({journey.to.code})
          </b>
        </div>
      </div>
      <div className="rail-receipt-boarding">
        <strong>Boarding station</strong>
        <span>
          {journey.boardingStation.name} ({journey.boardingStation.code})
        </span>
        <small>
          All displayed times are IST. Times shown above are for the route
          origin and destination; this simulator does not provide intermediate
          boarding times.
        </small>
      </div>
      <div className="rail-receipt-table-wrap">
        <table>
          <caption>Passenger and seat details</caption>
          <thead>
            <tr>
              <th>Passenger</th>
              <th>Age / gender</th>
              <th>Coach / seat</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {railTickets.map((ticket) => (
              <tr key={ticket.id}>
                <td>
                  <strong>{ticket.rail!.passenger.name}</strong>
                  <small>{railLabel(ticket.rail!.berthType)}</small>
                </td>
                <td>
                  {ticket.rail!.passenger.age} / {ticket.rail!.passenger.gender}
                </td>
                <td>
                  {ticket.rail!.coach} / {ticket.rail!.seat}
                </td>
                <td>
                  <span className={`rail-receipt-status ${ticket.status}`}>
                    {ticket.status === "valid"
                      ? "Demo confirmed"
                      : railLabel(ticket.status)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rail-receipt-total">
        <span>Original booking total · simulated payment</span>
        <strong>{railMoney(total)}</strong>
      </div>
      <div className="rail-receipt-codes">
        {railTickets.map((ticket) => (
          <PassengerQR ticket={ticket} key={ticket.id} />
        ))}
      </div>
      <div className="rail-receipt-disclaimer">
        <strong>This is a ChainPass sandbox reservation.</strong>
        <p>
          No railway seat was purchased and no payment was collected. Account
          identity was checked through a test OTP simulation, not UIDAI.
          Passenger details are self-declared. This slip and its QR codes are
          not Indian Railways or IRCTC travel documents.
        </p>
      </div>
      <div className="rail-receipt-actions">
        <button className="button primary" onClick={() => window.print()}>
          <Printer size={17} /> Print / save reservation slip
        </button>
        {onClose && (
          <button className="button secondary" onClick={onClose}>
            Done <ArrowUpRight size={16} />
          </button>
        )}
      </div>
    </article>
  );
}

export default RailReceipt;
