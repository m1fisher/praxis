#!/usr/bin/env bash
# Share praxis publicly via an ephemeral Cloudflare Tunnel, behind a password.
#
# Usage:
#   PRAXIS_AUTH_USER=friend PRAXIS_AUTH_PASSWORD='pick-a-password' ./scripts/share.sh
#
# Prints a https://<random>.trycloudflare.com URL. Share that URL + the login,
# and tell your friend they need their own Anthropic/OpenAI API key (BYOK).
# Ctrl+C to stop (also shuts the app down).
set -euo pipefail

: "${PRAXIS_AUTH_USER:?Set PRAXIS_AUTH_USER (the shared login username)}"
: "${PRAXIS_AUTH_PASSWORD:?Set PRAXIS_AUTH_PASSWORD (the shared login password)}"

command -v cloudflared >/dev/null 2>&1 || {
  echo "cloudflared is not installed. Install it first:  brew install cloudflared" >&2
  exit 1
}

PORT="${PORT:-8000}"
export PRAXIS_AUTH_USER PRAXIS_AUTH_PASSWORD

# Start the app (password gate active) in the background.
uv run uvicorn backend.main:app --port "$PORT" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

echo "Waiting for the app on http://localhost:$PORT ..."
for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done

echo
echo "-----------------------------------------------------------------------"
echo "Share the https://<...>.trycloudflare.com URL that appears below."
echo "Login:  $PRAXIS_AUTH_USER  /  (the password you set)"
echo "Your friend also needs their OWN Anthropic or OpenAI API key (BYOK)."
echo "-----------------------------------------------------------------------"
echo
cloudflared tunnel --url "http://localhost:$PORT"
