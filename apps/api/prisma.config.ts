import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Read directly rather than via prisma's strict `env()` helper: that throws
    // while merely *loading* the config, which breaks `prisma generate` during
    // the Docker build, where no database exists yet. Commands that actually
    // need a connection still fail loudly when it is missing.
    url: process.env.DATABASE_URL,
  },
});
