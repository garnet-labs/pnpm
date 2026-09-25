#!/usr/bin/env bash
# Replay the two-project side-effects-cache scenario with a released pnpm.
#
# Three fresh git repositories install the same dependency whose postinstall
# writes .git/hooks/pre-commit into the consuming project. All three share one
# store, so the first install seeds the side-effects cache and the second is
# answered from it. The third opts out of the cache the documented way, and
# the second is then rebuilt explicitly.
#
#   project-a          cold store, sideEffectsCache default   script runs,  hook present
#   project-b          warm store, sideEffectsCache default   cache hit,    hook missing
#   project-c          warm store, sideEffectsCache: false    script runs,  hook present
#   project-b rebuild  pnpm rebuild in project-b              script runs,  hook present
#
# Usage: replay.sh <work-dir> <results.json>
# Writes one JSON object per step to <results.json> and prints a table.
# Exits non-zero if any step's outcome differs from the table above. A pnpm
# command that fails is recorded as an unexpected step and the replay goes on,
# so the table and every step's log survive the failure.
set -euo pipefail

work_dir=$1
results=$2
fixture_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
store_dir="$work_dir/store"
cache_dir="$work_dir/cache"
mkdir -p "$work_dir"
: > "$results"
failures=0

prepare() {
  local project=$1 side_effects_cache=$2
  local dir="$work_dir/$project"
  mkdir -p "$dir"
  cp "$fixture_dir/package.json" "$dir/package.json"
  git init -q "$dir"
  {
    echo "storeDir: $store_dir"
    echo "cacheDir: $cache_dir"
    echo "enableGlobalVirtualStore: false"
    echo "allowBuilds:"
    echo "  simple-git-hooks: true"
    if [ "$side_effects_cache" = false ]; then
      echo "sideEffectsCache: false"
    fi
  } > "$dir/pnpm-workspace.yaml"
}

replay() {
  local step=$1 project=$2 command=$3 side_effects_cache=$4 expect_script=$5
  local dir="$work_dir/$project"
  local log="$work_dir/$step.log"
  local exit_code=0
  (cd "$dir" && pnpm "$command" --reporter=append-only) > "$log" 2>&1 || exit_code=$?
  local hook=false postinstall_ran=false
  [ -f "$dir/.git/hooks/pre-commit" ] && hook=true
  grep -q 'simple-git-hooks postinstall' "$log" && postinstall_ran=true

  local verdict=expected
  if [ "$exit_code" -ne 0 ] || [ "$postinstall_ran" != "$expect_script" ] || [ "$hook" != "$expect_script" ]; then
    verdict=unexpected
    failures=$((failures + 1))
  fi
  printf '%-18s pnpm %-8s sideEffectsCache=%-7s postinstall_ran=%-5s hook_present=%-5s exit=%-3s %s\n' \
    "$step" "$command" "$side_effects_cache" "$postinstall_ran" "$hook" "$exit_code" "$verdict"
  printf '{"step":"%s","project":"%s","command":"%s","side_effects_cache":"%s","postinstall_ran":%s,"hook_present":%s,"exit_code":%s,"expected":%s,"verdict":"%s"}\n' \
    "$step" "$project" "$command" "$side_effects_cache" "$postinstall_ran" "$hook" "$exit_code" "$expect_script" "$verdict" >> "$results"
}

echo "pnpm $(pnpm --version) · node $(node --version)"
prepare project-a default
prepare project-b default
prepare project-c false
replay project-a         project-a install default true
replay project-b         project-b install default false
replay project-c         project-c install false   true
replay project-b-rebuild project-b rebuild default true

exit "$failures"
