export type Category = "concert" | "rail" | "bus" | "metro";
export type Role = "customer" | "organizer";
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}
export interface Event {
  id: string;
  title: string;
  subtitle: string;
  category: Category;
  city: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  price: number;
  currency: "INR";
  capacity: number;
  remaining: number;
  image: string;
  featured: boolean;
  description: string;
  organizerId: string;
}
export interface Ticket {
  id: string;
  eventId: string;
  event: Event;
  userId: string;
  code: string;
  status: "valid" | "used" | "cancelled";
  createdAt: string;
  pricePaid: number;
  qrPayload: string;
  commitment: string;
  chainStatus: "pending" | "anchored" | "disabled";
  transactionHash: string | null;
}
export interface Session {
  token: string;
  user: User;
}
export interface Booking {
  tickets: Ticket[];
  total: number;
}
export interface Dashboard {
  totalTickets: number;
  totalRevenue: number;
  checkedIn: number;
  activeEvents: number;
  events: Event[];
  recentTickets: Ticket[];
}
export interface SystemStatus {
  mode: "demo" | "production";
  database: "sqlite" | "postgres";
  blockchain: "disabled" | "enabled";
  chainId: number | null;
}
