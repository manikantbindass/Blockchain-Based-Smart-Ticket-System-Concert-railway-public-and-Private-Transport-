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
  rail?: RailTicketDetails;
}

export type RailClassCode = "SL" | "3A" | "2A" | "CC" | "EC";
export type RailQuota = "GENERAL" | "TATKAL";
export type RailGender = "M" | "F" | "X";
export type BerthPreference =
  | "ANY"
  | "LOWER"
  | "MIDDLE"
  | "UPPER"
  | "SIDE_LOWER"
  | "SIDE_UPPER"
  | "WINDOW"
  | "AISLE";
export interface RailStation {
  code: string;
  name: string;
  city: string;
}
export interface RailClassAvailability {
  code: RailClassCode;
  label: string;
  fare: number;
  remaining: number;
  status: "AVAILABLE" | "NOT_AVAILABLE";
}
export interface RailTrain {
  id: string;
  number: string;
  name: string;
  from: RailStation;
  to: RailStation;
  journeyDate: string;
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  boardingStations: RailStation[];
  classes: RailClassAvailability[];
  quota: RailQuota;
}
export interface RailOptions {
  stations: RailStation[];
  classes: { code: RailClassCode; label: string }[];
  quotas: RailQuota[];
  minDate: string;
  maxDate: string;
  suggestedDate: string;
  mode: "sandbox" | "unavailable";
}
export interface RailIdentity {
  verified: boolean;
  mode: "sandbox" | "unavailable";
  name?: string;
  dateOfBirth?: string;
  gender?: RailGender;
  maskedIdentifier?: string;
  verifiedAt?: string;
}
export interface RailIdentityChallenge {
  challengeId: string;
  expiresAt: string;
  resendAfterSeconds: number;
  demoOtp: string;
  maskedDestination: string;
  mode: "sandbox";
}
export interface RailPassenger {
  name: string;
  age: number;
  gender: RailGender;
  berthPreference: BerthPreference;
}
export interface RailTicketDetails {
  reservationId: string;
  pnr: string;
  trainId: string;
  trainNumber: string;
  trainName: string;
  journeyDate: string;
  from: RailStation;
  to: RailStation;
  boardingStation: RailStation;
  departureAt: string;
  arrivalAt: string;
  travelClass: RailClassCode;
  quota: RailQuota;
  passenger: RailPassenger;
  coach: string;
  seat: string;
  berthType: string;
  identityMode: "sandbox";
}
export interface RailBookingRequest {
  trainId: string;
  journeyDate: string;
  travelClass: RailClassCode;
  quota: RailQuota;
  boardingStation: string;
  passengers: RailPassenger[];
  contactEmail: string;
  contactMobile: string;
  paymentMethod: "DEMO_UPI" | "DEMO_CARD" | "DEMO_NETBANKING";
  acceptedTerms: boolean;
}
export interface RailBooking extends Booking {
  reservationId: string;
  pnr: string;
  paymentMode: "sandbox";
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
