#!/usr/bin/env bash
# Verifies the evidence chain behind a Garnet Jibril release-gate run and writes
# one record of it: startup -> profile uploaded -> workload recorded -> App
# comment final -> public permalink 200.
#
# Reads the startup verdict from the reproduce job (env STARTUP_*), then asks
# the control plane and GitHub for what the sensor actually produced. Every
# leg is recorded with the exact identifiers a reader needs to re-check it.
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

run_id="$GITHUB_RUN_ID"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
repo="$GITHUB_REPOSITORY"
merge_sha="$GITHUB_SHA"
action_ref="$(grep -oE 'garnet-org/action@[0-9a-f]{40}' .github/workflows/garnet-jibril-release-gate-job.yml | head -n1 | cut -d@ -f2)"
in_pr_context=false
[ "${EVENT_NAME:-}" = pull_request ] && [ -n "${PR_NUMBER:-}" ] && in_pr_context=true

fail_reasons=()
note() { echo "::notice::$*"; }
leg_fail() { fail_reasons+=("$1"); echo "::error::$1"; }

# --- 1. startup ---------------------------------------------------------------
startup_verdict="${STARTUP_VERDICT:-FAIL}"
[ "$startup_verdict" = PASS ] || leg_fail "startup: ${STARTUP_REASON:-no verdict from reproduce job}"

