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
#   L6 posture            permissions and auth on the instrumented job, here
#                         and in pnpm's own files: no permission ask, full SHA
#                         pins, a sensor version that cannot move on its own
#   L7 integration run    pnpm's own instrumented TS CI job for this head
#                         produced a profile
#   L8 reviewers          every scanner finding classified in writing, no
#                         unresolved bot threads on .github/ paths
#   L9 timing             sensor start, workload overhead, post-step flush,
#                         profile-visible and comment-final latency
#   L10 coverage          which CI cells are instrumented, and what the gate
#                         does not prove (disclosure only)
#   L11 upstream drift    the gate still reproduces pnpm's shape at main
#   L12 warning noise     annotations the action step emits on a token path
#   L13 credential-less   an empty api_token skips cleanly (simulation)
#   L14 release and tag   Garnet steps in release.yml and update-latest.yml
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
# The App writes the description mirror after it finalizes the comment.
: "${MIRROR_POLL_SECONDS:=300}"
: "${INTEGRATION_WORKFLOW_NAME:=TS CI}"
: "${INTEGRATION_POLL_SECONDS:=1500}"
: "${OVERHEAD_BUDGET_SECONDS:=120}"
: "${START_BUDGET_SECONDS:=30}"
: "${FLUSH_BUDGET_SECONDS:=60}"
: "${LEDGER_PATH:=.github/garnet-gate/FAILURE_LEDGER.md}"
: "${DISPOSITIONS_PATH:=.github/garnet-gate/scanner-dispositions.yml}"
: "${UPSTREAM_DIR:=/tmp/upstream}"
: "${UPSTREAM_SHA:=}"
: "${UPSTREAM_REPO:=pnpm/pnpm}"
: "${SHAPE_SCRIPT:=.github/scripts/garnet-gate-shape.py}"
: "${DEPENDABOT_SIM_OUTCOME:=}"
# Display names as GitHub reports them for a reusable workflow's jobs, which is
# "<caller job> / <job name>": every job of the callee shares the caller prefix,
# so these are matched on the trailing name, exactly.
: "${REPRODUCE_JOB_NAME:=Reproduce self-repo reference on Blacksmith}"
: "${DEPENDABOT_SIM_JOB_NAME:=Simulation — credential-less run skips cleanly}"
: "${JIBRIL_ATTRIBUTION_ISSUE:=https://github.com/garnet-org/jibril/issues/757}"
: "${ACTION_STEP_NAME:=Garnet runtime monitoring}"
: "${SIM_ACTION_STEP_NAME:=Garnet runtime monitoring without credentials}"

run_id="$GITHUB_RUN_ID"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
repo="$GITHUB_REPOSITORY"
merge_sha="$GITHUB_SHA"
action_ref="$(grep -oE 'garnet-org/action@[0-9a-f]{40}' .github/workflows/garnet-jibril-release-gate-job.yml | head -n1 | cut -d@ -f2)"
in_pr_context=false
[ "${EVENT_NAME:-}" = pull_request ] && [ -n "${PR_NUMBER:-}" ] && in_pr_context=true

fail_reasons=()
attention=()
disclosures=()
note() { echo "::notice::$*"; }
leg_fail() { fail_reasons+=("$1"); echo "::error::$1"; }
leg_attention() { attention+=("$1"); echo "::warning::$1"; }
# A disclosure is a line only a reader can decide. It is never a warning
# annotation: L12 counts annotations, and the gate must not add noise to what
# it measures.
disclose() { disclosures+=("$1"); echo "::notice::disclosed: $1"; }
# A leg whose finding is real, reported, and parked upstream reads as disclosed
# in the table rather than as a pass it did not earn.
disclosed_legs=()
mark_disclosed() { disclosed_legs+=("$1"); }
now() { date +%s; }

# --- shape of the thing under test ---------------------------------------------
# One parse of pnpm's files at main and of the gate's own reproduce job, shared
# by L3, L6, L10, L11 and L14. An empty `jibril_version` hands the sensor
# version to the action's own default, so the default is read from the action
# source at the pinned sha rather than assumed.
resolve_action_default() { # $1 action sha -> the version an empty input resolves to
  local src
  src="$(gh api "repos/garnet-org/action/contents/src/action.js?ref=$1" --jq .content 2>/dev/null | base64 -d 2>/dev/null || true)"
  [ -n "$src" ] || { echo unknown; return; }
  # The resolver runs on an empty input; only its fallback matters here.
  local resolver
  resolver="$(sed -n '/function resolveJibrilVersion/,/^}/p' <<<"$src")"
  if grep -q 'return "latest"' <<<"$resolver"; then echo latest; return; fi
  grep -oE 'JIBRIL_STABLE_VERSION *= *"[^"]+"' <<<"$src" | head -n1 | grep -oE 'v[0-9][^"]*' || echo unknown
}

upstream_action_ref="$(grep -hoE 'garnet-org/action@[0-9a-f]{40}' "$UPSTREAM_DIR/test.yml" 2>/dev/null | head -n1 | cut -d@ -f2)"
action_default_version="$(resolve_action_default "$action_ref")"
upstream_action_default_version="unknown"
[ -z "$upstream_action_ref" ] || upstream_action_default_version="$(resolve_action_default "$upstream_action_ref")"

shape='{}'
shape_error=""
if [ -f "$UPSTREAM_DIR/ci.yml" ] && [ -f "$UPSTREAM_DIR/test.yml" ]; then
  if shape_out="$(python3 "$SHAPE_SCRIPT" "$UPSTREAM_DIR" \
      --upstream-sha "$UPSTREAM_SHA" \
      --action-default-version "$action_default_version" \
      --upstream-action-default-version "$upstream_action_default_version" 2>/tmp/shape.err)"; then
    shape="$shape_out"
  else
    shape_error="$(head -c 300 /tmp/shape.err | tr '\n' ' ')"
  fi
else
  shape_error="upstream snapshot missing from $UPSTREAM_DIR"
fi
shape_get() { jq -r "$1" <<<"$shape" 2>/dev/null || echo ""; }

