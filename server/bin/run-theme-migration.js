#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const MIGRATION_LOCK_ID = 202607170020;
const migrationPath = path.join(
  __dirname,
  "..",
  "postgres",
  "migrations",
  "000020_create_delphi_theme_analysis.sql"
);

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the theme migration");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_SSL === "true" ||
      (process.env.DYNO && process.env.DATABASE_SSL !== "false")
        ? { rejectUnauthorized: false }
        : undefined,
  });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      MIGRATION_LOCK_ID,
    ]);
    await client.query(fs.readFileSync(migrationPath, "utf8"));
    await client.query("COMMIT");
    console.log("Delphi theme schema is ready.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Delphi theme migration failed:", error);
  process.exitCode = 1;
});
