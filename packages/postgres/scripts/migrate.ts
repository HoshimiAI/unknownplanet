import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL before running PostgreSQL migrations.");
const schemaNames = process.env.PLANET_SCHEMAS
  ? [...new Set(process.env.PLANET_SCHEMAS.split(",").map((schema) => schema.trim()).filter(Boolean))]
  : [process.env.PLANET_SCHEMA ?? "public"];
if (!schemaNames.length || schemaNames.some((schema) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))) throw new Error("PLANET_SCHEMA and PLANET_SCHEMAS must contain simple PostgreSQL identifiers.");
const pool = new Pool({ connectionString });
const migrationsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const files = (await readdir(migrationsPath)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();

try {
  for (const schemaName of schemaNames) {
    const schema = `"${schemaName}"`;
    const lock = await pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", ["unknownplanet-schema-migrations", schemaName]);
      await lock.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await lock.query(`CREATE TABLE IF NOT EXISTS ${schema}.unknownplanet_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const file of files) {
        const exists = await pool.query(`SELECT 1 FROM ${schema}.unknownplanet_schema_migrations WHERE version=$1`, [file]);
        if (exists.rowCount) continue;
        const connection = await pool.connect();
        try {
          await connection.query("BEGIN");
          await connection.query(`SET LOCAL search_path TO ${schema}, public`);
          await connection.query(await readFile(join(migrationsPath, file), "utf8"));
          await connection.query(`INSERT INTO ${schema}.unknownplanet_schema_migrations(version) VALUES ($1)`, [file]);
          await connection.query("COMMIT");
          console.log(`Applied ${file} to ${schemaName}`);
        } catch (error) {
          await connection.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally { connection.release(); }
      }
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", ["unknownplanet-schema-migrations", schemaName]).catch(() => undefined);
      lock.release();
    }
  }
} finally { await pool.end(); }