# --- job timeline --------------------------------------------------------------
# Step times and log annotations for this run's own jobs; L9 and L12 read them.
jobs_json="$(gh api "repos/$repo/actions/runs/$run_id/attempts/$run_attempt/jobs?per_page=100" 2>/dev/null || echo '{"jobs":[]}')"
# Exactly one job whose display name ends with this name. A prefix match takes
# every job of the reusable workflow, and reading the wrong job's log is how a
# leg reports what another job did (F35).
job_id_by_name() {
  jq -r --arg n "$1" '
    [.jobs[]? | select((.name | endswith($n)) or .name == $n)]
    | if length == 1 then .[0].id else empty end' <<<"$jobs_json"
}
job_ids_matching() { jq -r --arg n "$1" '[.jobs[]? | select(.name | endswith($n))] | length' <<<"$jobs_json"; }
reproduce_job_id="$(job_id_by_name "$REPRODUCE_JOB_NAME")"
dependabot_job_id="$(job_id_by_name "$DEPENDABOT_SIM_JOB_NAME")"
job_log() { # $1 job id -> the job's log on stdout, empty when it cannot be read
  [ -n "$1" ] || return 0
  gh api "repos/$repo/actions/jobs/$1/logs" 2>/dev/null || true
}
job_steps() { # $1 job id -> that job's step timeline
  [ -n "$1" ] || { echo '{"steps":[]}'; return; }
  gh api "repos/$repo/actions/jobs/$1" 2>/dev/null || echo '{"steps":[]}'
}
# A run step's slice of a job log: its own group header to the next one.
step_log() { awk -v start="$2" '
  index($0, "##[group]Run ") && index($0, start) { on = 1; next }
  on && index($0, "##[group]Run ") && !index($0, start) { on = 0 }
  on { print }' <<<"$1"; }
# The action's post hook is a step of its own and writes no group header at all,
# so its lines are cut by the step's start and end time from the job timeline.
# Everything the action says after the job's own steps are done is said there.
post_step_log() { # $1 log, $2 steps json, $3 post step name
  local from to
  from="$(jq -r --arg n "$3" '[.steps[]? | select(.name == $n) | .started_at // empty] | first // empty' <<<"$2")"
  to="$(jq -r --arg n "$3" '[.steps[]? | select(.name == $n) | .completed_at // empty] | first // empty' <<<"$2")"
  [ -n "$from" ] && [ -n "$to" ] || return 0
  awk -v from="$from" -v to="$to" '
    { stamp = substr($0, 1, 19) "Z" }
    stamp >= from && stamp <= to { print }' <<<"$1"
}
step_conclusion() { jq -r --arg n "$2" '[.steps[]? | select(.name == $n) | .conclusion] | first // ""' <<<"$1"; }
step_seconds() {
  jq -r --arg n "$2" '[.steps[]? | select(.name == $n) | select(.started_at != null and .completed_at != null)
    | ((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601))] | first // empty' <<<"$1"
}
annotations() { grep -E '##\[(warning|error)\]' <<<"${1:-}" || true; }
# A job's annotations from the check run, in the log's own notation. The log of a
# job in a run that is still going is often not archived yet, and the verify job
# runs inside that run: reading the log alone made L12 report zero annotations
# for a job that had one and L13 read the credential-less path as silent (F35).
# The check run carries the same warning and error lines while the run is live.
job_annotation_lines() { # $1 job id; prints lines, nonzero when unreadable
  [ -n "$1" ] || return 1
  gh api --paginate "repos/$repo/check-runs/$1/annotations" \
    --jq '.[] | select(.annotation_level == "warning" or .annotation_level == "failure")
      | "##[\(if .annotation_level == "failure" then "error" else "warning" end)]\(.message | gsub("[\r\n]+"; " "))"' 2>/dev/null
}
# The lines one source has and the other does not, so a log slice and the check
# run can be added up without counting the same annotation twice.
merge_annotation_lines() { printf '%s\n%s\n' "${1:-}" "${2:-}" | sed -E 's/^[0-9T:.Z-]+ //' | sed '/^$/d' | sort -u; }

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

profile_id=""; profile_job=""; profile_attempt=""; profile_sha=""; profile_ref=""
egress_names="[]"; workload_steps="[]"; peers=0; destinations=0
if [ -n "$profile_json" ]; then
  profile_id="$(jq -r '.id' <<<"$profile_json")"
  profile_job="$(jq -r '.job' <<<"$profile_json")"
  profile_attempt="$(jq -r '.runAttempt' <<<"$profile_json")"
  profile_sha="$(jq -r '.data.scenarios.github.sha // ""' <<<"$profile_json")"
  profile_ref="$(jq -r '.data.scenarios.github.ref // ""' <<<"$profile_json")"
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
# The step-numbering skew itself is parked upstream (jibril#757), so the leg
# computes and prints observed vs expected attribution and discloses the skew
# instead of failing on it. Everything else about the leg still decides.
workload_state="untested"
attribution_skew=false
if [ "${WORKLOAD_OUTCOME:-}" != success ]; then
  workload_state="untested: workload step outcome=${WORKLOAD_OUTCOME:-unknown}"
