#!/usr/bin/env bash
# Verifies the evidence chain behind a Garnet Jibril release-gate run and writes
# one record of it. Each leg is one failure mode pnpm has hit; the ledger in
# .github/garnet-gate/FAILURE_LEDGER.md maps every past failure to the leg
# that now catches it. A new failure gets a ledger row and a leg here in the
# same change.
#
#   L1 startup            sensor active, status file ok, GitHub steps resolved
#   L2 profile            uploaded for this run/job/attempt
#   L3 workload           the workload step's destination attributed to that step
#   L4 App comment        finalized and bound to the PR head (pull_request only)
#   L5 permalink          public HTML and API links answer 200
#   L6 integration shape  pnpm's own workflow files: SHA pins, api_token path,
#                         no new permissions, macOS and Dependabot disclosure
#   L7 integration run    pnpm's own instrumented TS CI job for this head
#                         produced a profile
#   L8 reviewers          zizmor clean on touched workflows, no unresolved bot
#                         threads on .github/ paths
#   L9 timing             sensor start time and overhead against a baseline job
#   L10 coverage          how many CI cells are instrumented (disclosure only)
#
# Reads the reproduce and baseline job outputs from env, then asks the control
# plane and GitHub for what the sensor actually produced. Every leg is recorded
# with the exact identifiers a reader needs to re-check it.
#
# Outputs: $GITHUB_OUTPUT verdict=PASS|FAIL, /tmp/gate-comment.md,
# /tmp/gate-record.json, and a step-summary section.
set -uo pipefail

: "${GARNET_API_URL:=https://api.garnet.ai}"
: "${GARNET_APP_URL:=https://app.garnet.ai}"
: "${WORKLOAD_DESTINATION:=registry.npmjs.org}"
: "${WORKLOAD_STEP_NAME:=Workload with egress}"
: "${REPRODUCE_JOB:=reproduce}"
: "${POLL_SECONDS:=600}"
: "${INTEGRATION_WORKFLOW_NAME:=TS CI}"
: "${INTEGRATION_POLL_SECONDS:=1500}"
: "${OVERHEAD_BUDGET_SECONDS:=120}"
: "${LEDGER_PATH:=.github/garnet-gate/FAILURE_LEDGER.md}"

run_id="$GITHUB_RUN_ID"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
repo="$GITHUB_REPOSITORY"
merge_sha="$GITHUB_SHA"
action_ref="$(grep -oE 'garnet-org/action@[0-9a-f]{40}' .github/workflows/garnet-jibril-release-gate-job.yml | head -n1 | cut -d@ -f2)"
in_pr_context=false
[ "${EVENT_NAME:-}" = pull_request ] && [ -n "${PR_NUMBER:-}" ] && in_pr_context=true

fail_reasons=()
attention=()
note() { echo "::notice::$*"; }
leg_fail() { fail_reasons+=("$1"); echo "::error::$1"; }
leg_attention() { attention+=("$1"); echo "::warning::$1"; }
now() { date +%s; }

# --- L1 startup ----------------------------------------------------------------
startup_verdict="${STARTUP_VERDICT:-FAIL}"
[ "$startup_verdict" = PASS ] || leg_fail "L1 startup: ${STARTUP_REASON:-no verdict from reproduce job}"

# --- L2 profile uploaded -------------------------------------------------------
# The gate runs exactly one instrumented job per run, so the run-level lookup
# is exact; the job/attempt check keeps it that way if the shape changes.
fetch_profile() { # $1 run id -> prints http code, body in /tmp/profile-$1.json
  curl -sS -o "/tmp/profile-$1.json" -w '%{http_code}' \
    -H "X-Project-Token: $GARNET_API_TOKEN" \
    "$GARNET_API_URL/api/v1/profiles/$1" || echo 000
}
profile_json=""
profile_state="absent"
profile_wait_start=$(now)
profile_seconds=""
deadline=$((SECONDS + POLL_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  code="$(fetch_profile "$run_id")"
  if [ "$code" = 200 ]; then
    profile_json="$(cat "/tmp/profile-$run_id.json")"
    profile_seconds=$(( $(now) - profile_wait_start ))
    break
  fi
  # The control plane answers 403 (not 404) for a run it has no profile for yet.
  case "$code" in
    403|404) profile_state="absent (control plane HTTP $code)" ;;
    *) profile_state="control plane returned HTTP $code"; break ;;
  esac
  sleep 15
