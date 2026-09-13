# PgForge

A production-grade, self-hostable **PostgreSQL management platform**. Connect any number of PostgreSQL servers and manage schemas, data, SQL, backups, roles and monitoring from one fast, minimal web interface.

Interface languages: 🇺🇿 Uzbek (default) · 🇷🇺 Russian · 🇬🇧 English — with dark and light themes.

## Capabilities

- **Connections** — unlimited PostgreSQL servers; credentials encrypted at rest (AES-256-GCM); per-connection read-only mode; connectivity testing.
- **Explorer** — one tree spanning the whole server: every database on the connection is a root node that expands into its schemas, tables, views, materialized views, functions, procedures, sequences, indexes, triggers and constraints. Switching database is a click in the tree (the header switcher still works); reconstructed DDL; guarded drop/truncate (type-the-name confirmation, CASCADE opt-in); create/drop database from the tree itself.
- **Data browser** — pagination, typed filters, sorting, full-text search across text columns, inline cell editing, row insert/edit dialogs, multi-row delete (primary-key safe), CSV/JSON export streamed via server cursors. Foreign-key values are navigable: one click opens the referenced table filtered to the parent row (composite keys included), and the filtered view is a shareable URL.
- **SQL editor** — CodeMirror 6 with schema-aware autocomplete, multiple tabs (persisted), multi-statement scripts (atomic), row-capped results via server-side cursors, cancellation (`pg_cancel_backend`), per-user query history, execution statistics.
- **Query plans** — `EXPLAIN` and `EXPLAIN ANALYZE` rendered as a plan tree with per-node exclusive time, estimated-vs-actual row counts, and flags for row misestimates, wasteful filters, large sequential scans and sorts that spilled to disk. `ANALYZE` on a writing statement asks first, because it really runs it.
- **Saved queries** — named, described, editable SQL snippets, optionally pinned to one connection or shared with the whole team. Unlike history, they are never pruned.
- **Backups** — native `pg_dump`/`pg_restore`/`psql`; custom/plain/tar formats; schema-only/data-only scopes; live job logs; downloads; restore into any registered server; restore from uploaded files; cron-scheduled backups with retention pruning; direct server-to-server migration (`pg_dump | pg_restore` streaming).
- **Monitoring** — database statistics, cache hit ratio, active sessions with cancel/terminate, lock inspection with blocking PIDs, slow queries (`pg_stat_statements` when available), per-table statistics (vacuum/analyze, dead tuples, scans).
- **Index advice** — findings derived from the statistics collector and the catalog: foreign keys with no supporting index, tables read by sequential scan far more than by index, unused and duplicate indexes, dead-tuple build-up, never-analyzed tables. Every finding shows the numbers behind it and hands over the exact statement — advice, never automation.
- **Command palette** — ⌘K/Ctrl+K finds any table, view, column, function, sequence or schema, in the current database or across every database on the connection, and jumps straight to it.
- **Roles** — PostgreSQL role management (attributes, passwords, memberships), table privilege grants/revokes.
- **ER diagram** — foreign-key graph per schema with draggable tables, pan/zoom.
- **Platform access control** — admin/editor/viewer roles; viewers get read-only SQL enforced by `READ ONLY` transactions server-side.
- **Audit log** — every state-changing action recorded with actor, target, connection, details and IP.
- **Durable platform state** — PgForge's own data normally lives in a SQLite file under `DATA_DIR`. Point `METADATA_URL` at a PostgreSQL database and that file is mirrored there: restored on boot, uploaded after every write. A deploy that replaces the container filesystem no longer resets the platform to first-run. Settings → Application database takes host, port, database, user, password and SSL mode as fields, assembles the connection string server-side, tests it, seeds it from the running store and writes the setting for you.

## Architecture

npm monorepo, Clean Architecture, strict TypeScript end to end.

```
shared/   Typed API contract (DTOs) imported by both sides — single source of truth
server/   Fastify 5 API + job engine
  src/core/      Pure domain: config, crypto, errors, identifier quoting, SQL script lexer
  src/infra/     Adapters: SQLite metadata store (node:sqlite), PG pool manager, job manager
  src/modules/   Feature verticals (auth, connections, inspector, data, sql, backup,
                 monitor, pgroles, erd, search, audit) — each: routes → service → repository
  src/index.ts   Composition root: every dependency wired exactly once
web/      React 18 + Vite SPA
  src/components/  Design system (hand-built, CSS custom properties, dark/light)
  src/features/    One directory per page/feature
  src/lib/         Pure helpers (URL filter codec, SQL classification, formatting)
  src/i18n/        uz / ru / en catalogs (typed against the English catalog)
```

Key decisions:

- **Metadata store** is Node's built-in `node:sqlite` — zero native dependencies, WAL mode, versioned migrations. Application data (users, sessions, connections, history, jobs, backups, schedules, audit) never touches the PostgreSQL servers you manage.
- **Durability without a rewrite**: with `METADATA_URL` set, that same SQLite image is stored whole in one PostgreSQL row rather than mirrored table-by-table. The application keeps running on SQLite, so schema, migrations and behaviour cannot drift between backends, and the synchronous store API stays synchronous — no repository or the connection resolver had to become async. The trade-offs are stated where they matter: the snapshot is opaque to SQL, exactly one server may write it, and replication is asynchronous (a crash can lose the last second of writes).
- **Secrets**: one `APP_SECRET`; HKDF derives independent keys for JWT signing and credential encryption. Passwords hashed with scrypt (`timingSafeEqual` verification). Refresh tokens are single-use, rotated, stored hashed.
- **SQL safety**: identifiers can never be parameterized, so every dynamic identifier passes through one quoting chokepoint; all values are parameterized; filter/sort columns are validated against the live table definition. Read-only enforcement is transactional (`BEGIN READ ONLY`), not just keyword filtering.
- **Backups are jobs**: spawned tools stream logs into an in-memory ring buffer (polled live by the UI) and persist terminal state; jobs orphaned by a restart are marked failed; server shutdown kills child processes.

## Persistence

`DATA_DIR` holds three things: the SQLite metadata store, the auto-generated `secret.key` (when `APP_SECRET` is unset), and backup artifacts. On a platform that rebuilds the container each deploy, anything not on a persistent volume is lost — which is why a fresh deploy can come back asking for first-run setup.

Two independent fixes, and you want both:

1. **`APP_SECRET`** — set it explicitly in the platform's environment editor. It is the HKDF root for JWT signing *and* for encrypting stored connection passwords, so losing it invalidates sessions and makes saved connection credentials unreadable. It cannot live in the metadata database, because it is the key protecting that database.
2. **`METADATA_URL`** — a PostgreSQL database, hosted outside the container and separate from the servers you manage, that holds the metadata store. Set it and the platform survives redeploys with no volume at all.

Backup *files* are not covered by `METADATA_URL`; they remain in `DATA_DIR` and still need a mounted volume if you want to keep them.

Settings → Application database is the intended route: fill in host, port, database, user, password and SSL mode, press Test, then Save. The server assembles and percent-encodes the DSN, so a password containing `@`, `:` or `/` needs no special handling. The equivalent environment variable is:

```bash
METADATA_URL=postgresql://pgforge:password@db.example.com:5432/pgforge?sslmode=require
```

The database must exist, or the role must hold `CREATEDB` and the "create the database" option must be enabled — most managed providers grant neither and hand you a ready-made database instead. On boot the stored snapshot is restored before the store opens; any local file it replaces is copied to `pgforge.db.local-<timestamp>.bak` first. If the database is unreachable the server refuses to start rather than silently falling back to ephemeral SQLite.

## Requirements

- Node.js ≥ 22.5 (uses built-in `node:sqlite`)
- PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`) on `PATH` for backup features — everything else works without them

## Development

```bash
npm install
npm run dev:server   # API on :7070 (tsx watch)
npm run dev:web      # Vite on :5173, proxies /api → :7070
```

Open http://localhost:5173 — the first run asks you to create the administrator account.

## Production

```bash
npm install
npm run build        # server → server/dist, web → web/dist
APP_SECRET="$(openssl rand -base64 48)" npm start
```

The server serves the built SPA and the API from one port (default `7070`). See `.env.example` for all settings (`PORT`, `DATA_DIR`, SQL timeouts and row caps, tool paths, CORS origins).

### Docker / Dokploy

A production `Dockerfile` is included (Node 22 + PostgreSQL 18 client tools from the official PGDG repository, so `pg_dump` can back up servers up to PostgreSQL 18). In Dokploy choose the **Dockerfile** build type, set the environment variables from `.env.example` (`APP_SECRET`, `PORT`, SMTP, …) and mount a persistent volume on **`/data`** — that is where the SQLite store, the secret file and all backup files live.

```bash
docker build -t pgforge .
docker run -d -p 7070:7070 -v pgforge-data:/data -e APP_SECRET="$(openssl rand -base64 48)" pgforge
```

Notes for deployment:

- Set a permanent `APP_SECRET`, or rely on the auto-generated `DATA_DIR/secret.key` — losing the secret invalidates sessions **and stored connection credentials** (the UI will then ask you to re-enter connection passwords).
- `DATA_DIR` (default `./data`) holds the SQLite store, the secret file and backup artifacts; back it up and mount it on persistent storage.
- Terminate TLS in front of the app (reverse proxy); cookies are `Secure` when `NODE_ENV=production`.

## Verification

- `npm run typecheck` — strict TS across all workspaces
- `npm test` — unit tests across both workspaces (170): server-side crypto, the SQL script lexer, the filter builder, CSV parsing and Telegram delivery; web-side URL filter codec, SQL read/write classification, `EXPLAIN` plan parsing, cron building and formatting; plus the metadata snapshot/restore round-trip, DSN assembly/parsing (escaping, IPv6, defaults) and the `.env` reader/writer that back the PostgreSQL storage mode. Pure modules only — no DOM, so the suite stays fast.
- An end-to-end pass against a live PostgreSQL 18 exercised auth, catalog, SQL, data CRUD, ERD, monitoring, roles, audit, and a backup → restore round-trip with data verification.
