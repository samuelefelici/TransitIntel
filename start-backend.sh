#!/bin/bash
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"

# Load environment variables from .env file
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env"
  set +a
fi

# Prima lo schema (le migrazioni di lib/db/migrations), poi l'API
node "$SCRIPT_DIR/lib/db/scripts/migra.mjs" || exit 1

cd "$SCRIPT_DIR/artifacts/api-server"
exec npx tsx ./src/index.ts
