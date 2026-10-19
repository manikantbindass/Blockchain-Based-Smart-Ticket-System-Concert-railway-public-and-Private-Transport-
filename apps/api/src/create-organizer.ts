import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createOrganizer } from "./seed.js";
import { z } from "zod";

const args = z
  .object({
    name: z.string().min(2).max(80),
    email: z.string().email().max(254),
    password: z.string().min(12).max(128),
  })
  .parse({
    name: process.env.ORGANIZER_NAME,
    email: process.env.ORGANIZER_EMAIL,
    password: process.env.ORGANIZER_PASSWORD,
  });
const db = await openDatabase(loadConfig());
try {
  await createOrganizer(db, args.name, args.email, args.password);
  console.log("Organizer account created.");
} finally {
  await db.close();
}
