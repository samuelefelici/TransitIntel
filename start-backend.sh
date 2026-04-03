#!/bin/bash
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"

# Load environment variables from .env file
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

cd "$SCRIPT_DIR/artifacts/api-server"
exec npx tsx ./src/index.ts
