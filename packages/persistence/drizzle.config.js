import { defineConfig } from "drizzle-kit";
import { getDatabaseConfig } from "@evidencegraph/config";

export default defineConfig({
  schema: "./src/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: getDatabaseConfig().url },
  strict: true,
  verbose: true,
});
