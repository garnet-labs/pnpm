#!/usr/bin/env bash
# One `pnpm ping` with `proxy=false` in the project .npmrc while the proxy
# environment variables point at a local forward proxy. See README.md.
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="${PNPM_BIN:?set PNPM_BIN to the freshly built pnpm binary}"
work="${RUNNER_TEMP:-$(mktemp -d)}/proxy-routing"
rm -rf "$work"
mkdir -p "$work/project"

export PROXY_PORT=3128
export PROXY_LOG="$work/proxy.log"
node "$fixture_dir/proxy.mjs" &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  (echo > /dev/tcp/127.0.0.1/$PROXY_PORT) 2>/dev/null && break
  sleep 0.1
done

cp "$fixture_dir/project.npmrc" "$work/project/.npmrc"
cd "$work/project"
set +e
env -u NO_PROXY -u no_proxy \
  HTTP_PROXY="http://127.0.0.1:$PROXY_PORT" http_proxy="http://127.0.0.1:$PROXY_PORT" \
  HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT" https_proxy="http://127.0.0.1:$PROXY_PORT" \
  "$bin" ping --registry https://registry.npmjs.org/
status=$?
set -e
echo "pnpm ping exit status: $status"
echo "requests seen by the local proxy:"
cat "$PROXY_LOG"
echo "(end of proxy log)"
