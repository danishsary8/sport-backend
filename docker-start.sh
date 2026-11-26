#!/bin/sh
# Container start: apply migrations and seeds (both safe to repeat), then run the API.
set -e
node dist/db/migrate.js
node dist/db/seed/run.js
node dist/db/seed/importCatalog.js
exec node dist/server.js
