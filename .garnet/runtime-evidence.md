# Garnet Runtime Evidence — PR #17 (pnpm 12.0.0-rc.7 pin + engineStrict relaxation)

This file is a head-SHA-bound runtime receipt for this PR's instrumented CI
job. It is generated from kernel-level recording (Garnet / Jibril eBPF sensor)
of the actual workflow execution — not from static analysis of the diff.

## Recorded run

| Field | Value |
| --- | --- |
| Workflow / job | `TS CI` / `test` |
| Run | <https://github.com/garnet-labs/pnpm/actions/runs/32200786939> |
| Execution Profile (receipt) | <https://app.garnet.ai/public/runs/32200786939?profile=01a0178d-35d3-7bc7-b747-83b1cf9d88e3> |
| Recorded commit | `b1298136371b1535989e7348c5fede0aa589a793` (this PR's dependency update) |
| Baseline | none — first recording on this branch (full profile, not a diff) |
| Recorded at | 2026-08-19 01:03:22 UTC |
| Scope | 169 execution chains · 27 network destinations · kinds: network |

## Observed outbound destinations, by origin

### Install/build/test-tooling chains (attributable to this PR's execution)

Recorded under `node`/`pnpm` processes, largely in the step
"Validate test chunk inputs":

| Destination | Expected for this repo? |
| --- | --- |
| `registry.npmjs.org` | Yes — primary registry |
| `github.com`, `codeload.github.com` | Yes — git-hosted deps / tarballs |
| `nodejs.org` | Yes — pnpm node runtime fetch |
| `productionresultssa14.blob.core.windows.net` | Yes — GitHub Actions artifact storage |
| `node-registry.bit.cloud` | **Not in the expected set — flag for maintainer classification** |
| `npm.jsr.io` | **Not in the expected set — flag for maintainer classification** |
| `unofficial-builds.nodejs.org` | **Not in the expected set — flag for maintainer classification** (non-official Node binary source) |
| `pnpm.io` | Borderline — project website contacted from a `node` child process |

The three flagged destinations were contacted by `node` execution chains
during test-chunk validation on a PR whose static diff is manifest/lockfile
only (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`). This PR also
disables engine strictness, which widens what future installs will accept.

### Runner-platform chains (NOT attributable to this PR)

`nginx`, `chronyd` (NTP pool), `snapd` (`api.snapcraft.io`, snapcraft CDN),
`blacksmithd` (`192.168.127.1`), and GitHub control-plane IPs — Blacksmith
runner VM platform behavior. Do not attribute these to the change under
review.

## Machine-readable summary

```json
{
  "contract": "6.10.0",
  "recorded_commit": "b1298136371b1535989e7348c5fede0aa589a793",
  "baseline_commit": null,
  "jobs_recorded": 1,
  "chains": 169,
  "destinations_total": 27,
  "tooling_destinations_expected": ["registry.npmjs.org", "github.com", "codeload.github.com", "nodejs.org", "productionresultssa14.blob.core.windows.net"],
  "tooling_destinations_flagged": ["node-registry.bit.cloud", "npm.jsr.io", "unofficial-builds.nodejs.org"],
  "platform_attributed": ["nginx", "chronyd", "snapd", "blacksmithd"],
  "verdict": "3 tooling destinations outside the expected registry set — require classification before merge"
}
```

## Staleness rule

This evidence is bound to recorded commit `b129813`. Commits on this branch
after that SHA touch only `.garnet/**` (review metadata), so the recorded run
remains representative of the change under review. Garnet re-records on every
push; the latest live profile is in the `garnet-runtime-review` PR comment
bound to the current head SHA.
