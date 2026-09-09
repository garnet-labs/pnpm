# Garnet release gate: failure ledger

Every failure the Garnet integration has had on pnpm, and the gate leg that
catches it now. The gate is `.github/workflows/garnet-jibril-release-gate.yml`;
the legs live in `.github/scripts/garnet-release-gate-verify.sh`.

Rules that keep this ledger and the gate the same thing:

1. A new failure gets a row here and a leg (or a check inside a leg) in the
   verifier in the same pull request. A row without a leg is a gap; a leg
   without a row is unexplained.
2. Every pull request on this fork that tests Garnet product or release work
   for pnpm carries the label `garnet-release-testing`. The gate runs on the
   label, reports on the pull request, and its verdict is the acceptance
   result. An unlabelled test pull request has not been accepted.
3. A gate leg is PASS/FAIL when a machine can decide it, and a disclosure line
   when only a reader can. Disclosures are printed under "Disclosed, not
   failing" and never hidden.
4. Two lines in the gate are deliberate reproductions, not mistakes: the
   `uses: $/.github/workflows/...` self-repository form and the
   `blacksmith-8vcpu-ubuntu-2404` runner label. Both are the exact shape that
   failed upstream. Scanners that flag them are answered, not obeyed.

| id | seen | what failed | where | leg |
|---|---|---|---|---|
| F1 | 2026-09-02 | Jibril v2.16.0 exits at startup on `uses: $/.github/workflows/test.yml`; the job stays green, no profile | upstream since pull 14452; fork run 33903453741 (journal) | L1 startup on the `$/` shape; L7 integration run on pnpm's own TS CI job |
| F2 | 2026-09-02 | Action reports "Jibril service failed to start" as a warning and continues; 654 upstream runs green with zero events | upstream CI | L1 + L2: exit 0 is not a pass, only the status file and a profile are |
| F3 | 2026-08 | Profile lost on 45-minute heavy jobs (about 1 in 10 on v2.16.0) | fork PR 32 | L2 profile for this run/job/attempt; L9 records flush latency |
| F4 | 2026-09-02 | Profile uploaded, App comment stays "in progress": GitHub regenerated the merge commit after the base moved, control plane skipped the profile as stale | fork PR 33 (profile `31fdd5e`, merge now `6ab1ab0`) | L4 names the cause from profile sha vs current merge sha |
| F5 | 2026-09-05 | Same as F4 with no base move: two merge commits one second apart for the same head | fork PR 41 (`1992b62` vs `b9ad3b6`), PR 32 (`87295a8` vs `6d63f74`) | L4 |
| F6 | 2026-09-04 | No profile at all, App comment placeholder never resolves | fork PR 36, PR 43 (rc.9 on `$/`) | L4 names "no profile" as the cause; L2 fails first |
| F7 | 2026-09-05 | Destination reached from runner background, not from the recorded step | fork gate design | L3 workload attribution to the named step |
| F8 | 2026-09-08 | Profile lookup answered HTTP 403, read as an auth error instead of "no profile yet" | fork PR 43 | L2 polls on 403 and 404 alike |
| F9 | 2026-09 | Workload step failure aborted the job before the verdict was written | fork PR 43 | reproduce steps `continue-on-error`, verify job `if: always()` |
| F10 | 2026-09 | Scheduled gate posted a new comment on every run | fork PR 36 | per-tag marker, comment updated in place |
| F11 | 2026-08-28 | Fork pull requests get no secret and no OIDC token; the sensor is silently skipped | fork PR 18 (Qodo) | L10 discloses; not fixable in this rollout |
| F12 | 2026-09-08 | Dependabot-actor runs receive an empty `GARNET_API_TOKEN` | upstream pull 13270 | L6 discloses when ci.yml passes the token explicitly |
| F13 | 2026-08 | Garnet steps on macOS release jobs never record; CodeRabbit and Qodo flagged them | fork PR 33, PR 18; upstream release.yml | L6 counts them as a disclosure |
| F14 | 2026-08 | `id-token: write` added for the sensor; a permission ask pnpm did not agree to | fork pin PRs | L6 fails on `id-token: write`, `secrets: inherit`, or `pull-requests: write` added by the PR |
| F15 | 2026-07 | Action ref not pinned to a full SHA, or sensor floating on `latest` | pnpm v2.2.0 era | L6 fails on unpinned refs and prints the sensor version source |
| F16 | 2026-09 | zizmor findings on the workflow files a test PR touched (undocumented permissions, anonymous job, missing concurrency) | fork PR 43 | L8 runs zizmor at pnpm's persona on touched files |
| F17 | 2026-09 | Bot review threads (Greptile, Devin, Qodo, CodeRabbit) left open on workflow files | fork PR 41, PR 43 | L8 fails on unresolved bot threads under `.github/` |
| F18 | 2026-08 | Overhead of the sensor on the instrumented job, which pnpm named as a condition | upstream issue 11626 | L9 baseline job without the sensor, overhead budget |
| F19 | 2026-09-08 | One instrumented cell (Node 24 on Blacksmith Ubuntu) read as coverage of all six | upstream ci.yml | L10 prints instrumented and uninstrumented cells |
| F20 | 2026-09-08 | Verdict read from the GitHub job status; a green job proved nothing | all of the above | the only PASS/FAIL is the verify job's conclusion |
| F21 | 2026-09-09 | Jibril v2.17.0-rc.10 started on the `$/` shape but reported `github.steps.status=degraded` (`job reproduce not found`): the caller job id differed from the called workflow's job id, and the egress was attributed to `<unknown>` | fork run 34309875655 | caller job id equals the callee job id, as pnpm's `test` calls `test`; L1 requires `steps.status=ok`, L3 requires attribution to the workload step |
| F22 | 2026-09-09 | Verify job token lacked `actions: read`; listing runs failed and L7 read the failure as "no TS CI run found" while run 34288898271 existed | fork run 34309875655 | `actions: read` on the verify job; L7 fails on a listing error instead of reporting an absent run |
| F23 | 2026-09-09 | With step discovery `ok`, the workload egress still recorded on step `<unknown>`: the workload step carried `id: workload`. GitHub sets `GITHUB_ACTION` to a step's id; Jibril derives `__run_N` from the workflow file, so a `run:` step with an id never matches. pnpm's install and test steps have no id, its `Determine test scope` step does | fork run 34310387514 | the workload step has no `id:` and logs `GITHUB_ACTION`; the workload outcome travels through a file to the assert step |
| F24 | 2026-09-09 | The control plane answers HTTP 403 for a run it never received, the same code as a token without access; L7 printed the code without saying so | fork run 34310387514 (TS CI run 34310387441 on v2.2.0 → `latest` = v2.16.0) | L7 names 403 as "no profile bound to the run" |
