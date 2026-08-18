# PgForge

A production-grade, self-hostable **PostgreSQL management platform**. Connect any number of PostgreSQL servers and manage schemas, data, SQL, backups, roles and monitoring from one fast, minimal web interface.

Interface languages: 🇺🇿 Uzbek (default) · 🇷🇺 Russian · 🇬🇧 English — with dark and light themes.

## Capabilities

- **Connections** — unlimited PostgreSQL servers; credentials encrypted at rest (AES-256-GCM); per-connection read-only mode; connectivity testing.
- **Explorer** — databases, schemas, tables, views, materialized views, functions, procedures, sequences, indexes, triggers, constraints; reconstructed DDL; guarded drop/truncate (type-the-name confirmation, CASCADE opt-in).
- **Data browser** — pagination, typed filters, sorting, full-text search across text columns, inline cell editing, row insert/edit dialogs, multi-row delete (primary-key safe), CSV/JSON export streamed via server cursors.
- **SQL editor** — CodeMirror 6 with schema-aware autocomplete, multiple tabs (persisted), multi-statement scripts (atomic), row-capped results via server-side cursors, cancellation (`pg_cancel_backend`), `EXPLAIN` plans, per-user query history, execution statistics.
- **Backups** — native `pg_dump`/`pg_restore`/`psql`; custom/plain/tar formats; schema-only/data-only scopes; live job logs; downloads; restore into any registered server; restore from uploaded files; cron-scheduled backups with retention pruning; direct server-to-server migration (`pg_dump | pg_restore` streaming).
- **Monitoring** — database statistics, cache hit ratio, active sessions with cancel/terminate, lock inspection with blocking PIDs, slow queries (`pg_stat_statements` when available), per-table statistics (vacuum/analyze, dead tuples, scans).
- **Roles** — PostgreSQL role management (attributes, passwords, memberships), table privilege grants/revokes.
- **ER diagram** — foreign-key graph per schema with draggable tables, pan/zoom.
- **Platform access control** — admin/editor/viewer roles; viewers get read-only SQL enforced by `READ ONLY` transactions server-side.
- **Audit log** — every state-changing action recorded with actor, target, connection, details and IP.

## Architecture

npm monorepo, Clean Architecture, strict TypeScript end to end.

```
shared/   Typed API contract (DTOs) imported by both sides — single source of truth
server/   Fastify 5 API + job engine
  src/core/      Pure domain: config, crypto, errors, identifier quoting, SQL script lexer
  src/infra/     Adapters: SQLite metadata store (node:sqlite), PG pool manager, job manager
  src/modules/   Feature verticals (auth, connections, inspector, data, sql, backup,
                 monitor, pgroles, erd, audit) — each: routes → service → repository
  src/index.ts   Composition root: every dependency wired exactly once
web/      React 18 + Vite SPA
  src/components/  Design system (hand-built, CSS custom properties, dark/light)
  src/features/    One directory per page/feature
  src/i18n/        uz / ru / en catalogs (typed against the English catalog)
```

Key decisions:

- **Metadata store** is Node's built-in `node:sqlite` — zero native dependencies, WAL mode, versioned migrations. Application data (users, sessions, connections, history, jobs, backups, schedules, audit) never touches your PostgreSQL servers.
- **Secrets**: one `APP_SECRET`; HKDF derives independent keys for JWT signing and credential encryption. Passwords hashed with scrypt (`timingSafeEqual` verification). Refresh tokens are single-use, rotated, stored hashed.
- **SQL safety**: identifiers can never be parameterized, so every dynamic identifier passes through one quoting chokepoint; all values are parameterized; filter/sort columns are validated against the live table definition. Read-only enforcement is transactional (`BEGIN READ ONLY`), not just keyword filtering.
- **Backups are jobs**: spawned tools stream logs into an in-memory ring buffer (polled live by the UI) and persist terminal state; jobs orphaned by a restart are marked failed; server shutdown kills child processes.

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

Notes for deployment:

- Set a permanent `APP_SECRET`, or rely on the auto-generated `DATA_DIR/secret.key` — losing the secret invalidates sessions **and stored connection credentials** (the UI will then ask you to re-enter connection passwords).
- `DATA_DIR` (default `./data`) holds the SQLite store, the secret file and backup artifacts; back it up and mount it on persistent storage.
- Terminate TLS in front of the app (reverse proxy); cookies are `Secure` when `NODE_ENV=production`.

## Verification

- `npm run typecheck` — strict TS across all workspaces
- `npm test` — unit tests for crypto, the SQL script lexer, and the filter builder
- An end-to-end pass against a live PostgreSQL 18 exercised auth, catalog, SQL, data CRUD, ERD, monitoring, roles, audit, and a backup → restore round-trip with data verification.
