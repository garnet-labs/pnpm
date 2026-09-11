#!/usr/bin/env bash
set -uo pipefail

mkdir -p "$RUNNER_TEMP/cargo-replay"
stdout_path="$RUNNER_TEMP/cargo-replay/install.stdout"
stderr_path="$RUNNER_TEMP/cargo-replay/install.stderr"
result_path="$RUNNER_TEMP/cargo-replay/native.json"

started_ns="$(date +%s%N)"
set +e
pnpm install --frozen-lockfile --filter pacquet >"$stdout_path" 2>"$stderr_path"
exit_code=$?
set -e
finished_ns="$(date +%s%N)"

marker="# >>> pnpm-managed cargo sources >>>"
marker_present=false
if grep -Fq "$marker" .cargo/config.toml; then
  marker_present=true
fi

crates_present=false
if test -d .pnpm/crates; then
  crates_present=true
fi

config_modified=false
if test -n "$(git status --porcelain -- .cargo/config.toml)"; then
  config_modified=true
fi

registry_entries=0
if test -d .pnpm/crates/crates-io; then
  registry_entries="$(find .pnpm/crates/crates-io -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
fi

git_entries=0
if test -d .pnpm/crates/git; then
  git_entries="$(find .pnpm/crates/git -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
fi

disk_bytes=0
if test -d .pnpm/crates; then
  disk_bytes="$(du -sb .pnpm/crates | cut -f1)"
fi

export EXIT_CODE="$exit_code"
export ELAPSED_MS="$(( (finished_ns - started_ns) / 1000000 ))"
export MARKER_PRESENT="$marker_present"
export CRATES_PRESENT="$crates_present"
export CONFIG_MODIFIED="$config_modified"
export REGISTRY_ENTRIES="$registry_entries"
export GIT_ENTRIES="$git_entries"
export DISK_BYTES="$disk_bytes"
export STDOUT_PATH="$stdout_path"
export STDERR_PATH="$stderr_path"
export RESULT_PATH="$result_path"

node <<'NODE'
const fs = require('node:fs')

const readTail = (path) => {
  const lines = fs.readFileSync(path, 'utf8').trimEnd().split('\n')
  return lines.slice(-20).join('\n')
}

const result = {
  schemaVersion: 'cargo-filter-replay/v1',
  sha: process.env.REPLAY_SHA,
  runId: process.env.GITHUB_RUN_ID,
  exitCode: Number(process.env.EXIT_CODE),
  elapsedMs: Number(process.env.ELAPSED_MS),
  cargoMarkerPresent: process.env.MARKER_PRESENT === 'true',
  cratesDirectoryPresent: process.env.CRATES_PRESENT === 'true',
  cargoConfigModified: process.env.CONFIG_MODIFIED === 'true',
  registryCrateEntries: Number(process.env.REGISTRY_ENTRIES),
  gitCrateEntries: Number(process.env.GIT_ENTRIES),
  cratesDiskBytes: Number(process.env.DISK_BYTES),
  stdoutTail: readTail(process.env.STDOUT_PATH),
  stderrTail: readTail(process.env.STDERR_PATH),
}

fs.writeFileSync(process.env.RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
NODE

exit 0
