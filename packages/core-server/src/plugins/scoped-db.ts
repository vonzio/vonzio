// Per-plugin scoped Drizzle handle for `db.scoped` plugins. Intercepts the
// table-taking builder methods and refuses any reference outside the plugin's
// schema prefix; refuses raw SQL entirely.
//
// FRAMING (docs/PLUGIN_LOADER_SPEC.md §9): hygiene against honest mistakes via
// the supplied `ctx.core.db` reference, NOT a containment boundary. A plugin
// can `require('@vonzio/core-server/db')` or open its own pool from
// DATABASE_URL. The wrapper catches the typo case (builder pointed at the
// wrong table) and makes cross-schema attempts visible.
//
// HONEST SCOPE — what this catches:
//   - direct table refs in .from / .insert / .update / .delete and the five
//     joins, using drizzle's canonical getTableName (not the JS var name)
//   - CTEs built through THIS handle (their .from is validated at build time)
//   - raw .execute / .transaction / .$client (refused outright)
// What it does NOT catch (documented gaps; no in-repo db.scoped consumer —
// corpus-validated only, deviation #8):
//   - sql`` fragments embedded in .where()/.select() referencing other tables
//   - subqueries/CTEs built through a DIFFERENT (unwrapped) handle
//   - deep (>1 level) subquery composition

import { getTableName, is, Subquery, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { DbScopeViolationError } from "@vonzio/plugin-api";

/** Builder methods whose FIRST argument is a table/subquery to validate. */
const TABLE_ARG_METHODS = new Set([
  "from",
  "into",
  "leftJoin",
  "rightJoin",
  "innerJoin",
  "fullJoin",
  "crossJoin",
]);

/** Top-level db methods that take a table as their first argument. */
const DB_TABLE_METHODS = new Set(["insert", "update", "delete"]);

/** Top-level db methods that begin a builder chain (table specified later). */
const DB_BUILDER_METHODS = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "with",
  "$with",
]);

/** Raw-SQL / escape-hatch surfaces refused for db.scoped plugins. */
const REFUSED_DB_KEYS = new Set(["execute", "transaction", "$client", "session"]);

interface ScopeCtx {
  plugin: string;
  schemaPrefix: string;
}

/** Does a drizzle table belong to the plugin's scope? A table is in-scope if
 *  its canonical name starts with `${prefix}_`, OR it lives in a Postgres
 *  schema literally named the prefix. */
function tableInScope(table: Table, ctx: ScopeCtx): boolean {
  const name = getTableName(table);
  if (name.startsWith(`${ctx.schemaPrefix}_`)) return true;
  try {
    const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
    if (cfg.schema && cfg.schema === ctx.schemaPrefix) return true;
  } catch {
    // not a pg table object; fall through to the name check result
  }
  return false;
}

/** Validate one table/subquery argument reaching a builder method. */
function assertArgInScope(arg: unknown, ctx: ScopeCtx): void {
  if (is(arg, Table)) {
    if (!tableInScope(arg, ctx)) {
      throw new DbScopeViolationError({
        plugin: ctx.plugin,
        schemaPrefix: ctx.schemaPrefix,
        offending: getTableName(arg),
      });
    }
    return;
  }
  if (is(arg, Subquery)) {
    // A subquery built through THIS wrapped handle had its own .from validated
    // at build time. One built through a raw handle is opaque to us — a
    // documented gap (§9). Nothing to assert here without re-introspecting
    // drizzle internals.
    return;
  }
  // Plain objects (alias maps), SQL fragments, primitives: not a table ref we
  // can scope. Pass through (documented gap for raw sql`` table expressions).
}

/** Wrap a builder so chained table-taking calls stay validated. */
function wrapBuilder(builder: unknown, ctx: ScopeCtx): unknown {
  if (builder === null || (typeof builder !== "object" && typeof builder !== "function")) {
    return builder;
  }
  return new Proxy(builder as object, {
    get(target, key, recv) {
      const value = Reflect.get(target, key, recv);
      if (typeof value !== "function") return value;
      const method = String(key);
      return (...args: unknown[]) => {
        if (TABLE_ARG_METHODS.has(method)) {
          assertArgInScope(args[0], ctx);
        }
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        // Keep wrapping the fluent chain (then/catch/finally for awaited
        // execution flow through unchanged objects, which are not builders).
        if (method === "then" || method === "catch" || method === "finally") {
          return result;
        }
        return wrapBuilder(result, ctx);
      };
    },
  });
}

/**
 * Wrap a raw Drizzle handle into a scoped one for a `db.scoped` plugin.
 * `rawDb` is the same handle built-ins get; the returned Proxy refuses raw SQL
 * and out-of-scope table references.
 */