elif [ -n "$profile_json" ]; then
  if jq -e --arg step "$WORKLOAD_STEP_NAME" 'map(select(contains($step))) | length > 0' <<<"$workload_steps" >/dev/null; then
    workload_state="recorded: $WORKLOAD_DESTINATION reached from step \"$WORKLOAD_STEP_NAME\""
  elif jq -e --arg dest "$WORKLOAD_DESTINATION" 'index($dest) != null' <<<"$egress_names" >/dev/null; then
    if [ "$workload_steps" = "[]" ]; then
      workload_state="destination present, but attributed to runner background, not to a step"
    else
      # Another named step means the sensor's step numbering is off (F25);
      # <unknown> means GITHUB_ACTION matched no numbered step (F23).
      attribution_skew=true
      workload_state="destination present · expected \"$WORKLOAD_STEP_NAME\", observed $workload_steps"
      predicted="$(shape_get '.gate.attribution.jibril_records // ""')"
      if [ -n "$predicted" ] && jq -e --arg p "$predicted" 'map(select(contains($p))) | length > 0' <<<"$workload_steps" >/dev/null; then
        workload_state="$workload_state — F25 Jibril step-numbering skew, garnet-org/jibril parseStepsList: the egress lands on \"$predicted\", the run step one place earlier in the file"
      else
        workload_state="$workload_state — F25 Jibril step-numbering skew, garnet-org/jibril parseStepsList is the known cause of an off-by-one attribution"
      fi
    fi
    if [ "$attribution_skew" = true ]; then
      workload_state="$workload_state; parked upstream at $JIBRIL_ATTRIBUTION_ISSUE, disclosed here"
      mark_disclosed L3
      disclose "L3 workload: $workload_state — the fix is upstream in Jibril (overwrite the step context at process exec from eBPF using GITHUB_ACTION); this leg reports the attribution and does not decide the verdict while $JIBRIL_ATTRIBUTION_ISSUE is open (F25)"
    else
      leg_fail "L3 workload: $workload_state"
    fi
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
comment_body=""; app_comments=0; comment_content="untested"; mirror_state="untested"; recorded_step=""
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
      comment_body="$(jq -r '.body' <<<"$match")"
      # The placeholder the App posts first already carries the v1 marker, so
      # the marker alone is not finality: the record is final once the summary
      # block reports the chains it recorded. Reading the placeholder as final
      # is how L4 saw a body with no step name and no destination.
      summary_json="$(jq -r '.body | capture("<!-- garnet:summary (?<s>.*?) -->").s // ""' <<<"$match")"
      chains=0
      [ -z "$summary_json" ] || chains="$(jq -r '.chains // 0' <<<"$summary_json" 2>/dev/null || echo 0)"
      [ "$chains" != null ] || chains=0
      if jq -e '.body | contains("<!-- garnet-control-plane-pr-comment:v1")' <<<"$match" >/dev/null \
         && [ -n "$summary_json" ] && [ "$chains" -gt 0 ] 2>/dev/null; then
        comment_state="final after $(( $(now) - comment_wait_start ))s"
        comment_seconds=$(( $(now) - comment_wait_start ))
        break
      fi
      summary_json=""
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

  # One comment, updated in place. A schedule or dispatch run that posts a
  # second App comment leaves the reader two records of the same head (F31).
  app_comments="$(jq '[.[] | select(.user.login == "garnet-runtime-review[bot]" or .user.login == "garnet-runtime-review-dev[bot]")] | length' <<<"${comments:-[]}" 2>/dev/null || echo 0)"
  if [ "$app_comments" -gt 1 ]; then
    leg_fail "L4 app comment: $app_comments Garnet App comments on the pull request; the App updates one comment in place (F31)"
  fi

  # What the comment has to carry to be evidence: the step the sensor recorded,
  # in quotes, and at least one destination it reached from it. The step name is
  # the recorded one, not the intended one, so an F25 skew fails L3 and leaves
  # this check honest.
  if [ -n "$comment_body" ]; then
    recorded_step="$(jq -r 'first(.[]?) // ""' <<<"$workload_steps")"
    [ -n "$recorded_step" ] || recorded_step="$WORKLOAD_STEP_NAME"
    # The profile carries the step's ordinal (`3. Validate ...`); the comment
    # quotes the name alone. Both are the same recorded step.
    recorded_step_name="$(sed -E 's/^[0-9]+\. //' <<<"$recorded_step")"
    has_step=false; has_dest=false
    # Destinations are defanged in the rendered comment (`npmjs[.]org`), so the
    # body is compared with the fangs put back rather than with a second
    # spelling of every destination the gate knows.
    comment_plain="$(tr -d '[]' <<<"$comment_body")"
    grep -qF "\"$recorded_step_name\"" <<<"$comment_plain" && has_step=true
    grep -qF "&quot;$recorded_step_name&quot;" <<<"$comment_plain" && has_step=true
    grep -qF "$WORKLOAD_DESTINATION" <<<"$comment_plain" && has_dest=true
    if [ "$has_step" = true ] && [ "$has_dest" = true ]; then
      comment_content="names \"$recorded_step\" and $WORKLOAD_DESTINATION"
    elif [ "$has_dest" = true ] && [ "$attribution_skew" = true ]; then
      # The only name the comment could quote is the skewed one, so a missing
      # quoted step name here is the same upstream defect as L3, not a second
      # one: the destination is named, the step it is hung on is not (F25).
      comment_content="names $WORKLOAD_DESTINATION; no step name in quotes, downstream of the F25 skew"
      mark_disclosed L4
      disclose "L4 app comment: body $comment_content — same disclosure as L3, parked at $JIBRIL_ATTRIBUTION_ISSUE (F25)"
    else
      comment_content="missing $( [ "$has_step" = true ] || printf 'the recorded step name in quotes; ' )$( [ "$has_dest" = true ] || printf 'a destination' )"
      leg_fail "L4 app comment: body $comment_content — the destination is what binds the record to the workload, and the comment does not carry it (F31)"
    fi

    # The evidence mirror copies the same comment into the PR description, and
    # a review reads the description. Both have to name the same sha (F34).
    # The App writes the description after it finalizes the comment, so the
    # mirror is waited for rather than read once.
    normalise() { grep -v -e '<!-- garnet:evidence:begin -->' -e '<!-- garnet:evidence:end -->' \
      | sed -e 's/[[:space:]]\+/ /g' -e 's/^ //' -e 's/ $//' | grep -v '^$'; }
    comment_marker="$(grep -oE '<!-- garnet:commit [0-9a-f]{40} -->' <<<"$comment_body" | head -n1)"
    comment_normalised="$(normalise <<<"$comment_body")"
    mirror=""; mirror_marker=""; mirror_body=""
    mirror_deadline=$((SECONDS + MIRROR_POLL_SECONDS))
    while :; do
      pr_body="$(gh api "repos/$repo/pulls/$PR_NUMBER" --jq '.body // ""' 2>/dev/null || true)"
      mirror="$(awk '/<!-- garnet:evidence:begin -->/{on=1} on{print} /<!-- garnet:evidence:end -->/{on=0}' <<<"$pr_body")"
      mirror_marker="$(grep -oE '<!-- garnet:commit [0-9a-f]{40} -->' <<<"$mirror" | head -n1)"
      mirror_body="$(normalise <<<"$mirror")"
      { [ -n "$mirror" ] && [ "$mirror_marker" = "$comment_marker" ]; } && break
      [ "$SECONDS" -lt "$mirror_deadline" ] || break
      sleep 15
    done
    # Same sha is not the same record: the comment's payload has to be present
    # in the mirror, so a stale or hand-trimmed copy under a current marker
    # fails. The mirror adds its own heading and fold around that payload (F34).
    if [ -z "$mirror" ]; then
      mirror_state="absent from the pull request description after ${MIRROR_POLL_SECONDS}s"
      leg_fail "L4 app comment: evidence mirror $mirror_state (F34)"
    elif [ "$mirror_marker" != "$comment_marker" ]; then
      mirror_state="mirror at ${mirror_marker:-no sha}, comment at ${comment_marker:-no sha}"
      leg_fail "L4 app comment: evidence mirror and comment disagree — $mirror_state (F34)"
    elif [[ "$mirror_body" != *"$comment_normalised"* ]]; then
      mirror_state="same sha, different body: $(wc -l <<<"$mirror_body") mirrored line(s) do not carry the comment's $(wc -l <<<"$comment_normalised")"
      leg_fail "L4 app comment: evidence mirror carries the head marker but not the comment's content — $mirror_state (F34)"
      diff <(echo "$comment_normalised") <(echo "$mirror_body") | head -n 20
    else
      mirror_state="mirrored in the description in full, both bound to ${PR_HEAD_SHA:0:7}"
    fi
  fi
fi

# --- L5 public permalink -------------------------------------------------------
permalink=""; permalink_html="untested"; permalink_api="untested"
if [ -n "$profile_id" ]; then
  permalink="$GARNET_APP_URL/public/runs/$run_id?profile=$profile_id"
  permalink_html="$(curl -sS -o /dev/null -w '%{http_code}' "$permalink" || echo 000)"
  permalink_api="$(curl -sS -o /dev/null -w '%{http_code}' "$GARNET_APP_URL/api/public/runs/$run_id?profile=$profile_id" || echo 000)"
  if [ "$permalink_html" != 200 ] || [ "$permalink_api" != 200 ]; then
    leg_fail "L5 permalink: html=$permalink_html api=$permalink_api"
  fi
fi