done

profile_id=""; profile_job=""; profile_attempt=""; profile_sha=""; profile_ref=""; profile_event=""
egress_names="[]"; workload_steps="[]"; peers=0; destinations=0
if [ -n "$profile_json" ]; then
  profile_id="$(jq -r '.id' <<<"$profile_json")"
  profile_job="$(jq -r '.job' <<<"$profile_json")"
  profile_attempt="$(jq -r '.runAttempt' <<<"$profile_json")"
  profile_sha="$(jq -r '.data.scenarios.github.sha // ""' <<<"$profile_json")"
  profile_ref="$(jq -r '.data.scenarios.github.ref // ""' <<<"$profile_json")"
  profile_event="$(jq -r '.data.scenarios.github.event_name // ""' <<<"$profile_json")"
  egress_names="$(jq -c '[.data.network.egress.peers[]? | .remote_names[]?] | unique' <<<"$profile_json")"
  workload_steps="$(jq -c --arg dest "$WORKLOAD_DESTINATION" \
    '[.data.network.egress.peers[]? | select(.remote_names[]? == $dest) | .proc_trees[]?.github_step | select(. != null)] | unique' <<<"$profile_json")"
  peers="$(jq '[.data.network.egress.peers[]?] | length' <<<"$profile_json")"
  destinations="$(jq '[.data.network.egress.peers[]? | .remote_names[]?] | unique | length' <<<"$profile_json")"
  if [ "$profile_job" = "$REPRODUCE_JOB" ] && [ "$profile_attempt" = "$run_attempt" ]; then
    profile_state="uploaded after ${profile_seconds}s"
  else
    profile_state="uploaded, but job=$profile_job attempt=$profile_attempt (expected $REPRODUCE_JOB/$run_attempt)"
    leg_fail "L2 profile: $profile_state"
  fi
else
  leg_fail "L2 profile: $profile_state after ${POLL_SECONDS}s (run $run_id)"
fi

# --- L3 workload recorded ------------------------------------------------------
# A workload step that itself failed (registry outage) leaves this leg untested
# rather than failing a gate whose sensor did its job.
workload_state="untested"
if [ "${WORKLOAD_OUTCOME:-}" != success ]; then
  workload_state="untested: workload step outcome=${WORKLOAD_OUTCOME:-unknown}"
elif [ -n "$profile_json" ]; then
  if jq -e --arg step "$WORKLOAD_STEP_NAME" 'map(select(contains($step))) | length > 0' <<<"$workload_steps" >/dev/null; then
    workload_state="recorded: $WORKLOAD_DESTINATION reached from step \"$WORKLOAD_STEP_NAME\""
  elif jq -e --arg dest "$WORKLOAD_DESTINATION" 'index($dest) != null' <<<"$egress_names" >/dev/null; then
    if [ "$workload_steps" = "[]" ]; then
      workload_state="destination present, but attributed to runner background, not to a step"
    else
      workload_state="destination present, but attributed to steps $workload_steps"
    fi
    leg_fail "L3 workload: $workload_state"
  else
    workload_state="not recorded: $WORKLOAD_DESTINATION absent from profile egress"
    leg_fail "L3 workload: $workload_state"
  fi
fi

