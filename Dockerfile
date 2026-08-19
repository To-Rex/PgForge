# ── PgForge — production image ───────────────────────────────────────────────
# Two stages: build the monorepo, then ship a lean runtime with PostgreSQL 18
# client tools from the official PGDG repository (pg_dump must be >= the
# newest server it backs up; the distro's postgresql-client is too old).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# PostgreSQL 18 client tools (pg_dump / pg_restore / psql) from PGDG.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/*

# Production dependencies only.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force

# Built artifacts (server bundle + static web app) and the shared sources the
# server bundle may reference at runtime.
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/shared shared

# Persistent data (SQLite store, secret.key, backup files) lives here —
# mount a volume on /data in Dokploy.
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 7070
CMD ["node", "server/dist/index.js"]