# --- L6 permission and auth posture --------------------------------------------
# The lines a pnpm reviewer and their scanners read on an instrumented job, on
# the gate's own reproduce job and on pnpm's job at main: no permission the
# rollout did not ask for, a full SHA pin, an explicit token, and a sensor
# version that cannot move under an unchanged action ref (F14, F15).
shape_notes=()
shape_fail=false
posture_json="$(shape_get '.posture // []')"
[ -n "$posture_json" ] || posture_json='[]'
while IFS=$'\t' read -r pjob pcheck pdetail; do
  [ -n "$pjob" ] || continue
  shape_fail=true
  shape_notes+=("$pjob: $pcheck — $pdetail")
done < <(jq -r '.[] | select(.ok | not) | [.job, .check, .detail] | @tsv' <<<"$posture_json")
if [ "$shape_fail" = false ]; then
  shape_notes+=("gate and upstream: no id-token, no secrets: inherit, no pull-requests: write, action pinned to a full sha, explicit api_token, sensor version pinned")
fi
if [ -n "$shape_error" ]; then
  shape_fail=true
  shape_notes+=("posture not parsed: $shape_error")
fi
macos_garnet="$(shape_get '[.release_workflows[]? | select(.produces_profile == "no")] | length')"
[ -n "$macos_garnet" ] || macos_garnet=0
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
  leg_fail "L6 posture: $(printf '%s; ' "${shape_notes[@]}")"
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
    # A token without actions: read gets an error here, not an empty list. An
    # error is a gate defect (F22); an empty list is a missing run.
    if ! runs_json="$(gh api "repos/$repo/actions/runs?head_sha=$PR_HEAD_SHA&event=pull_request&per_page=50" 2>/tmp/runs.err)"; then
      integration_state="could not list workflow runs for head ${PR_HEAD_SHA:0:7}: $(head -c 200 /tmp/runs.err | tr '\n' ' ')"
      leg_fail "L7 integration run: $integration_state"
      break
    fi
    run="$(jq -c --arg n "$INTEGRATION_WORKFLOW_NAME" '[.workflow_runs[] | select(.name == $n)] | sort_by(.run_attempt) | last // empty' <<<"$runs_json")"
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
      # The control plane answers 403 for a run it never received (F24).
      case "$code" in
        403) why="no profile is bound to that run" ;;
        *) why="control plane HTTP $code" ;;
      esac
      integration_state="$INTEGRATION_WORKFLOW_NAME run $integration_run_id finished $integration_conclusion with no profile ($why): the job was green, the sensor recorded nothing"
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
zizmor_findings=0; zizmor_pedantic=0; zizmor_unclassified=0; zizmor_unclassified_list=""
actionlint_state="untested"; actionlint_unexpected=0
bot_threads=0; bot_thread_list=""
# The gate's own workflows are always scanned: they are the production-shaped
# reproduction, and a finding on them is a finding on what pnpm would run.
scan_files=(.github/workflows/garnet-jibril-release-gate.yml .github/workflows/garnet-jibril-release-gate-job.yml)
if [ "$in_pr_context" = true ]; then
  while read -r f; do
    [ -n "$f" ] || continue
    case " ${scan_files[*]} " in *" $f "*) ;; *) scan_files+=("$f") ;; esac
  done < <(gh api "repos/$repo/compare/$PR_BASE_SHA...$PR_HEAD_SHA" --paginate 2>/dev/null \
    | jq -r '.files[]? | select(.status != "removed") | .filename | select(startswith(".github/workflows/") and (endswith(".yml") or endswith(".yaml")))' \
    | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done)
fi
if command -v zizmor >/dev/null 2>&1; then
  count_findings() { jq 'if type == "array" then map(select(.ignored | not)) | length else 0 end' "$1" 2>/dev/null || echo 0; }
  # A scanner that failed to run reports nothing, which reads exactly like a
  # clean scan. Both invocations have to produce a JSON array or the leg fails.
  scan_ok=true
  zizmor --format json-v1 --no-exit-codes --offline "${scan_files[@]}" > /tmp/zizmor.json 2>/tmp/zizmor.err \
    || { scan_ok=false; leg_fail "L8 reviewers: zizmor exited nonzero — $(head -c 200 /tmp/zizmor.err | tr '\n' ' ') (F33)"; }
  zizmor --format json-v1 --no-exit-codes --offline --persona pedantic "${scan_files[@]}" > /tmp/zizmor-pedantic.json 2>/tmp/zizmor-pedantic.err \
    || { scan_ok=false; leg_fail "L8 reviewers: zizmor --persona pedantic exited nonzero — $(head -c 200 /tmp/zizmor-pedantic.err | tr '\n' ' ') (F33)"; }
  for report in /tmp/zizmor.json /tmp/zizmor-pedantic.json; do
    jq -e 'type == "array"' "$report" >/dev/null 2>&1 \
      || { scan_ok=false; leg_fail "L8 reviewers: $report is not a zizmor JSON array, so no finding in it was classified (F33)"; }
  done
  zizmor_findings="$(count_findings /tmp/zizmor.json)"
  zizmor_pedantic="$(count_findings /tmp/zizmor-pedantic.json)"
  # Every finding, regular or pedantic, needs a written class in the
  # dispositions file. An answer left in a review conversation is not one (F33).
  classified=0
  python3 - "$DISPOSITIONS_PATH" /tmp/zizmor.json /tmp/zizmor-pedantic.json \
    > /tmp/zizmor-classified.txt 2>/tmp/zizmor-classify.err <<'PY' || classified=$?
import json, sys, yaml

# A class the verifier does not know is not a disposition; "fixed" claims the
# finding is gone, so a finding still reported under it is unanswered (F33).
DECIDING = {"disclosed", "intentional-diagnostic", "garnet-side"}

dispositions_path, *reports = sys.argv[1:]
rows = (yaml.safe_load(open(dispositions_path)) or {}).get("zizmor") or []
for row in rows:
    if not isinstance(row, dict) or not row.get("ident") or not row.get("path"):
        sys.exit(f"malformed disposition row: {row!r}")
    if row.get("class") not in DECIDING | {"fixed"}:
        sys.exit(f"unknown disposition class {row.get('class')!r} for {row.get('ident')!r}")
seen = set()
for report in reports:
    findings = json.load(open(report))
    for finding in findings if isinstance(findings, list) else []:
        if finding.get("ignored"):
            continue
        location = (finding.get("locations") or [{}])[0].get("symbolic", {})
        path = ((location.get("key") or {}).get("Local") or {}).get("verbatim_path", "")
        route = ".".join(
            str(part.get("Key", part.get("Index", "")))
            for part in ((location.get("route") or {}).get("route") or [])
        )
        key = (finding.get("ident", ""), path, route)
        if key in seen:
            continue
        seen.add(key)
        match = next(
            (
                row for row in rows
                if row.get("ident") == key[0]
                and row.get("path") == path
                and ("route" not in row or row.get("route") == route)
            ),
            None,
        )
        state = match.get("class") if match else "unclassified"
        if state not in DECIDING:
            state = "unclassified"
        print(f"{state}\t{key[0]} at {path}{' ' + route if route else ''}")
