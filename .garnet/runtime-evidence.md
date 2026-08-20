# Garnet runtime evidence

Kernel-recorded Execution Profiles of this branch's own CI runs (Garnet / Jibril
eBPF sensor). Every entry below is taken from the recorded profiles, not from
static analysis of the diff.

## Comparison pairs

| Pair | Scope | What it shows |
| --- | --- | --- |
| `ccf2ed2` → `022027a` | the PR's semantic change | baseline fixture (installs `is-positive@1.0.0` from the public registry) → adds `bcrypt@5.1.1` with `allowBuilds: bcrypt: true`, so the dependency's install script is permitted to run |
| `dee2ac6` → `499bb2c` (head) | latest recorded pair | metadata-only commits (profile re-record, action pin); workload unchanged, as expected |

## Head recording (`499bb2c`)

| Field | Value |
| --- | --- |
| Jobs recorded | 2 (`Native build install` / `native-build-install`, `TS CI` / `test`) |
| Compared with | `dee2ac6` (previous recording on this branch) |
| Totals | 35 execution chains · 15 destinations · kinds: network |
| Recorded at | 2026-08-20 01:24 UTC |
| Contract | 6.10.0 |

Execution Profile receipts:

- `Native build install` / `native-build-install`: <https://app.garnet.ai/public/runs/32320537006?profile=01a01cc0-c975-7c16-9130-e030b74b05c9>
- `TS CI` / `test`: <https://app.garnet.ai/public/runs/32320537149?profile=01a01cc5-cd74-7f0e-b2ac-e9ef282cb7c4>

## Recorded workload behavior of the fixture install

From the `native-build-install` job's profile (head): the fixture install runs

```text
pnpm (step: "Install fixture")
├─ dash
│  └─ node
│     ├─ → github.com
│     └─ → release-assets.githubusercontent.com
└─ → registry.npmjs.org
```

The `dash → node → github.com / release-assets.githubusercontent.com` chain is
`bcrypt`'s install script fetching its prebuilt native binding — runtime
behavior that exists only because `022027a` allows the build
(`allowBuilds: bcrypt: true`). The baseline commit `ccf2ed2` installs only
`is-positive`, a no-script dependency, from `registry.npmjs.org`.

The head-vs-previous diff shows the workload unchanged across the two
metadata-only commits; the only movement is runner-background infrastructure
(GitHub hosted-compute agents, NTP, resolver), which the profile classifies
under `systemd (runner background)` and does not attribute to the workflow.

## How reviewers should use this

- Treat the profile as the recorded runtime behavior of this PR's CI: which
  processes ran, and each execution chain from the runner's root to an observed
  action (today, an outbound connection) with its destination.
- Judge trust decisions in the diff (`allowBuilds`, new dependencies, script
  policy) against what the recording shows those decisions actually execute.
- Cite the Execution Profile receipt URLs above when a finding relies on
  recorded runtime behavior.
