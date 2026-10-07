#!/usr/bin/env bash
# Corepack-style first run of the pnpm entry point. See README.md.
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$fixture_dir/../.." && pwd)"
work="${RUNNER_TEMP:-$(mktemp -d)}/bootstrap-routing"
rm -rf "$work"
mkdir -p "$work/wrapper/bin" "$work/wrapper/dist/node_modules/get-pnpm" "$work/project"

expected=$(grep -A1 '^  get-pnpm@0.0.5:$' "$repo_dir/pnpm-lock.yaml" | sed -n 's/.*integrity: \(sha512-[^}]*\)}.*/\1/p' | head -n1)
actual="sha512-$(openssl dgst -sha512 -binary "$fixture_dir/get-pnpm-0.0.5.tgz" | base64 -w0)"
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "get-pnpm tarball does not match the lockfile integrity"; exit 1; }
tar -xzf "$fixture_dir/get-pnpm-0.0.5.tgz" -C "$work/wrapper/dist/node_modules/get-pnpm" --strip-components=1

for file in native-binary.mjs bin/pnpm.mjs bin/pnpx.mjs; do
  cp "$repo_dir/pnpm/npm/pnpm/$file" "$work/wrapper/$file"
done
echo '{"name":"pnpm","version":"12.0.0"}' > "$work/wrapper/package.json"
cp "$fixture_dir/project.npmrc" "$work/project/.npmrc"
: > "$work/empty.npmrc"

cd "$work/project"
out=$(env -u COREPACK_NPM_REGISTRY -u COREPACK_NPM_TOKEN -u COREPACK_INTEGRITY_KEYS \
  -u npm_config_registry -u NPM_CONFIG_REGISTRY -u pnpm_config_registry -u PNPM_CONFIG_REGISTRY \
  npm_config_userconfig="$work/empty.npmrc" \
  node "$work/wrapper/bin/pnpm.mjs" --version)
echo "pnpm --version: $out"
[ "$out" = "12.0.0" ]
sha256sum "$work/wrapper/pnpm-native"
