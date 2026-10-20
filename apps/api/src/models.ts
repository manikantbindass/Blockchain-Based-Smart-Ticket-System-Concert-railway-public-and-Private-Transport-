import type { Event, Ticket, User } from "@chainpass/shared";
import type { Queryable, Row } from "./db.js";
import { signQr } from "./security.js";

export function userFrom(row: Row): User {
  return {
    id: String(row.id),
    name: String(row.name),
    email: Number(row.email_is_placeholder) === 1 ? "" : String(row.email),
    ...(row.phone ? { phone: String(row.phone) } : {}),
    role: row.role as User["role"],
  };
}
export function eventFrom(row: Row): Event {
  return {
    id: String(row.id),
    title: String(row.title),
    subtitle: String(row.subtitle),
    category: row.category as Event["category"],
    city: String(row.city),
    venue: String(row.venue),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    price: Number(row.price),
    currency: "INR",
    capacity: Number(row.capacity),
    remaining: Number(row.remaining),
    image: String(row.image),
    featured: Boolean(row.featured),
    description: String(row.description),
    organizerId: String(row.organizer_id),
  };
}
export async function ticketFrom(
  row: Row,
  db: Queryable,
  secret: string,
): Promise<Ticket> {
  const event = await db.get("SELECT * FROM events WHERE id = ?", [
    String(row.event_id),
  ]);
  if (!event) throw new Error("Ticket event missing");
  const rail =
    event.category === "rail"
      ? await db.get(
          "SELECT details FROM rail_ticket_details WHERE ticket_id = ?",
          [String(row.id)],
        )
      : undefined;
  const payment = await db.get(
    "SELECT p.order_id,o.mode FROM payment_tickets p JOIN payment_orders o ON o.id = p.order_id WHERE p.ticket_id = ?",
    [String(row.id)],
  );
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    event: eventFrom(event),
    userId: String(row.user_id),
    code: String(row.code),
    status: row.status as Ticket["status"],
    createdAt: String(row.created_at),
    pricePaid: Number(row.price_paid),
    qrPayload: signQr(String(row.id), String(row.code), secret),
    commitment: String(row.commitment),
    chainStatus: row.chain_status as Ticket["chainStatus"],
    transactionHash: row.transaction_hash ? String(row.transaction_hash) : null,
    ...(payment
      ? {
          payment: {
            orderId: String(payment.order_id),
            mode: payment.mode as "test" | "live",
          },
        }
      : {}),
    ...(rail
      ? { rail: JSON.parse(String(rail.details)) as Ticket["rail"] }
      : {}),
  };
}