# --- L4 App comment final ------------------------------------------------------
# Only refs/pull/N/merge runs get a Runtime Review comment; other triggers
# record this leg as not applicable. When the comment stays pending the leg
# names the cause it can see: no profile at all, or a merge commit GitHub
# regenerated after the sensor recorded (the control plane then treats the
# profile as stale and never finalizes).
comment_state="not applicable (event=${EVENT_NAME:-unknown})"
comment_url=""; summary_json=""; previous_sha=""; comparison=""; comment_seconds=""; current_merge_sha=""
if [ "$in_pr_context" = true ]; then
  comment_state="absent"
  comment_wait_start=$(now)
  deadline=$((SECONDS + POLL_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    comments="$(gh api "repos/$repo/issues/$PR_NUMBER/comments" --paginate 2>/dev/null | jq -s 'add // []')"
    match="$(jq -c --arg head "$PR_HEAD_SHA" '
      [.[] | select(.user.login == "garnet-runtime-review[bot]" or .user.login == "garnet-runtime-review-dev[bot]")
           | select((.body // "") | contains("<!-- garnet:commit " + $head + " -->"))] | last // empty' <<<"$comments")"
    if [ -n "$match" ]; then
      comment_url="$(jq -r '.html_url' <<<"$match")"
      if jq -e '.body | contains("<!-- garnet-control-plane-pr-comment:v1")' <<<"$match" >/dev/null; then
        comment_state="final after $(( $(now) - comment_wait_start ))s"
        comment_seconds=$(( $(now) - comment_wait_start ))
        summary_json="$(jq -r '.body | capture("<!-- garnet:summary (?<s>.*?) -->").s // ""' <<<"$match")"
        break
      fi
      comment_state="pending"
    fi
    sleep 15
  done
  current_merge_sha="$(gh api "repos/$repo/pulls/$PR_NUMBER" --jq '.merge_commit_sha // ""' 2>/dev/null || true)"
  if [ -z "$comment_seconds" ]; then
    cause="no visible cause"
    if [ -z "$profile_json" ]; then
      cause="no profile reached the control plane, so the placeholder has nothing to finalize from"
    elif [ -n "$current_merge_sha" ] && [ "$profile_sha" != "$current_merge_sha" ] && [ "$profile_sha" != "$PR_HEAD_SHA" ]; then
      cause="merge commit regenerated: sensor recorded ${profile_sha:0:7}, GitHub now reports ${current_merge_sha:0:7} for the same head; the control plane skips the profile as stale"
    fi
    leg_fail "L4 app comment: $comment_state after ${POLL_SECONDS}s for head ${PR_HEAD_SHA:0:7} · $cause"
  fi
  if [ -n "$summary_json" ]; then
    previous_sha="$(jq -r '.previous // ""' <<<"$summary_json")"
    head_parent="$(gh api "repos/$repo/commits/$PR_HEAD_SHA" --jq '.parents[0].sha' 2>/dev/null || true)"
    if [ "$previous_sha" = "$PR_BASE_SHA" ]; then
      comparison="PR base → head"
    elif [ "$previous_sha" = "$head_parent" ]; then
      comparison="immediate parent → head"
    elif [ -z "$previous_sha" ]; then
      comparison="no previous (first record on this PR)"
    else
      comparison="previous $previous_sha is neither PR base nor head parent"
    fi
  fi
fi

# --- L5 public permalink -------------------------------------------------------
permalink=""; permalink_html="untested"; permalink_api="untested"
if [ -n "$profile_id" ]; then
  permalink="$GARNET_APP_URL/public/runs/$run_id?profile=$profile_id"
  permalink_html="$(curl -sS -o /dev/null -w '%{http_code}' "$permalink" || echo 000)"
  permalink_api="$(curl -sS -o /dev/null -w '%{http_code}' "$GARNET_APP_URL/api/public/runs/$run_id?profile=$profile_id" || echo 000)"
  [ "$permalink_html" = 200 ] && [ "$permalink_api" = 200 ] || leg_fail "L5 permalink: html=$permalink_html api=$permalink_api"
fi

# --- L6 integration shape ------------------------------------------------------
# pnpm's own files, as checked out at the merge commit. These are the lines a
# pnpm reviewer reads; each check is a flag one of their bots or scanners has
# raised on a fork PR, or a rule of the current rollout (explicit api_token, no
# permission asks).
integration_files=(.github/workflows/ci.yml .github/workflows/test.yml .github/workflows/release.yml)
shape_notes=()
shape_fail=false
action_refs="$(grep -hoE 'garnet-org/action@[^ ]+' "${integration_files[@]}" 2>/dev/null | sort -u)"
unpinned="$(grep -vE '^garnet-org/action@[0-9a-f]{40}$' <<<"$action_refs" | sed '/^$/d')"
if [ -n "$unpinned" ]; then
  shape_fail=true; shape_notes+=("action ref not a full SHA: $(tr '\n' ' ' <<<"$unpinned")")
else
  shape_notes+=("action \`${action_refs#garnet-org/action@}\`")
  shape_notes[-1]="${shape_notes[-1]:0:16}\`"
fi
if grep -qE 'jibril_version:' .github/workflows/test.yml; then
  shape_notes+=("sensor $(grep -oE 'jibril_version: *[^ ]+' .github/workflows/test.yml | head -n1 | sed 's/jibril_version: *//')")
else
  shape_notes+=("sensor version left to the action")
fi
if grep -qE 'api_token: \$\{\{ secrets\.GARNET_API_TOKEN \}\}' .github/workflows/test.yml; then
  shape_notes+=("explicit token")
else
  shape_fail=true; shape_notes+=("test.yml does not pass api_token from secrets.GARNET_API_TOKEN")
fi
macos_garnet="$(awk '/runs-on: *macos/{m=1} /runs-on: *(ubuntu|windows|blacksmith)/{m=0} m && /garnet-org\/action@/{n++} END{print n+0}' .github/workflows/release.yml)"
if [ "$macos_garnet" -gt 0 ]; then
  leg_attention "L6 shape: release.yml keeps $macos_garnet Garnet step(s) on macOS jobs; the sensor never records there (CodeRabbit and Qodo flagged this on fork PRs)"
fi
if grep -qE 'GARNET_API_TOKEN: \$\{\{ secrets\.GARNET_API_TOKEN \}\}' .github/workflows/ci.yml; then
  leg_attention "L6 shape: ci.yml passes the token explicitly, so Dependabot-actor runs get an empty value and record nothing (upstream pull 13270)"
fi
added_lines=""
if [ "$in_pr_context" = true ]; then
  added_lines="$(gh api "repos/$repo/compare/$PR_BASE_SHA...$PR_HEAD_SHA" --paginate 2>/dev/null \
    | jq -r '.files[]? | select(.filename | startswith(".github/workflows/")) | "\(.filename)\t\(.patch // "")"' \
    | awk -F'\t' '{f=$1; n=split($2, L, "\n"); for(i=1;i<=n;i++) if (L[i] ~ /^\+/) print f "\t" substr(L[i],2)}')"
  if grep -qE 'id-token: *write' <<<"$added_lines"; then
    shape_fail=true; shape_notes+=("PR adds id-token: write to a workflow; the current rollout asks pnpm for no new permission")
  fi
  if grep -qE 'secrets: *inherit' <<<"$added_lines"; then
    shape_fail=true; shape_notes+=("PR adds secrets: inherit; pnpm passes GARNET_API_TOKEN explicitly")
  fi
  # The gate's own workflows need pull-requests: write to post their comment.
  if grep -vE '^\.github/workflows/garnet-jibril-release-gate' <<<"$added_lines" | grep -qE 'pull-requests: *write'; then
    shape_fail=true; shape_notes+=("PR adds pull-requests: write outside the gate workflows")
  fi
fi
if [ "$shape_fail" = true ]; then
  leg_fail "L6 integration shape: $(printf '%s; ' "${shape_notes[@]}")"
fi
shape_state="$(printf '%s; ' "${shape_notes[@]}")"
shape_state="${shape_state%; }"

# --- L7 integration run --------------------------------------------------------
# The gate's reproduce job runs the candidate sensor; pnpm's TS CI job on the
# same head runs whatever pnpm's own test.yml pins. Both have to produce a
# profile for "pnpm's setup works" to be true.
integration_state="not applicable (event=${EVENT_NAME:-unknown})"
integration_run_id=""; integration_profile_id=""; integration_conclusion=""
if [ "$in_pr_context" = true ]; then
  integration_state="untested: no $INTEGRATION_WORKFLOW_NAME run found for head ${PR_HEAD_SHA:0:7}"
  deadline=$((SECONDS + INTEGRATION_POLL_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    run="$(gh api "repos/$repo/actions/runs?head_sha=$PR_HEAD_SHA&event=pull_request&per_page=50" \
      --jq --arg n "$INTEGRATION_WORKFLOW_NAME" '[.workflow_runs[] | select(.name == $n)] | sort_by(.run_attempt) | last // empty' 2>/dev/null || true)"
    [ -n "$run" ] || break
    integration_run_id="$(jq -r '.id' <<<"$run")"
    integration_conclusion="$(jq -r '.conclusion // ""' <<<"$run")"
    [ "$(jq -r '.status' <<<"$run")" = completed ] && break
    integration_state="untested: $INTEGRATION_WORKFLOW_NAME run $integration_run_id still running after ${INTEGRATION_POLL_SECONDS}s"
    sleep 30
  done
  if [ -n "$integration_run_id" ] && [ -n "$integration_conclusion" ]; then
    code="$(fetch_profile "$integration_run_id")"
    if [ "$code" = 200 ]; then
      integration_profile_id="$(jq -r '.id' "/tmp/profile-$integration_run_id.json")"
      integration_state="profile \`$integration_profile_id\` from $INTEGRATION_WORKFLOW_NAME run $integration_run_id ($integration_conclusion)"
    else
      integration_state="$INTEGRATION_WORKFLOW_NAME run $integration_run_id finished $integration_conclusion with no profile (control plane HTTP $code): the job was green, the sensor recorded nothing"
      leg_fail "L7 integration run: $integration_state"
    fi
  fi
fi

# --- L8 reviewers and scanners -------------------------------------------------
# zizmor at pnpm's persona on the workflow files this PR touches, then the bot
# review threads (CodeRabbit, Qodo, Greptile, Devin) still unresolved on
# .github/ paths. A finding either gets fixed or a written disposition and a
# resolved thread; an open one fails the gate.
zizmor_state="not applicable"
zizmor_findings=0; zizmor_pedantic=0; bot_threads=0; bot_thread_list=""
if [ "$in_pr_context" = true ]; then
  touched="$(gh api "repos/$repo/compare/$PR_BASE_SHA...$PR_HEAD_SHA" --paginate 2>/dev/null \
    | jq -r '.files[]? | select(.status != "removed") | .filename | select(startswith(".github/workflows/") and (endswith(".yml") or endswith(".yaml")))' \
    | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done)"
  if [ -n "$touched" ]; then
    if command -v zizmor >/dev/null 2>&1; then
      count_findings() { jq 'if type == "array" then map(select(.ignored | not)) | length else 0 end' "$1" 2>/dev/null || echo 0; }
      # shellcheck disable=SC2086
      zizmor --format json-v1 --no-exit-codes --offline $touched > /tmp/zizmor.json 2>/tmp/zizmor.err || true
      zizmor_findings="$(count_findings /tmp/zizmor.json)"
      # shellcheck disable=SC2086
      zizmor --format json-v1 --no-exit-codes --offline --persona pedantic $touched > /tmp/zizmor-pedantic.json 2>/dev/null || true
      zizmor_pedantic="$(count_findings /tmp/zizmor-pedantic.json)"
      zizmor_state="$zizmor_findings finding(s) at the regular persona, $zizmor_pedantic pedantic, on $(wc -l <<<"$touched") touched workflow file(s)"
      if [ "$zizmor_findings" -gt 0 ]; then
        leg_fail "L8 reviewers: zizmor $zizmor_state"
        jq -r '.[] | select(.ignored | not) | "  - \(.ident) (\(.determinations.severity)): \(.locations[0].symbolic.key.Local.path // "")"' /tmp/zizmor.json 2>/dev/null
      fi
    else
      zizmor_state="zizmor not installed"
    fi
  else
    zizmor_state="no workflow files touched"
  fi
  threads="$(gh api graphql -f query='
    query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){ pullRequest(number:$number){
        reviewThreads(first:100){ nodes{ isResolved path comments(first:1){ nodes{ author{ login } url } } } } } } }' \
    -f owner="${repo%/*}" -f name="${repo#*/}" -F number="$PR_NUMBER" 2>/dev/null \
    | jq -c '[.data.repository.pullRequest.reviewThreads.nodes[]?
      | select(.isResolved == false)
      | select(.path | startswith(".github/"))
      | select((.comments.nodes[0].author.login // "") | test("coderabbit|qodo|greptile|devin|\\[bot\\]"; "i"))
      | {path, author: .comments.nodes[0].author.login, url: .comments.nodes[0].url}]' || echo '[]')"
  bot_threads="$(jq 'length' <<<"$threads")"
  bot_thread_list="$(jq -r '.[] | "  - \(.author) on \(.path): \(.url)"' <<<"$threads")"
  if [ "$bot_threads" -gt 0 ]; then
    leg_fail "L8 reviewers: $bot_threads unresolved bot review thread(s) on .github/ paths"
    echo "$bot_thread_list"
  fi
fi

# --- L9 timing -----------------------------------------------------------------
# Sensor start time is the action step's wall time. Overhead is that plus the
# slowdown of the same workload against the baseline job that ran without the
# sensor on the same runner class. pnpm named low overhead as a condition when
# it adopted Garnet (upstream issue 11626).
timing_state=""
action_seconds="${ACTION_SECONDS:-}"
overhead_seconds=""
if [ -n "$action_seconds" ] && [ -n "${REPRODUCE_WORKLOAD_SECONDS:-}" ] && [ -n "${BASELINE_WORKLOAD_SECONDS:-}" ]; then
  overhead_seconds=$(( action_seconds + REPRODUCE_WORKLOAD_SECONDS - BASELINE_WORKLOAD_SECONDS ))
  timing_state="sensor start ${action_seconds}s · workload ${REPRODUCE_WORKLOAD_SECONDS}s with sensor vs ${BASELINE_WORKLOAD_SECONDS}s without · overhead ${overhead_seconds}s (budget ${OVERHEAD_BUDGET_SECONDS}s)"
  [ "$overhead_seconds" -le "$OVERHEAD_BUDGET_SECONDS" ] || leg_fail "L9 timing: overhead ${overhead_seconds}s exceeds ${OVERHEAD_BUDGET_SECONDS}s"
else
  timing_state="untested: missing job clocks (action=${action_seconds:-?} workload=${REPRODUCE_WORKLOAD_SECONDS:-?} baseline=${BASELINE_WORKLOAD_SECONDS:-?})"
fi
[ -z "$profile_seconds" ] || timing_state="$timing_state · profile visible ${profile_seconds}s after the job"
[ -z "$comment_seconds" ] || timing_state="$timing_state · comment final ${comment_seconds}s after the profile"

# --- L10 coverage --------------------------------------------------------------
# One instrumented matrix cell says nothing about the others. Disclosure only.
coverage_state="unknown"
if python3 - <<'PY' > /tmp/coverage.txt 2>/dev/null
import yaml
ci = yaml.safe_load(open(".github/workflows/ci.yml"))
cells = []
for job_name, job in (ci.get("jobs") or {}).items():
    matrix = ((job.get("strategy") or {}).get("matrix") or {})
    for cell in matrix.get("include") or []:
        cells.append((job_name, cell))
if not cells:
    raise SystemExit(1)
on = [c for _, c in cells if c.get("garnet") is True]
off = [c for _, c in cells if c.get("garnet") is not True]
def name(c): return f'{c.get("platform_label", c.get("platform", "?"))}/node {c.get("node_major", c.get("node", "?"))}'
print(f"{len(on)} of {len(cells)} CI cells instrumented: " + ", ".join(name(c) for c in on)
      + (" · not instrumented: " + ", ".join(name(c) for c in off) if off else ""))
PY
then
  coverage_state="$(cat /tmp/coverage.txt)"
else
  coverage_state="$(grep -cE '^\s*garnet: true' .github/workflows/ci.yml || echo 0) 'garnet: true' cell(s) in ci.yml (matrix not parsed)"
fi
coverage_state="$coverage_state · Linux x86_64 only; macOS, Windows, fork PRs and Dependabot runs record nothing"

# --- verdict + record ----------------------------------------------------------
verdict=PASS
[ "${#fail_reasons[@]}" -eq 0 ] || verdict=FAIL
synthetic_merge=no
if [ -n "$profile_sha" ] && [ -n "${PR_HEAD_SHA:-}" ] && [ "$profile_sha" != "$PR_HEAD_SHA" ]; then
  synthetic_merge="yes · sensor recorded merge commit \`${profile_sha:0:7}\`, PR head is \`${PR_HEAD_SHA:0:7}\`"
fi
to_json_array() { printf '%s\n' "$@" | jq -R . | jq -s 'map(select(length > 0))'; }

jq -n \
  --arg verdict "$verdict" --argjson fail_reasons "$(to_json_array "${fail_reasons[@]:-}")" --argjson attention "$(to_json_array "${attention[@]:-}")" \
  --arg tag "$GATE_TAG" --arg resolved_version "${STARTUP_VERSION:-}" --arg action_sha "$action_ref" \
  --arg run_id "$run_id" --arg run_attempt "$run_attempt" --arg runner "${RUNNER_NAME_USED:-}" \
  --arg event "${EVENT_NAME:-}" --arg pr "${PR_NUMBER:-}" \
  --arg base_sha "${PR_BASE_SHA:-}" --arg head_sha "${PR_HEAD_SHA:-}" --arg merge_sha "$merge_sha" --arg current_merge_sha "$current_merge_sha" \
  --arg startup_verdict "$startup_verdict" --arg startup_reason "${STARTUP_REASON:-}" \
  --arg unit "${STARTUP_UNIT:-}" --arg steps_status "${STARTUP_STEPS_STATUS:-}" --arg workflow_ref "${STARTUP_WORKFLOW_REF:-}" \
  --arg profile_state "$profile_state" --arg profile_id "$profile_id" --arg profile_sha "$profile_sha" --arg profile_ref "$profile_ref" \
  --argjson peers "$peers" --argjson destinations "$destinations" --argjson egress "$egress_names" \
  --arg workload_state "$workload_state" \
  --arg comment_state "$comment_state" --arg comment_url "$comment_url" --arg previous_sha "$previous_sha" --arg comparison "$comparison" \
  --arg synthetic_merge "$synthetic_merge" \
  --arg permalink "$permalink" --arg permalink_html "$permalink_html" --arg permalink_api "$permalink_api" \
  --arg shape_state "$shape_state" --argjson shape_fail "$shape_fail" --argjson macos_garnet "$macos_garnet" \
  --arg integration_state "$integration_state" --arg integration_run_id "$integration_run_id" --arg integration_profile_id "$integration_profile_id" \
  --arg zizmor_state "$zizmor_state" --argjson zizmor_findings "$zizmor_findings" --argjson zizmor_pedantic "$zizmor_pedantic" --argjson bot_threads "$bot_threads" \
  --arg timing_state "$timing_state" --arg action_seconds "${action_seconds:-}" --arg overhead_seconds "$overhead_seconds" \
  --arg profile_seconds "$profile_seconds" --arg comment_seconds "$comment_seconds" --arg overhead_budget "$OVERHEAD_BUDGET_SECONDS" \
  --arg coverage_state "$coverage_state" \
  '{verdict: $verdict, fail_reasons: $fail_reasons, attention: $attention,
    jibril: {requested_tag: $tag, resolved_version: $resolved_version},
    action_sha: $action_sha,
    run: {id: $run_id, attempt: $run_attempt, runner: $runner, event: $event, pr: $pr},
    commits: {base: $base_sha, head: $head_sha, merge: $merge_sha, merge_now: $current_merge_sha, profile: $profile_sha, previous: $previous_sha,
              comparison: $comparison, synthetic_merge: $synthetic_merge},
    legs: {
      L1_startup: {verdict: $startup_verdict, reason: $startup_reason, unit: $unit, github_steps: $steps_status, workflow_ref: $workflow_ref},
      L2_profile: {state: $profile_state, id: $profile_id, ref: $profile_ref, egress_peers: $peers, destinations: $destinations, egress: $egress},
      L3_workload: $workload_state,
      L4_app_comment: {state: $comment_state, url: $comment_url},
      L5_permalink: {url: $permalink, html: $permalink_html, api: $permalink_api},
      L6_integration_shape: {state: $shape_state, failed: $shape_fail, macos_garnet_steps: $macos_garnet},
      L7_integration_run: {state: $integration_state, run_id: $integration_run_id, profile_id: $integration_profile_id},
      L8_reviewers: {zizmor: $zizmor_state, zizmor_findings: $zizmor_findings, zizmor_pedantic: $zizmor_pedantic, unresolved_bot_threads: $bot_threads},
      L9_timing: {state: $timing_state, sensor_start_seconds: $action_seconds, overhead_seconds: $overhead_seconds, overhead_budget_seconds: $overhead_budget,
                  profile_seconds: $profile_seconds, comment_seconds: $comment_seconds},
      L10_coverage: $coverage_state}}' > /tmp/gate-record.json

run_url="https://github.com/$repo/actions/runs/$run_id"
profile_short="${profile_sha:0:7}"
{
  echo "<!-- garnet:jibril-release-gate $GATE_TAG -->"
  echo "### Jibril release gate · \`$GATE_TAG\` · **$verdict**"
  echo
  echo "| leg | result |"
  echo "|---|---|"
  echo "| L1 startup | $startup_verdict — ${STARTUP_REASON:-} |"
  echo "| L2 profile | $profile_state${profile_id:+ · \`$profile_id\`} · $peers egress peers, $destinations destinations |"
  echo "| L3 workload | $workload_state |"
  echo "| L4 App comment | $comment_state${comment_url:+ · $comment_url} |"
  echo "| L5 permalink | html $permalink_html · api $permalink_api${permalink:+ · $permalink} |"
  echo "| L6 integration shape | $shape_state |"
  echo "| L7 integration run | $integration_state |"
  echo "| L8 reviewers | zizmor: $zizmor_state · unresolved bot threads on .github/: $bot_threads |"
  echo "| L9 timing | $timing_state |"
  echo "| L10 coverage | $coverage_state |"
  echo
  echo "| record | value |"
  echo "|---|---|"
  echo "| jibril | requested \`$GATE_TAG\` · resolved \`${STARTUP_VERSION:-unknown}\` |"
  echo "| action | \`garnet-org/action@$action_ref\` |"
  echo "| run | [$run_id]($run_url) attempt $run_attempt · \`${RUNNER_NAME_USED:-}\` · $EVENT_NAME |"
  echo "| workflow ref seen by sensor | \`${STARTUP_WORKFLOW_REF:-absent}\` |"
  if [ "$in_pr_context" = true ]; then
    echo "| base → head | \`${PR_BASE_SHA:0:7}\` → \`${PR_HEAD_SHA:0:7}\` |"
    echo "| merge sha at run | \`${merge_sha:0:7}\` · now \`${current_merge_sha:0:7}\` · profile recorded \`${profile_short:-none}\`${profile_ref:+ (\`$profile_ref\`)} |"
    echo "| comparison in comment | ${comparison:-n/a}${previous_sha:+ (previous \`${previous_sha:0:7}\`)} |"
    echo "| synthetic merge | $synthetic_merge |"
  else
    echo "| commit | \`${merge_sha:0:7}\` · profile recorded \`${profile_short:-none}\`${profile_ref:+ (\`$profile_ref\`)} · no base/head pair |"
  fi
  if [ "$verdict" = FAIL ]; then
    echo
    echo "Failing legs:"
    for r in "${fail_reasons[@]}"; do echo "- $r"; done
    [ -z "$bot_thread_list" ] || echo "$bot_thread_list"
  fi
  if [ "${#attention[@]}" -gt 0 ]; then
    echo
    echo "Disclosed, not failing:"
    for a in "${attention[@]}"; do echo "- $a"; done
  fi
  echo
  echo "<sub>Legs map to past failures in [\`$LEDGER_PATH\`](https://github.com/$repo/blob/$merge_sha/$LEDGER_PATH). Full record in the run's \`garnet-release-gate\` artifact.</sub>"
} > /tmp/gate-comment.md

cat /tmp/gate-comment.md >> "$GITHUB_STEP_SUMMARY"
echo "verdict=$verdict" >> "$GITHUB_OUTPUT"
echo "profile_id=$profile_id" >> "$GITHUB_OUTPUT"
echo "permalink=$permalink" >> "$GITHUB_OUTPUT"
jq . /tmp/gate-record.json
