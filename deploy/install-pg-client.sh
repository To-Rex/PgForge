#!/bin/sh
# Installs PostgreSQL 18 client tools from the official PGDG repository into
# the Railpack build image. Kept as a real script (not inline JSON shell) so
# quoting survives Railpack's command parser and every line is logged.
set -eux

PG_MAJOR="${PG_MAJOR:-18}"
. /etc/os-release
CODENAME="${VERSION_CODENAME:?cannot detect Debian codename}"

KEY=/tmp/pgdg.asc
LIST=/tmp/pgdg.list

curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$KEY"

# Debian's own suites first (dependency resolution), then PGDG.
{
  echo "deb http://deb.debian.org/debian ${CODENAME} main"
  echo "deb http://deb.debian.org/debian ${CODENAME}-updates main"
  echo "deb http://deb.debian.org/debian-security ${CODENAME}-security main"
  echo "deb [signed-by=${KEY}] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main"
} > "$LIST"
cat "$LIST"

APT="apt-get -o Dir::Etc::SourceList=${LIST} -o Dir::Etc::SourceParts=/dev/null"
$APT update
DEBIAN_FRONTEND=noninteractive $APT install -y --no-install-recommends "postgresql-client-${PG_MAJOR}"

# Make the exported tree self-contained: bundle libpq next to the binaries.
cp -a /usr/lib/x86_64-linux-gnu/libpq.so.5* "/usr/lib/postgresql/${PG_MAJOR}/lib/"

"/usr/lib/postgresql/${PG_MAJOR}/bin/pg_dump" --version
"/usr/lib/postgresql/${PG_MAJOR}/bin/pg_restore" --version
ls -la "/usr/lib/postgresql/${PG_MAJOR}/bin" "/usr/lib/postgresql/${PG_MAJOR}/lib" | head -40

rm -rf /var/lib/apt/lists/*
