// Load .env.local first so local dev overrides default .env values.
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({ path: ".env.local" });
dotenv.config();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prisma 7 expects datasource URLs in prisma.config.ts.
    // Fallback keeps build-time generate from failing when DATABASE_URL is not injected.
    url: process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/photos",
  },
});