export function scopedDb<T extends object>(rawDb: T, plugin: string, schemaPrefix: string): T {
  const ctx: ScopeCtx = { plugin, schemaPrefix };
  return new Proxy(rawDb, {
    get(target, key, recv) {
      const k = String(key);
      if (REFUSED_DB_KEYS.has(k)) {
        return () => {
          throw new DbScopeViolationError({
            plugin,
            schemaPrefix,
            offending: `db.${k} (raw SQL refused for db.scoped)`,
          });
        };
      }
      const value = Reflect.get(target, key, recv);
      if (typeof value !== "function") return value;
      if (DB_TABLE_METHODS.has(k)) {
        return (...args: unknown[]) => {
          assertArgInScope(args[0], ctx);
          return wrapBuilder((value as (...a: unknown[]) => unknown).apply(target, args), ctx);
        };
      }
      if (DB_BUILDER_METHODS.has(k)) {
        return (...args: unknown[]) =>
          wrapBuilder((value as (...a: unknown[]) => unknown).apply(target, args), ctx);
      }
      return value;
    },
  }) as T;
}

// ── Migration prefix enforcement (SQL-lexer based) ──────────────────────────

type Tok = { type: "word" | "punct"; value: string };

/**
 * Tokenize SQL, skipping line/block comments and treating string literals +
 * quoted identifiers as opaque single tokens. Comments and string CONTENTS
 * are not searched, so a table name mentioned inside a comment or string does
 * not register as a DDL target (the regex approach this replaces could not do
 * that — §9).
 */
function lexSql(sql: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = sql.length;
  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      toks.push({ type: "word", value: "''string''" });
      continue;
    }
    if (c === "$") {
      // Postgres dollar-quoting: $$...$$ or $tag$...$tag$. Treat the whole
      // quoted body as opaque so SQL keywords inside a function/DO body are not
      // mistaken for live DDL. (`$1` positional params don't match — no closing
      // delimiter — and fall through to the word lexer.)
      const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
      if (m) {
        const delim = m[0];
        const end = sql.indexOf(delim, i + delim.length);
        i = end === -1 ? n : end + delim.length;
        toks.push({ type: "word", value: "''dollar''" });
        continue;
      }
    }
    if (c === '"') {
      // Quoted identifier: capture its inner text (it IS an identifier).
      i++;
      let id = "";
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { id += '"'; i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        id += sql[i++];
      }
      toks.push({ type: "word", value: id });
      continue;
    }
    if (isWord(c)) {
      let w = "";
      while (i < n && isWord(sql[i])) w += sql[i++];
      toks.push({ type: "word", value: w });
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    toks.push({ type: "punct", value: c });
    i++;
  }
  return toks;
}

const DDL_VERBS = new Set(["create", "alter", "drop"]);
// Object-type + modifier words we skip to reach the object identifier.
const SKIP_WORDS = new Set([
  "table", "index", "unique", "materialized", "view", "sequence", "type",
  "trigger", "function", "if", "not", "exists", "concurrently", "or", "replace",
  "temporary", "temp", "global", "local",
]);

/**
 * Check that every DDL object identifier in a plugin migration starts with
 * `${schemaPrefix}_`. Returns the first offending identifier, or null if all
 * pass. Strips a leading `schemaPrefix.` schema qualifier before the check
 * (a table created in a pg schema named the prefix is in-scope).
 */
export function checkMigrationPrefix(sql: string, schemaPrefix: string): string | null {
  const toks = lexSql(sql);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type !== "word") continue;
    const lower = toks[i].value.toLowerCase();
    // Reject dynamic SQL: a DO block or EXECUTE can create arbitrary,
    // unprefixed objects at apply time that a static lexer cannot see. For a
    // db.scoped plugin (no raw SQL anyway) these have no legitimate use.
    if (lower === "do" || lower === "execute") {
      return toks[i].value;
    }
    if (!DDL_VERBS.has(lower)) continue;
    // Advance past object-type + modifier keywords to the object identifier.
    let j = i + 1;
    while (j < toks.length && toks[j].type === "word" && SKIP_WORDS.has(toks[j].value.toLowerCase())) {
      j++;
    }
    if (j >= toks.length || toks[j].type !== "word") continue;
    let ident = toks[j].value;
    // schema-qualified: schema.object → check object against the prefix schema.
    if (toks[j + 1]?.value === "." && toks[j + 2]?.type === "word") {
      const schema = ident.toLowerCase();
      const obj = toks[j + 2].value;
      if (schema === schemaPrefix.toLowerCase()) continue; // in the plugin schema
      ident = obj;
    }
    if (!ident.toLowerCase().startsWith(`${schemaPrefix.toLowerCase()}_`)) {
      return ident;
    }
  }
  return null;
}
