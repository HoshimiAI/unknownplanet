import { expect, test } from "bun:test";
import { PostgresSqlStore } from "../dist/index.js";

test("commits a callback through a pooled PostgreSQL connection", async () => {
  const statements = [];
  let released = false;
  const connection = {
    query: async (text, values) => {
      statements.push([text, values]);
      return text.startsWith("SELECT") ? { rows: [{ value: values[0] }], rowCount: 1 } : { rows: [], rowCount: null };
    },
    release: () => { released = true; },
  };
  const store = new PostgresSqlStore({ query: connection.query, connect: async () => connection });
  const result = await store.transaction((transaction) => transaction.query({ text: "SELECT $1 AS value", values: ["planet"] }));
  expect(result.rows).toEqual([{ value: "planet" }]);
  expect(statements.map(([text]) => text)).toEqual(["BEGIN", "SELECT $1 AS value", "COMMIT"]);
  expect(released).toBe(true);
});

test("rolls back and releases a failed transaction", async () => {
  const statements = [];
  let released = false;
  const connection = {
    query: async (text) => { statements.push(text); return { rows: [], rowCount: null }; },
    release: () => { released = true; },
  };
  const store = new PostgresSqlStore({ query: connection.query, connect: async () => connection });
  await expect(store.transaction(async () => { throw new Error("stop"); })).rejects.toThrow("stop");
  expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
  expect(released).toBe(true);
});