# --- 2. profile uploaded -------------------------------------------------------
# The gate runs exactly one instrumented job per run, so the run-level lookup
# is exact; the job/attempt check keeps it that way if the shape changes.
profile_json=""
profile_state="absent"
deadline=$((SECONDS + POLL_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  code="$(curl -sS -o /tmp/profile.json -w '%{http_code}' \
    -H "X-Project-Token: $GARNET_API_TOKEN" \
    "$GARNET_API_URL/api/v1/profiles/$run_id" || echo 000)"
  if [ "$code" = 200 ]; then
    profile_json="$(cat /tmp/profile.json)"
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
    '[.data.network.egress.peers[]? | select(.remote_names[]? == $dest) | .proc_trees[]?.github_step] | unique' <<<"$profile_json")"
  peers="$(jq '[.data.network.egress.peers[]?] | length' <<<"$profile_json")"
  destinations="$(jq '[.data.network.egress.peers[]? | .remote_names[]?] | unique | length' <<<"$profile_json")"
  if [ "$profile_job" = "$REPRODUCE_JOB" ] && [ "$profile_attempt" = "$run_attempt" ]; then
    profile_state="uploaded"
  else
    profile_state="uploaded, but job=$profile_job attempt=$profile_attempt (expected $REPRODUCE_JOB/$run_attempt)"
    leg_fail "profile: $profile_state"
  fi
else
  leg_fail "profile: $profile_state after ${POLL_SECONDS}s (run $run_id)"
fi

# --- 3. workload recorded ------------------------------------------------------
# A workload step that itself failed (registry outage) leaves this leg untested
# rather than failing a gate whose sensor did its job.
workload_state="untested"
if [ "${WORKLOAD_OUTCOME:-}" != success ]; then
  workload_state="untested: workload step outcome=${WORKLOAD_OUTCOME:-unknown}"
elif [ -n "$profile_json" ]; then
  if jq -e --arg step "$WORKLOAD_STEP_NAME" 'map(select(contains($step))) | length > 0' <<<"$workload_steps" >/dev/null; then
    workload_state="recorded: $WORKLOAD_DESTINATION reached from step \"$WORKLOAD_STEP_NAME\""
  elif jq -e --arg dest "$WORKLOAD_DESTINATION" 'index($dest) != null' <<<"$egress_names" >/dev/null; then
    workload_state="destination present, but attributed to steps $workload_steps"
    leg_fail "workload: $workload_state"
  else
    workload_state="not recorded: $WORKLOAD_DESTINATION absent from profile egress"
    leg_fail "workload: $workload_state"
  fi
fi

# --- 4. App comment final ------------------------------------------------------
# Only refs/pull/N/merge runs get a Runtime Review comment; other triggers
# record this leg as not applicable.
comment_state="not applicable (event=${EVENT_NAME:-unknown})"
comment_url=""; summary_json=""; previous_sha=""; comparison=""
if [ "$in_pr_context" = true ]; then
  comment_state="absent"
  deadline=$((SECONDS + POLL_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    comments="$(gh api "repos/$repo/issues/$PR_NUMBER/comments" --paginate 2>/dev/null | jq -s 'add // []')"
    match="$(jq -c --arg head "$PR_HEAD_SHA" '
      [.[] | select(.user.login == "garnet-runtime-review[bot]" or .user.login == "garnet-runtime-review-dev[bot]")
           | select((.body // "") | contains("<!-- garnet:commit " + $head + " -->"))] | last // empty' <<<"$comments")"
    if [ -n "$match" ]; then
      comment_url="$(jq -r '.html_url' <<<"$match")"
      if jq -e '.body | contains("<!-- garnet-control-plane-pr-comment:v1")' <<<"$match" >/dev/null; then
        comment_state="final"
        summary_json="$(jq -r '.body | capture("<!-- garnet:summary (?<s>.*?) -->").s // ""' <<<"$match")"
        break
      fi
      comment_state="pending"
    fi
    sleep 15
  done
  if [ "$comment_state" != final ]; then
    leg_fail "app comment: $comment_state after ${POLL_SECONDS}s for head $PR_HEAD_SHA (profile sha $profile_sha, current merge sha $merge_sha)"
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

# --- 5. public permalink -------------------------------------------------------
permalink=""; permalink_html=000; permalink_api=000
if [ -n "$profile_id" ]; then
  permalink="$GARNET_APP_URL/public/runs/$run_id?profile=$profile_id"
  permalink_html="$(curl -sS -o /dev/null -w '%{http_code}' "$permalink" || echo 000)"
  permalink_api="$(curl -sS -o /dev/null -w '%{http_code}' "$GARNET_APP_URL/api/public/runs/$run_id?profile=$profile_id" || echo 000)"
  [ "$permalink_html" = 200 ] && [ "$permalink_api" = 200 ] || leg_fail "permalink: html=$permalink_html api=$permalink_api"
fi

# --- verdict + record ----------------------------------------------------------
verdict=PASS
[ "${#fail_reasons[@]}" -eq 0 ] || verdict=FAIL
synthetic_merge=no
if [ -n "$profile_sha" ] && [ -n "${PR_HEAD_SHA:-}" ] && [ "$profile_sha" != "$PR_HEAD_SHA" ]; then
  synthetic_merge="yes · sensor recorded merge commit \`${profile_sha:0:7}\`, PR head is \`${PR_HEAD_SHA:0:7}\`"
fi

jq -n \
  --arg verdict "$verdict" --argjson fail_reasons "$(printf '%s\n' "${fail_reasons[@]:-}" | jq -R . | jq -s 'map(select(length > 0))')" \
  --arg tag "$GATE_TAG" --arg resolved_version "${STARTUP_VERSION:-}" --arg action_sha "$action_ref" \
  --arg run_id "$run_id" --arg run_attempt "$run_attempt" --arg runner "${RUNNER_NAME_USED:-}" \
  --arg event "${EVENT_NAME:-}" --arg pr "${PR_NUMBER:-}" \
  --arg base_sha "${PR_BASE_SHA:-}" --arg head_sha "${PR_HEAD_SHA:-}" --arg merge_sha "$merge_sha" \
  --arg startup_verdict "$startup_verdict" --arg startup_reason "${STARTUP_REASON:-}" \
  --arg unit "${STARTUP_UNIT:-}" --arg steps_status "${STARTUP_STEPS_STATUS:-}" --arg workflow_ref "${STARTUP_WORKFLOW_REF:-}" \
  --arg profile_state "$profile_state" --arg profile_id "$profile_id" --arg profile_sha "$profile_sha" --arg profile_ref "$profile_ref" \
  --argjson peers "$peers" --argjson destinations "$destinations" --argjson egress "$egress_names" \
  --arg workload_state "$workload_state" \
  --arg comment_state "$comment_state" --arg comment_url "$comment_url" --arg previous_sha "$previous_sha" --arg comparison "$comparison" \
  --arg synthetic_merge "$synthetic_merge" \
  --arg permalink "$permalink" --arg permalink_html "$permalink_html" --arg permalink_api "$permalink_api" \
  '{verdict: $verdict, fail_reasons: $fail_reasons,
    jibril: {requested_tag: $tag, resolved_version: $resolved_version},
    action_sha: $action_sha,
    run: {id: $run_id, attempt: $run_attempt, runner: $runner, event: $event, pr: $pr},
    commits: {base: $base_sha, head: $head_sha, merge: $merge_sha, profile: $profile_sha, previous: $previous_sha,
              comparison: $comparison, synthetic_merge: $synthetic_merge},
    startup: {verdict: $startup_verdict, reason: $startup_reason, unit: $unit, github_steps: $steps_status, workflow_ref: $workflow_ref},
    profile: {state: $profile_state, id: $profile_id, ref: $profile_ref, egress_peers: $peers, destinations: $destinations, egress: $egress},
    workload: $workload_state,
    app_comment: {state: $comment_state, url: $comment_url},
    permalink: {url: $permalink, html: $permalink_html, api: $permalink_api}}' > /tmp/gate-record.json

run_url="https://github.com/$repo/actions/runs/$run_id"
{
  echo "<!-- garnet:jibril-release-gate $GATE_TAG -->"
  echo "### Jibril release gate · \`$GATE_TAG\` · **$verdict**"
  echo
  echo "| leg | result |"
  echo "|---|---|"
  echo "| startup | $startup_verdict — ${STARTUP_REASON:-} |"
  echo "| profile | $profile_state${profile_id:+ · \`$profile_id\`} · $peers egress peers, $destinations destinations |"
  echo "| workload | $workload_state |"
  echo "| App comment | $comment_state${comment_url:+ · $comment_url} |"
  echo "| permalink | html $permalink_html · api $permalink_api${permalink:+ · $permalink} |"
  echo
  echo "| record | value |"
  echo "|---|---|"
  echo "| jibril | requested \`$GATE_TAG\` · resolved \`${STARTUP_VERSION:-unknown}\` |"
  echo "| action | \`garnet-org/action@$action_ref\` |"
  echo "| run | [$run_id]($run_url) attempt $run_attempt · \`${RUNNER_NAME_USED:-}\` · $EVENT_NAME |"
  echo "| workflow ref seen by sensor | \`${STARTUP_WORKFLOW_REF:-absent}\` |"
  if [ "$in_pr_context" = true ]; then
    echo "| base → head | \`${PR_BASE_SHA:0:7}\` → \`${PR_HEAD_SHA:0:7}\` |"
    echo "| merge sha at run | \`${merge_sha:0:7}\` · profile recorded \`${profile_sha:0:7}\` (\`$profile_ref\`) |"
    echo "| comparison in comment | ${comparison:-n/a}${previous_sha:+ (previous \`${previous_sha:0:7}\`)} |"
    echo "| synthetic merge | $synthetic_merge |"
  else
    echo "| commit | \`${merge_sha:0:7}\` · profile recorded \`${profile_sha:0:7}\` (\`$profile_ref\`) · no base/head pair |"
  fi
  if [ "$verdict" = FAIL ]; then
    echo
    echo "Failing legs:"
    for r in "${fail_reasons[@]}"; do echo "- $r"; done
  fi
} > /tmp/gate-comment.md

cat /tmp/gate-comment.md >> "$GITHUB_STEP_SUMMARY"
echo "verdict=$verdict" >> "$GITHUB_OUTPUT"
echo "profile_id=$profile_id" >> "$GITHUB_OUTPUT"
echo "permalink=$permalink" >> "$GITHUB_OUTPUT"
jq . /tmp/gate-record.json