PY
  if [ "$classified" -eq 0 ]; then
    zizmor_unclassified_list="$(sed -n 's/^unclassified\t/  - /p' /tmp/zizmor-classified.txt)"
    zizmor_unclassified="$(grep -c '^unclassified	' /tmp/zizmor-classified.txt || true)"
  else
    zizmor_unclassified=0
    zizmor_unclassified_list="  - dispositions not read: $(head -c 200 /tmp/zizmor-classify.err | tr '\n' ' ')"
    leg_fail "L8 reviewers: $DISPOSITIONS_PATH did not classify the findings — $(head -c 200 /tmp/zizmor-classify.err | tr '\n' ' ') (F33)"
  fi
  zizmor_state="$zizmor_findings regular, $zizmor_pedantic pedantic finding(s) over ${#scan_files[@]} workflow file(s); $zizmor_unclassified without a written class"
  [ "$scan_ok" = true ] || zizmor_state="$zizmor_state · the scan itself did not complete, so those counts prove nothing"
  if [ "${zizmor_unclassified:-0}" -gt 0 ]; then
    leg_fail "L8 reviewers: $zizmor_unclassified zizmor finding(s) with no row in $DISPOSITIONS_PATH (F33)"
    echo "$zizmor_unclassified_list"
  fi
else
  zizmor_state="zizmor not installed"
  leg_fail "L8 reviewers: zizmor not installed, the scanner bar was not applied"
fi
# actionlint reads what zizmor does not. Two of its messages are the gate's
# deliberate reproductions and are answered in the dispositions file by message
# text; disabling actionlint or configuring the label away would hide them.
if command -v actionlint >/dev/null 2>&1; then
  actionlint -no-color "${scan_files[@]}" > /tmp/actionlint.txt 2>&1 || true
  actionlint_read=0
  python3 - "$DISPOSITIONS_PATH" /tmp/actionlint.txt > /tmp/actionlint-unexpected.txt 2>/tmp/actionlint-classify.err <<'PY' || actionlint_read=$?
import re, sys, yaml
dispositions_path, report = sys.argv[1:]
rows = (yaml.safe_load(open(dispositions_path)) or {}).get("actionlint") or []
for row in rows:
    if not isinstance(row, dict) or not row.get("message"):
        sys.exit(f"malformed actionlint disposition row: {row!r}")
    if row.get("class") not in {"intentional-diagnostic", "disclosed"}:
        sys.exit(f"unknown actionlint disposition class {row.get('class')!r}")
allowed = [row["message"] for row in rows]
for line in open(report):
    if not re.match(r"^\S+\.ya?ml:\d+:\d+:", line):
        continue
    if any(message and message in line for message in allowed):
        continue
    print(line.rstrip())
PY
  if [ "$actionlint_read" -ne 0 ]; then
    leg_fail "L8 reviewers: the actionlint dispositions did not parse — $(head -c 200 /tmp/actionlint-classify.err | tr '\n' ' ') (F33)"
  fi
  actionlint_unexpected="$(wc -l < /tmp/actionlint-unexpected.txt | tr -d ' ')"
  actionlint_state="$actionlint_unexpected unexpected message(s); the \`\$/\` form and the Blacksmith label are answered in the dispositions file"
  if [ "$actionlint_unexpected" -gt 0 ]; then
    leg_fail "L8 reviewers: actionlint reports $actionlint_unexpected message(s) with no disposition"
    cat /tmp/actionlint-unexpected.txt
  fi
else
  actionlint_state="actionlint not installed"
  leg_fail "L8 reviewers: actionlint not installed, the scanner bar was not applied"
