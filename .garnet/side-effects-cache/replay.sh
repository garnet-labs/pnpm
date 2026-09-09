#!/usr/bin/env bash
# Replay the two-project side-effects-cache scenario with a released pnpm.
#
# Two fresh git repositories install the same dependency whose postinstall
# writes .git/hooks/pre-commit into the consuming project. Both share one
# store, so the first install seeds the side-effects cache and the second is
# answered from it.
#
#   project-a  cold store, sideEffectsCache default   script runs,  hook present
#   project-b  warm store, sideEffectsCache default   cache hit,    hook missing
#
# Usage: replay.sh <work-dir> <results.json>
# Writes one JSON object per project to <results.json> and prints a table.
# Exits non-zero if any project's outcome differs from the table above.
set -euo pipefail

work_dir=$1
results=$2
fixture_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
store_dir="$work_dir/store"
cache_dir="$work_dir/cache"
mkdir -p "$work_dir"
: > "$results"
failures=0

replay() {
  local project=$1 side_effects_cache=$2 expect_script=$3
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

  local log="$work_dir/$project.log"
  (cd "$dir" && pnpm install --reporter=append-only) > "$log" 2>&1
  local hook=false postinstall_ran=false
  [ -f "$dir/.git/hooks/pre-commit" ] && hook=true
  grep -q 'simple-git-hooks postinstall' "$log" && postinstall_ran=true

  local verdict=expected
  if [ "$postinstall_ran" != "$expect_script" ] || [ "$hook" != "$expect_script" ]; then
    verdict=unexpected
    failures=$((failures + 1))
  fi
  printf '%-10s sideEffectsCache=%-7s postinstall_ran=%-5s hook_present=%-5s %s\n' \
    "$project" "$side_effects_cache" "$postinstall_ran" "$hook" "$verdict"
  printf '{"project":"%s","side_effects_cache":"%s","postinstall_ran":%s,"hook_present":%s,"expected":%s,"verdict":"%s"}\n' \
    "$project" "$side_effects_cache" "$postinstall_ran" "$hook" "$expect_script" "$verdict" >> "$results"
}

echo "pnpm $(pnpm --version) · node $(node --version)"
replay project-a default true
replay project-b default false

exit "$failures"
