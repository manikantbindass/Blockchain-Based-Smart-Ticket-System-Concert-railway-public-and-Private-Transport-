import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { hashPassword } from "./security.js";

export async function seedDemo(db: Database): Promise<void> {
  const organizerHash = await hashPassword("Organize123!");
  const customerHash = await hashPassword("Explore123!");
  await db.transaction(async (tx) => {
    const createdAt = new Date().toISOString();
    await tx.run(
      "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING",
      [
        "usr-demo-organizer",
        "Maya Kapoor",
        "organizer@chainpass.local",
        organizerHash,
        "organizer",
        createdAt,
      ],
    );
    await tx.run(
      "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING",
      [
        "usr-demo-explorer",
        "Alex Morgan",
        "explorer@chainpass.local",
        customerHash,
        "customer",
        createdAt,
      ],
    );
    const owner = await tx.get("SELECT id FROM users WHERE email = ?", [
      "organizer@chainpass.local",
    ]);
    if (!owner) throw new Error("Demo organizer missing");
    const entries = [
      {
        id: "evt-neon-nights",
        title: "Neon Nights Festival",
        subtitle: "One city. A thousand frequencies.",
        category: "concert",
        city: "Bengaluru",
        venue: "Palace Grounds",
        days: 8,
        hours: 6,
        price: 249900,
        capacity: 1200,
        image: "concert",
        featured: 1,
        description:
          "Step into an electric night of live music, immersive light installations, and unforgettable performances. Discover three stages, independent food makers, and your next favourite artist. General admission includes access to all stages. Gates open one hour before the first set.",
      },
      {
        id: "evt-vande-bharat",
        title: "Vande Bharat Express",
        subtitle: "Bengaluru → Chennai",
        category: "rail",
        city: "Bengaluru",
        venue: "KSR Bengaluru Railway Station",
        days: 2,
        hours: 5,
        price: 125000,
        capacity: 300,
        image: "train",
        featured: 0,
        description:
          "A comfortable intercity journey from Bengaluru to Chennai with reserved chair car seating. Arrive at least 30 minutes before departure. This is a demonstration service listing, not an official railway booking or travel authority.",
      },
      {
        id: "evt-coastal-express",
        title: "The Coastal Escape",
        subtitle: "Bengaluru → Gokarna",
        category: "bus",
        city: "Bengaluru",
        venue: "Majestic Bus Terminal",
        days: 4,
        hours: 9,
        price: 89900,
        capacity: 40,
        image: "bus",
        featured: 0,
        description:
          "Trade the city skyline for the coast on an overnight air-conditioned coach. Reclining seats, one cabin bag, and a scenic arrival are included. Please reach the boarding point 20 minutes early. Demonstration route only.",
      },
      {
        id: "evt-metro-day",
        title: "Your City. Your Day.",
        subtitle: "Namma Metro • Day explorer pass",
        category: "metro",
        city: "Bengaluru",
        venue: "MG Road Metro Station",
        days: 1,
        hours: 14,
        price: 15000,
        capacity: 2000,
        image: "metro",
        featured: 0,
        description:
          "Make room for spontaneous plans with a one-day city explorer pass. Discover neighbourhood cafés, galleries, and green spaces along the metro network. This demonstration pass is not valid on the real Namma Metro system.",
      },
      {
        id: "evt-sunset-sessions",
        title: "Sunset Sessions",
        subtitle: "Acoustic sounds. Open skies.",
        category: "concert",
        city: "Mumbai",
        venue: "Jio World Garden",
        days: 12,
        hours: 4,
        price: 179900,
        capacity: 450,
        image: "concert",
        featured: 0,
        description:
          "An intimate evening of indie, soul, and acoustic music in an open-air garden. Come early for golden-hour food stalls, stay for artists who bring the city together. General admission, standing and lawn seating.",
      },
      {
        id: "evt-western-line",
        title: "Western Coast Express",
        subtitle: "Mumbai → Goa",
        category: "rail",
        city: "Mumbai",
        venue: "Chhatrapati Shivaji Terminus",
        days: 5,
        hours: 10,
        price: 189900,
        capacity: 240,
        image: "train",
        featured: 0,
        description:
          "Watch the Konkan coast unfold from a reserved air-conditioned rail carriage. A long weekend begins with a memorable journey. This is a demonstration itinerary and does not issue official Indian Railways tickets.",
      },
      {
        id: "evt-airport-shuttle",
        title: "Airport, Effortlessly",
        subtitle: "City centre → Kempegowda Airport",
        category: "bus",
        city: "Bengaluru",
        venue: "Indiranagar Pickup Point",
        days: 1,
        hours: 2,
        price: 35000,
        capacity: 36,
        image: "bus",
        featured: 0,
        description:
          "A direct city-to-airport shuttle with air conditioning and luggage space. Allow extra time for traffic and airline check-in. Tickets on this platform are demonstration credentials only.",
      },
      {
        id: "evt-delhi-metro",
        title: "Capital Explorer",
        subtitle: "Delhi Metro • City day pass",
        category: "metro",
        city: "Delhi",
        venue: "Rajiv Chowk Station",
        days: 3,
        hours: 14,
        price: 20000,
        capacity: 1800,
        image: "metro",
        featured: 0,
        description:
          "From Old Delhi streets to contemporary galleries, plan a day of discoveries across the capital. This demo city pass illustrates secure digital transport ticketing and is not valid for actual transit.",
      },
      {
        id: "evt-under-stars",
        title: "Under the Stars",
        subtitle: "Electronic music after dark",
        category: "concert",
        city: "Delhi",
        venue: "Jawaharlal Nehru Stadium",
        days: 18,
        hours: 5,
        price: 329900,
        capacity: 800,
        image: "concert",
        featured: 0,
        description:
          "A late-evening celebration of electronic music and large-scale visual art. Explore the food village and dance to a carefully curated lineup on the main stage. Ages 18+; a ticket and valid ID are required at entry.",
      },
    ];
    for (const entry of entries) {
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + entry.days);
      start.setUTCHours(entry.category === "concert" ? 12 : 3, 0, 0, 0);
      const end = new Date(start.getTime() + entry.hours * 3_600_000);
      await tx.run(
        `INSERT INTO events(id,title,subtitle,category,city,venue,starts_at,ends_at,price,currency,capacity,remaining,image,featured,description,organizer_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        [
          entry.id,
          entry.title,
          entry.subtitle,
          entry.category,
          entry.city,
          entry.venue,
          start.toISOString(),
          end.toISOString(),
          entry.price,
          "INR",
          entry.capacity,
          entry.capacity,
          `/images/${entry.image}.jpg`,
          entry.featured,
          entry.description,
          String(owner.id),
        ],
      );
    }
  });
}

/** Run through an explicit trusted operator command; never expose role assignment over HTTP. */
export async function createOrganizer(
  db: Database,
  name: string,
  email: string,
  password: string,
) {
  const hash = await hashPassword(password);
  await db.run(
    "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
    [
      randomUUID(),
      name,
      email.trim().toLowerCase(),
      hash,
      "organizer",
      new Date().toISOString(),
    ],
  );
}