fi
if [ "$in_pr_context" = true ]; then
  # shellcheck disable=SC2016 # $owner and friends are GraphQL variables
  threads="$(gh api graphql -f query='
    query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){ pullRequest(number:$number){
        reviewThreads(first:100){ nodes{ isResolved path comments(first:1){ nodes{ author{ login } url } } } } } } }' \
    -f owner="${repo%/*}" -f name="${repo#*/}" -F number="$PR_NUMBER" 2>/dev/null \
    | jq -c '[.data.repository.pullRequest.reviewThreads.nodes[]?
      | select(.isResolved == false)
      | select(.path | startswith(".github/"))
      | select((.comments.nodes[0].author.login // "") | test("coderabbit|qodo|greptile|devin|copilot|\\[bot\\]"; "i"))
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
flush_seconds=""
if [ -n "$action_seconds" ] && [ -n "${REPRODUCE_WORKLOAD_SECONDS:-}" ] && [ -n "${BASELINE_WORKLOAD_SECONDS:-}" ]; then
  overhead_seconds=$(( REPRODUCE_WORKLOAD_SECONDS - BASELINE_WORKLOAD_SECONDS ))
  timing_state="sensor start ${action_seconds}s (budget ${START_BUDGET_SECONDS}s) · workload ${REPRODUCE_WORKLOAD_SECONDS}s with sensor vs ${BASELINE_WORKLOAD_SECONDS}s without, overhead ${overhead_seconds}s (budget ${OVERHEAD_BUDGET_SECONDS}s)"
  [ "$action_seconds" -le "$START_BUDGET_SECONDS" ] || leg_fail "L9 timing: sensor start ${action_seconds}s exceeds ${START_BUDGET_SECONDS}s"
  [ "$overhead_seconds" -le "$OVERHEAD_BUDGET_SECONDS" ] || leg_fail "L9 timing: workload overhead ${overhead_seconds}s exceeds ${OVERHEAD_BUDGET_SECONDS}s"
else
  timing_state="untested: missing job clocks (action=${action_seconds:-?} workload=${REPRODUCE_WORKLOAD_SECONDS:-?} baseline=${BASELINE_WORKLOAD_SECONDS:-?})"
fi
# The flush is the part a maintainer waits for after their own job is done: the
# action's post step, read from the job timeline rather than from the sensor.
reproduce_steps='{"steps":[]}'
[ -z "$reproduce_job_id" ] || reproduce_steps="$(job_steps "$reproduce_job_id")"
flush_seconds="$(step_seconds "$reproduce_steps" "Post $ACTION_STEP_NAME")"
if [ -n "$flush_seconds" ]; then
  flush_seconds="${flush_seconds%.*}"
  timing_state="$timing_state · post-step flush ${flush_seconds}s (budget ${FLUSH_BUDGET_SECONDS}s)"
  [ "$flush_seconds" -le "$FLUSH_BUDGET_SECONDS" ] \
    || leg_fail "L9 timing: post-step flush ${flush_seconds}s exceeds ${FLUSH_BUDGET_SECONDS}s on the light cell (F30)"
else
  # The flush is the whole reason a post step exists; if it cannot be read, the
  # budget was not checked and the leg has no business passing (F30).
  timing_state="$timing_state · post-step flush not measured"
  leg_fail "L9 timing: post-step flush not measured on the light cell — no \"Post $ACTION_STEP_NAME\" step in the reproduce job timeline (F30)"
fi
[ -z "$profile_seconds" ] || timing_state="$timing_state · profile visible ${profile_seconds}s after the job"
[ -z "$comment_seconds" ] || timing_state="$timing_state · comment final ${comment_seconds}s after the profile"
# pnpm's condition when it adopted Garnet: the smoke job must not add
# meaningful CI time (upstream issue 11626).
timing_state="$timing_state · pnpm's condition: no meaningful CI time added"

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

# What one instrumented cell does not prove, said in the comment rather than
# left to the reader (F19, F11, F32).
upstream_instrumented="$(shape_get '[.upstream.cells[]? | select(.instrumented)] | length')"
local_instrumented="$(shape_get '.coverage.local_instrumented // empty')"
if [ -n "$upstream_instrumented" ] && [ -n "$local_instrumented" ] && [ "$upstream_instrumented" != "$local_instrumented" ]; then
  leg_fail "L10 coverage: this fork instruments $local_instrumented cell(s), pnpm at main instruments $upstream_instrumented (F26)"
fi
disclose "the sensor is Linux x86_64 eBPF: macOS and Windows cells record nothing, and no change to this rollout makes them record"
disclose "fork pull requests and Dependabot-actor runs get no secret, so they produce no server-side evidence; L13 is a simulation of that path, not evidence for it"
disclose "the action fails open: a sensor that never starts leaves a green job (F2), which is why the gate reads the status file and the profile rather than the job conclusion"
disclose "\`no_bad_egress_domain\` has been attention-only in every pnpm profile and has never had a deny rule to fail against: it is not a proof of anything until pnpm has deny rules in the control plane"

# --- L11 upstream drift --------------------------------------------------------
# The gate proves something about pnpm only while it still reproduces pnpm's
# shape. Read at main during the run, not from a checked-in copy (F26).
drift_state="untested"
drift_count=0
drift_list=""
if [ -n "$shape_error" ]; then
  drift_state="upstream not read: $shape_error"
  leg_fail "L11 upstream drift: $drift_state"
else
  drift_count="$(shape_get '.drift_count // 0')"
  drift_list="$(jq -r '.drift[]? | select(.verdict == "drift") | "  - \(.field): pnpm has \(.upstream|tostring), the gate has \(.gate|tostring)"' <<<"$shape")"
  deliberate_count="$(shape_get '[.drift[]? | select(.verdict == "deliberate")] | length')"
  drift_state="pnpm/pnpm at \`${UPSTREAM_SHA:0:7}\` · $drift_count difference(s), $deliberate_count declared deliberate"
  if [ "$drift_count" -gt 0 ]; then
    leg_fail "L11 upstream drift: the gate no longer mirrors pnpm at ${UPSTREAM_SHA:0:7} — $drift_count field(s) differ (F26)"
    echo "$drift_list"
  fi
fi

# --- L12 warning noise ---------------------------------------------------------
# On a run that has a token, an annotation from the action step is a defect: the
# only warning pnpm has ever been shown there is the fail-open one of F2, and a
# reader who learns to skip warnings skips that one too (F27).
warning_count=0; error_count=0; failopen_count=0; warning_state="untested"; warning_lines=""
if [ -z "$reproduce_job_id" ]; then
  warning_state="reproduce job not resolved ($(job_ids_matching "$REPRODUCE_JOB_NAME") job(s) named \"$REPRODUCE_JOB_NAME\" in the run)"
  leg_fail "L12 warning noise: $warning_state (F35)"
else
  reproduce_log="$(job_log "$reproduce_job_id")"
  if reproduce_ann="$(job_annotation_lines "$reproduce_job_id")"; then ann_read=true; else ann_read=false; reproduce_ann=""; fi
  # Main step and post hook both: the OIDC fallback warning is printed while the
  # action starts, the flush and upload warnings after the job's steps.
  action_log=""
  if [ -n "$reproduce_log" ]; then
    action_log="$(printf '%s\n%s\n' \
      "$(step_log "$reproduce_log" "garnet-org/action@")" \
      "$(post_step_log "$reproduce_log" "$reproduce_steps" "Post $ACTION_STEP_NAME")")"
  fi
  if [ -z "$reproduce_log" ] && [ "$ann_read" != true ]; then
    warning_state="neither the log nor the check-run annotations of job $reproduce_job_id could be read"
    leg_fail "L12 warning noise: $warning_state — a leg that cannot see the annotations cannot pass (F35)"
  else
    warning_lines="$(merge_annotation_lines "$(annotations "$action_log")" "$reproduce_ann")"
    warning_count="$(grep -c '##\[warning\]' <<<"$warning_lines" || true)"
    error_count="$(grep -c '##\[error\]' <<<"$warning_lines" || true)"
    failopen_count="$(grep -ciE '##\[warning\].*(jibril (service )?failed to start|continuing without)' <<<"$warning_lines" || true)"
    unexpected=$(( warning_count - failopen_count ))
    source_state="action step and post hook from the log"
    [ -n "$reproduce_log" ] || source_state="check-run annotations only, log not archived yet: job-scoped, not attributed to a step"
    warning_state="$warning_count warning(s), $error_count error(s) — $source_state; $failopen_count are the disclosed fail-open text (F2)"
    if [ "$warning_count" -gt 0 ] || [ "$error_count" -gt 0 ]; then
      leg_fail "L12 warning noise: the action emitted $warning_count warning(s) and $error_count error(s) with api_token supplied, $unexpected of them not the disclosed fail-open text; the OIDC fallback line is garnet-org/action pull request 147, unreleased (F27)"
      head -n 10 <<<"$warning_lines" | while IFS= read -r line; do
        [ -z "$line" ] || echo "::error::L12 offending line: $line"
      done
    fi
  fi
fi

# --- L13 credential-less run ---------------------------------------------------
# A simulation of the Dependabot and fork-head path: same action, empty
# api_token, read-only token. Exit 0, one info line, no warning, no error, green
# job (F28). It produces no profile and none is claimed.
sim_state="untested"
sim_warnings=0; sim_errors=0; sim_info=0
if [ -z "$dependabot_job_id" ]; then
  sim_state="simulation job not resolved ($(job_ids_matching "$DEPENDABOT_SIM_JOB_NAME") job(s) named \"$DEPENDABOT_SIM_JOB_NAME\" in the run)"
  leg_fail "L13 credential-less: $sim_state (F35)"
else
  sim_log="$(job_log "$dependabot_job_id")"
  sim_steps="$(job_steps "$dependabot_job_id")"
  if sim_ann="$(job_annotation_lines "$dependabot_job_id")"; then sim_ann_read=true; else sim_ann_read=false; sim_ann=""; fi
  sim_action_log=""
  if [ -n "$sim_log" ]; then
    sim_action_log="$(printf '%s\n%s\n' \
      "$(step_log "$sim_log" "garnet-org/action@")" \
      "$(post_step_log "$sim_log" "$sim_steps" "Post $SIM_ACTION_STEP_NAME")")"
  fi
  sim_conclusion="$(step_conclusion "$sim_steps" "$SIM_ACTION_STEP_NAME")"
  sim_evidence="$(merge_annotation_lines "$sim_action_log" "$sim_ann")"
  sim_warnings="$(grep -c '##\[warning\]' <<<"$sim_evidence" || true)"
  sim_errors="$(grep -c '##\[error\]' <<<"$sim_evidence" || true)"
  # The action explains the skip in a warning annotation, not an info line. The
  # explanation is what the leg is for, so the annotation counts as one and the
  # form it takes is stated rather than failed on.
  sim_info="$(grep -ciE "api_token' is required|no api token|without runtime monitoring|skipping" <<<"$sim_evidence" || true)"
  sim_state="outcome ${DEPENDABOT_SIM_OUTCOME:-unknown} · step $sim_conclusion · $sim_info line(s) naming the missing token, carried as $sim_warnings warning annotation(s), $sim_errors error(s)"
  if [ -z "$sim_log" ] && [ "$sim_ann_read" != true ]; then
    sim_state="neither the log nor the check-run annotations of job $dependabot_job_id could be read"
    leg_fail "L13 credential-less: $sim_state — silence the leg cannot see is not a clean skip (F35)"
  elif [ "${DEPENDABOT_SIM_OUTCOME:-}" != success ] || [ "$sim_errors" -gt 0 ] || [ "$sim_conclusion" != success ]; then
    leg_fail "L13 credential-less: an empty api_token did not skip cleanly — $sim_state (F28)"
  elif [ "$sim_info" -lt 1 ]; then
    leg_fail "L13 credential-less: the action skipped silently; a credential-less run has to say why (F28)"
  elif [ "$sim_warnings" -gt 0 ]; then
    disclose "L13 credential-less: the explanation arrives as a ##[warning] annotation, not an info line — intended on this path, and unlike L12 it is not noise on a token run (F28)"
    mark_disclosed L13
  fi
fi
disclose "L13 is a simulation on this repository's own event with a read-only token, not a Dependabot run: it shows what the action does without a token, and no server-side evidence exists for Dependabot or fork pull requests (F11, F12)"

# --- L14 release and tag workflows ---------------------------------------------
# Where pnpm has put Garnet steps outside CI, and what each one records. A
# macOS step is a disclosure; a Linux step that records nothing is a fault (F29).
release_state="untested"
release_inert=0
if [ -n "$shape_error" ]; then
  release_state="upstream not read: $shape_error"
else
  release_state="$(jq -r '[.release_workflows[]? | "\(.workflow) `\(.job)` on `\(.runner)`: profile \(.produces_profile) (\(.reason))"] | join(" · ")' <<<"$shape")"
  [ -n "$release_state" ] || release_state="no Garnet steps in release.yml or update-latest.yml"
  release_inert="$(shape_get '[.release_workflows[]? | select(.produces_profile == "unknown")] | length')"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    disclose "$line"
  done < <(jq -r '.release_workflows[]? | select(.produces_profile == "no") | "\(.workflow) runs a Garnet step in `\(.job)` on `\(.runner)` and records nothing: \(.reason) (F13)"' <<<"$shape")
  if [ "${release_inert:-0}" -gt 0 ]; then
    leg_fail "L14 release and tag: $release_inert Garnet step(s) on a runner the gate cannot classify (F29)"
  fi
fi

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
  --arg tag "$GATE_TAG" --arg resolved_version "${STARTUP_VERSION:-}" --arg action_sha "$action_ref" --arg upstream_action_sha "$upstream_action_ref" \
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
  --argjson disclosures "$(to_json_array "${disclosures[@]:-}")" \
  --arg flush_seconds "$flush_seconds" --arg flush_budget "$FLUSH_BUDGET_SECONDS" --arg start_budget "$START_BUDGET_SECONDS" \
  --arg upstream_sha "$UPSTREAM_SHA" --arg upstream_repo "$UPSTREAM_REPO" --arg drift_state "$drift_state" --argjson drift "$(shape_get '.drift // []')" \
  --arg warning_state "$warning_state" --argjson warnings "${warning_count:-0}" --argjson errors "${error_count:-0}" --argjson failopen "${failopen_count:-0}" \
  --arg sim_state "$sim_state" --arg sim_outcome "${DEPENDABOT_SIM_OUTCOME:-}" \
  --arg release_state "$release_state" --argjson release_workflows "$(shape_get '.release_workflows // []')" \
  --arg comment_content "$comment_content" --arg mirror_state "$mirror_state" --argjson app_comments "${app_comments:-0}" \
  --arg actionlint_state "$actionlint_state" --argjson zizmor_unclassified "${zizmor_unclassified:-0}" \
  --argjson gate_attribution "$(shape_get '.gate.attribution // {}')" --argjson upstream_attribution "$(shape_get '.upstream.attribution // {}')" \
  --arg action_default_version "$action_default_version" \
  '{verdict: $verdict, fail_reasons: $fail_reasons, attention: $attention, disclosures: $disclosures,
    jibril: {requested_tag: $tag, resolved_version: $resolved_version},
    action_sha: $action_sha,
    action_default_jibril_version: $action_default_version,
    upstream: {repo: $upstream_repo, sha: $upstream_sha, action_sha: $upstream_action_sha, attribution: $upstream_attribution},
    run: {id: $run_id, attempt: $run_attempt, runner: $runner, event: $event, pr: $pr},
    commits: {base: $base_sha, head: $head_sha, merge: $merge_sha, merge_now: $current_merge_sha, profile: $profile_sha, previous: $previous_sha,
              comparison: $comparison, synthetic_merge: $synthetic_merge},
    legs: {
      L1_startup: {verdict: $startup_verdict, reason: $startup_reason, unit: $unit, github_steps: $steps_status, workflow_ref: $workflow_ref},
      L2_profile: {state: $profile_state, id: $profile_id, ref: $profile_ref, egress_peers: $peers, destinations: $destinations, egress: $egress},
      L3_workload: $workload_state,
      L4_app_comment: {state: $comment_state, url: $comment_url, comments_on_pr: $app_comments, body: $comment_content, mirror: $mirror_state},
      L5_permalink: {url: $permalink, html: $permalink_html, api: $permalink_api},
      L6_posture: {state: $shape_state, failed: $shape_fail, inert_garnet_steps: $macos_garnet},
      L7_integration_run: {state: $integration_state, run_id: $integration_run_id, profile_id: $integration_profile_id},
      L8_reviewers: {zizmor: $zizmor_state, zizmor_findings: $zizmor_findings, zizmor_pedantic: $zizmor_pedantic,
                     zizmor_unclassified: $zizmor_unclassified, actionlint: $actionlint_state, unresolved_bot_threads: $bot_threads},
      L9_timing: {state: $timing_state, sensor_start_seconds: $action_seconds, start_budget_seconds: $start_budget,
                  overhead_seconds: $overhead_seconds, overhead_budget_seconds: $overhead_budget,
                  flush_seconds: $flush_seconds, flush_budget_seconds: $flush_budget,
                  profile_seconds: $profile_seconds, comment_seconds: $comment_seconds},
      L10_coverage: $coverage_state,
      L11_upstream_drift: {state: $drift_state, upstream_sha: $upstream_sha, drift: $drift},
      L12_warning_noise: {state: $warning_state, warnings: $warnings, errors: $errors, disclosed_fail_open: $failopen},
      L13_credential_less: {state: $sim_state, outcome: $sim_outcome, simulation: true},
      L14_release_and_tag: {state: $release_state, workflows: $release_workflows},
      attribution: $gate_attribution}}' > /tmp/gate-record.json

run_url="https://github.com/$repo/actions/runs/$run_id"
profile_short="${profile_sha:0:7}"

# The comment is read on a phone as often as on a desktop, so the verdict is the
# first line, every leg is one short row, and anything long lives under the
# table instead of stretching it.
one_line() { # $1 text -> one line, at most 96 characters
  local text
  text="$(tr '\n' ' ' <<<"$1" | tr -s ' ' | sed 's/^ //; s/ $//; s/|/\\|/g')"
  if [ "${#text}" -gt 96 ]; then printf '%s…' "${text:0:95}"; else printf '%s' "$text"; fi
}
leg_state() { # $1 leg id -> FAIL when any failure names it
  local reason
  for reason in ${fail_reasons[@]+"${fail_reasons[@]}"}; do
    case "$reason" in "$1 "*|"$1:"*) printf FAIL; return ;; esac
  done
  local leg
  for leg in ${disclosed_legs[@]+"${disclosed_legs[@]}"}; do
    [ "$leg" = "$1" ] && { printf DISCLOSED; return; }
  done
  printf PASS
}
leg_row() { # $1 id, $2 title, $3 state text, $4 link
  local state
  state="$(leg_state "$1")"
  case "$3" in "not applicable"*|untested*|unknown*) [ "$state" = PASS ] && state="n/a" ;; esac
  [ "$state" = DISCLOSED ] && state="disclosed"
  printf '| **%s** | %s %s | %s%s |\n' "$state" "$1" "$2" "$(one_line "$3")" "${4:+ [→]($4)}"
}
failed_legs=0
for _reason in ${fail_reasons[@]+"${fail_reasons[@]}"}; do failed_legs=$((failed_legs + 1)); done

{
  echo "<!-- garnet:jibril-release-gate $GATE_TAG -->"
  echo "## Jibril release gate: **$verdict**"
  echo
  if [ "$verdict" = PASS ]; then
    echo "\`$GATE_TAG\` on \`garnet-org/action@${action_ref:0:7}\` cleared all 14 legs of the pnpm acceptance bar."
  else
    echo "\`$GATE_TAG\` on \`garnet-org/action@${action_ref:0:7}\`: **$failed_legs failing check(s)** below, each named with its ledger row."
  fi
  echo
  echo "| | leg | what it found |"
  echo "|---|---|---|"
  leg_row L1 "startup" "$startup_verdict — ${STARTUP_REASON:-}" "$run_url"
  leg_row L2 "profile" "$profile_state${profile_id:+ · \`$profile_id\`} · $destinations destinations" "$permalink"
  leg_row L3 "workload" "$workload_state" "$permalink"
  leg_row L4 "App comment" "$comment_state · $comment_content · $mirror_state" "$comment_url"
  leg_row L5 "permalink" "html $permalink_html · api $permalink_api" "$permalink"
  leg_row L6 "posture" "$shape_state" ""
  leg_row L7 "pnpm's own run" "$integration_state" ""
  leg_row L8 "scanners" "$zizmor_state · actionlint $actionlint_state · $bot_threads open bot thread(s)" ""
  leg_row L9 "timing" "$timing_state" ""
  leg_row L10 "coverage" "$coverage_state" ""
  leg_row L11 "upstream drift" "$drift_state" "https://github.com/$UPSTREAM_REPO/blob/${UPSTREAM_SHA:-main}/.github/workflows/test.yml"
  leg_row L12 "warning noise" "$warning_state" "$run_url"
  leg_row L13 "credential-less (simulation)" "$sim_state" "$run_url"
  leg_row L14 "release and tag" "$release_state" ""
  if [ "$verdict" = FAIL ]; then
    echo
    echo "### Failing legs"
    echo
    for r in ${fail_reasons[@]+"${fail_reasons[@]}"}; do echo "- $r"; done
    [ -z "$bot_thread_list" ] || echo "$bot_thread_list"
    [ -z "$drift_list" ] || { echo; echo "$drift_list"; }
  fi
  if [ "${#attention[@]}" -gt 0 ] || [ "${#disclosures[@]}" -gt 0 ]; then
    echo
    echo "### Disclosed, not failing"
    echo
    for a in ${attention[@]+"${attention[@]}"}; do echo "- $a"; done
    for d in ${disclosures[@]+"${disclosures[@]}"}; do echo "- $d"; done
  fi
  echo
  echo "### Record"
  echo
  echo "| field | value |"
  echo "|---|---|"
  echo "| jibril | requested \`$GATE_TAG\` · resolved \`${STARTUP_VERSION:-unknown}\` |"
  echo "| action | \`garnet-org/action@${action_ref:0:12}\` · empty \`jibril_version\` there resolves to \`$action_default_version\` |"
  echo "| run | [$run_id]($run_url) attempt $run_attempt · \`${RUNNER_NAME_USED:-}\` · $EVENT_NAME |"
  echo "| pnpm at main | \`${UPSTREAM_SHA:0:7}\` · action \`${upstream_action_ref:0:12}\` → \`$upstream_action_default_version\` |"
  echo "| workflow ref seen by sensor | \`${STARTUP_WORKFLOW_REF:-absent}\` |"
  if [ "$in_pr_context" = true ]; then
    echo "| base → head | \`${PR_BASE_SHA:0:7}\` → \`${PR_HEAD_SHA:0:7}\` |"
    echo "| merge sha | at run \`${merge_sha:0:7}\` · now \`${current_merge_sha:0:7}\` · profile \`${profile_short:-none}\` |"
    echo "| comparison | ${comparison:-n/a}${previous_sha:+ (previous \`${previous_sha:0:7}\`)} |"
    echo "| synthetic merge | $synthetic_merge |"
  else
    echo "| commit | \`${merge_sha:0:7}\` · profile \`${profile_short:-none}\` · no base/head pair |"
  fi
  [ -z "$permalink" ] || echo "| permalink | $permalink |"
  echo
  echo "<sub>Legs map to past failures in [\`$LEDGER_PATH\`](https://github.com/$repo/blob/$merge_sha/$LEDGER_PATH). Full record in the run's \`garnet-release-gate\` artifact.</sub>"
} > /tmp/gate-comment.md

cat /tmp/gate-comment.md >> "$GITHUB_STEP_SUMMARY"
{
  echo "verdict=$verdict"
  echo "profile_id=$profile_id"
  echo "permalink=$permalink"
} >> "$GITHUB_OUTPUT"
jq . /tmp/gate-record.json
