#!/usr/bin/env python3
"""Reads the gate's own workflows and pnpm's, upstream and local, and prints one
JSON record of the shape facts the verifier turns into legs.

The gate only proves something about pnpm while it still runs pnpm's shape, so
every field a maintainer would read is compared against upstream pnpm/pnpm at
main: the reusable-workflow call form, the runner of the instrumented cell, the
action ref, the sensor version, the token input, job permissions, and the order
of id-bearing run steps before the workload. A difference is either declared
here as deliberate (the gate exists to run a candidate sensor) or reported as
drift for the verifier to fail on.

The same parse answers three more questions no other tool in the gate can:
which step Jibril will attribute the workload egress to (its numbering counts
every run step, GitHub's counts only the id-less ones), which release and tag
jobs carry an inert Garnet step, and how many matrix cells upstream instruments.

Usage: garnet-gate-shape.py <upstream-dir> [--upstream-sha SHA]
       [--action-default-version V] [--upstream-action-default-version V]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

import yaml

GATE_JOB_WORKFLOW = ".github/workflows/garnet-jibril-release-gate-job.yml"
GATE_CALLER_WORKFLOW = ".github/workflows/garnet-jibril-release-gate.yml"
REPRODUCE_JOB = "reproduce"
WORKLOAD_STEP = "Workload with egress"
UPSTREAM_WORKLOAD_STEP_PREFIX = "Run tests"
ACTION = "garnet-org/action@"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
# A sensor release the control plane can serve twice: vN.N.N, optionally -rc.N.
# A major or minor tag (`v2`, `v2.16`) moves, so it names no fixed binary.
PINNED_SENSOR = re.compile(r"^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$")


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        # `on:` is YAML 1.1 true; the loader keeps it as a key we never read.
        return yaml.safe_load(handle) or {}


def jobs(doc: dict) -> dict:
    return doc.get("jobs") or {}


def steps(job: dict) -> list:
    return job.get("steps") or []


def action_step(job: dict) -> dict | None:
    for step in steps(job):
        if str(step.get("uses", "")).startswith(ACTION):
            return step
    return None


def action_ref(step: dict) -> str:
    return str(step.get("uses", "")).split("@", 1)[-1].split()[0]


def permissions_of(job: dict, doc: dict | None = None) -> dict:
    """The permissions the job's token actually carries.

    A job-level `permissions:` key overrides the workflow-level one whatever its
    shape, so the scalar forms have to be expanded rather than skipped: a job
    that says `permissions: write-all` under a workflow that says
    `contents: read` gets write on everything.
    """
    for source in (job, doc or {}):
        if "permissions" not in source:
            continue
        perms = source["permissions"]
        if isinstance(perms, dict):
            if perms:
                return dict(perms)
            return {}
        scalar = str(perms).strip()
        if scalar in ("write-all", "read-all"):
            grant = "write" if scalar == "write-all" else "read"
            return {"all": grant, "id-token": grant, "pull-requests": grant, "contents": grant}
        return {"unrecognised": scalar}
    return {}


def run_step_names(job: dict) -> list[tuple[str, str | None]]:
    """(name, id) of every run step, in file order."""
    return [
        (str(step.get("name") or step.get("id") or "<unnamed>"), step.get("id"))
        for step in steps(job)
        if "run" in step
    ]


def attribution(job: dict, workload_name: str) -> dict:
    """What GitHub calls the workload step, and what Jibril will call it.

    GitHub sets GITHUB_ACTION to the step id when there is one and numbers only
    the id-less run steps (__run, __run_2, ...). Jibril's parseStepsList never
    reads `id:` and numbers every run step, so an id-bearing run step earlier in
    the job shifts every later id-less step back by one (ledger F25).
    """
    runs = run_step_names(job)
    github_token, jibril_names, anonymous = None, [], 0
    for index, (name, step_id) in enumerate(runs, start=1):
        jibril_names.append(f"__run{'' if index == 1 else f'_{index}'}")
        if step_id:
            continue
        anonymous += 1
        token = "__run" if anonymous == 1 else f"__run_{anonymous}"
        if name.startswith(workload_name):
            github_token = token
    if github_token is None:
        return {"found": False}
    jibril_index = jibril_names.index(github_token)
    recorded_name, recorded_id = runs[jibril_index]
    return {
        "found": True,
        "workload_step": workload_name,
        "github_action": github_token,
        "jibril_records": recorded_name,
        "jibril_records_has_id": bool(recorded_id),
        "skewed": recorded_name != workload_name,
        "run_steps": [
            {"name": name, "id": step_id, "jibril_token": token}
            for (name, step_id), token in zip(runs, jibril_names)
        ],
    }


def run_step_sequence(job: dict, workload_name: str) -> list[str]:
    """The run steps before the workload, as `id`/`idless` in file order.

    Jibril numbers every run step and GitHub numbers only the id-less ones, so
    the attribution of the workload depends on this whole sequence, not on
    whether some id-bearing step exists somewhere before it. Names are left out:
    upstream renaming a step does not move the numbering, adding, removing or
    reordering one does.
    """
    sequence = []
    for name, step_id in run_step_names(job):
        if name.startswith(workload_name):
            return sequence
        sequence.append("id" if step_id else "idless")
    return sequence


def id_bearing_before(job: dict, workload_name: str) -> dict:
    """The run-step shape upstream has around its workload: at least one
    id-bearing run step, then an id-less one, then the workload."""
    runs = run_step_names(job)
    before = []
    for name, step_id in runs:
        if name.startswith(workload_name):
            return {
                "id_bearing_before": [n for n, i in before if i],
                "idless_before": [n for n, i in before if not i],
                "immediately_before": before[-1][0] if before else None,
                "immediately_before_has_id": bool(before[-1][1]) if before else None,
                "sequence": ["id" if i else "idless" for _, i in before],
            }
        before.append((name, step_id))
    return {"id_bearing_before": [], "idless_before": [], "immediately_before": None,
            "immediately_before_has_id": None, "sequence": []}


def instrumented_cell(ci: dict) -> dict:
    for job_name, job in jobs(ci).items():
        matrix = ((job.get("strategy") or {}).get("matrix") or {})
        for cell in matrix.get("include") or []:
            if cell.get("garnet") is True:
                return {"job": job_name, **{k: str(v) for k, v in cell.items()}}
    return {}


def all_cells(ci: dict) -> list[dict]:
    cells = []
    for job_name, job in jobs(ci).items():
        matrix = ((job.get("strategy") or {}).get("matrix") or {})
        for cell in matrix.get("include") or []:
            cells.append(
                {
                    "job": job_name,
                    "cell": f'{cell.get("platform_label", cell.get("platform", "?"))}'
                            f'/node {cell.get("node_major", cell.get("node", "?"))}',
                    "runner": str(cell.get("platform", "?")),
                    "instrumented": cell.get("garnet") is True,
                }
            )
    return cells


def reusable_call(ci: dict) -> dict:
    calls = {}
    for job_name, job in jobs(ci).items():
        uses = str(job.get("uses", ""))
        if uses.endswith("test.yml"):
            calls[job_name] = uses
    return calls


def release_report(paths: dict[str, str]) -> list[dict]:
    """Every Garnet step in the release and tag workflows, with the runner it
    would record on. macOS and Windows carry no sensor, so those steps produce
    nothing; a Linux step that produces nothing is a defect, not a disclosure."""
    report = []
    for label, path in paths.items():
        if not os.path.exists(path):
            continue
        doc = load(path)
        for job_name, job in jobs(doc).items():
            step = action_step(job)
            if step is None:
                continue
            runner = str(job.get("runs-on", "?"))
            condition = str(step.get("if", job.get("if", ""))).strip()
            if runner.startswith(("macos", "windows")):
                produces, reason = "no", f"{runner.split('-')[0]} runner: the sensor is Linux-only eBPF"
            elif "ubuntu" in runner or "linux" in runner:
                # A Linux runner can carry the sensor; whether this step reaches
                # it is a runtime fact the gate has no run of, and a condition
                # can skip it entirely. Say which of the two this is.
                if condition:
                    produces = "conditional"
                    reason = f"{runner}, guarded by `if: {condition}`: records only when that holds"
                else:
                    produces = "expected"
                    reason = f"{runner} can run the sensor; no run of this workflow is bound to this gate"
            else:
                produces, reason = "unknown", f"unrecognised runner {runner}"
            report.append(
                {
                    "workflow": label,
                    "job": job_name,
                    "runner": runner,
                    "instrumented": True,
                    "produces_profile": produces,
                    "condition": condition,
                    "reason": reason,
                    "action_ref": action_ref(step),
                }
            )
    return report


def posture(job: dict, name: str, doc: dict | None = None, default_version: str = "") -> list[dict]:
    """The lines a pnpm reviewer and their scanners read on an instrumented job."""
    findings = []
    perms = permissions_of(job, doc)
    step = action_step(job)

    def add(check, ok, detail):
        findings.append({"job": name, "check": check, "ok": bool(ok), "detail": detail})

    add("id-token: write absent", perms.get("id-token") != "write",
        f"permissions: {perms or 'inherited'}")
    add("permissions enumerated, not blanket",
        "all" not in perms and "unrecognised" not in perms,
        f"permissions: {perms or 'inherited'}")
    add("no secrets: inherit", "inherit" not in str(job.get("secrets", "")),
        f"secrets: {job.get('secrets', 'none')}")
    add("no pull-requests: write", perms.get("pull-requests") != "write",
        f"pull-requests: {perms.get('pull-requests', 'unset')}")
    if step is None:
        add("Garnet step present", False, "no garnet-org/action step in this job")
        return findings
    ref = action_ref(step)
    add("action pinned to a full SHA", bool(FULL_SHA.match(ref)), f"garnet-org/action@{ref}")
    token = str((step.get("with") or {}).get("api_token", ""))
    add("explicit api_token from secrets", "secrets.GARNET_API_TOKEN" in token,
        f"api_token: {token or 'unset'}")
    version = str((step.get("with") or {}).get("jibril_version", "")).strip()
    # An empty input hands the sensor version to the action's own default, which
    # is only acceptable while that default is an explicit pin: a root eBPF
    # binary must not change under an unchanged action ref. An explicit input is
    # only a pin when it names one immutable release; `latest` is not one, and
    # an expression is resolved by the caller, not here.
    effective = version or default_version
    if version.startswith("${{"):
        detail = f"jibril_version: {version} (resolved by the caller)"
        pinned = True
    elif version:
        detail = f"jibril_version: {version}"
        pinned = bool(PINNED_SENSOR.match(version))
    else:
        detail = f"action default at {ref[:7]} resolves to {effective or 'unknown'}"
        pinned = bool(PINNED_SENSOR.match(effective or ""))
    add("sensor version pinned", pinned, detail)
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("upstream_dir")
    parser.add_argument("--upstream-sha", default="")
    parser.add_argument("--action-default-version", default="")
    parser.add_argument("--upstream-action-default-version", default="")
    args = parser.parse_args()

    up = args.upstream_dir
    upstream_ci = load(os.path.join(up, "ci.yml"))
    upstream_test = load(os.path.join(up, "test.yml"))
    gate_job = load(GATE_JOB_WORKFLOW)
    gate_caller = load(GATE_CALLER_WORKFLOW)
    local_ci = load(".github/workflows/ci.yml")
    local_cell = instrumented_cell(local_ci)

    def cell_label(c: dict) -> str:
        return (f'{c.get("platform_label", c.get("platform", "?"))}'
                f'/node {c.get("node_major", c.get("node", "?"))}')

    reproduce = jobs(gate_job).get(REPRODUCE_JOB) or {}
    upstream_test_job = next(
        (job for job in jobs(upstream_test).values() if action_step(job)), {}
    )
    cell = instrumented_cell(upstream_ci)

    gate_call = str((jobs(gate_caller).get(REPRODUCE_JOB) or {}).get("uses", ""))
    upstream_calls = reusable_call(upstream_ci)
    upstream_call = next(iter(upstream_calls.values()), "")

    gate_step = action_step(reproduce) or {}
    upstream_step = action_step(upstream_test_job) or {}
    gate_shape = id_bearing_before(reproduce, WORKLOAD_STEP)
    upstream_shape = id_bearing_before(upstream_test_job, UPSTREAM_WORKLOAD_STEP_PREFIX)

    def call_form(uses: str) -> str:
        return "$/" if uses.startswith("$/") else "./" if uses.startswith("./") else uses

    drift = []

    def compare(field, upstream_value, gate_value, deliberate="", ok=None, note=""):
        verdict = "match" if (ok if ok is not None else upstream_value == gate_value) else "drift"
        if verdict == "drift" and deliberate:
            verdict = "deliberate"
        drift.append(
            {
                "field": field,
                "upstream": upstream_value,
                "gate": gate_value,
                "verdict": verdict,
                "note": deliberate if verdict == "deliberate" else note,
            }
        )

    compare("reusable call form", call_form(upstream_call), call_form(gate_call))
    compare("instrumented runner", cell.get("platform", "?"), str(reproduce.get("runs-on", "?")))
    # Which cell carries the sensor, not just how many do: moving Garnet from
    # the Node 24 cell to another one on the same runner changes what the gate
    # speaks for.
    compare("instrumented cell", cell_label(cell), cell_label(local_cell))
    compare(
        "action ref",
        action_ref(upstream_step) if upstream_step else "none",
        action_ref(gate_step) if gate_step else "none",
        deliberate="the gate runs the candidate action under test",
    )
    compare(
        "sensor version",
        str((upstream_step.get("with") or {}).get("jibril_version", ""))
        or f"action default ({args.upstream_action_default_version or 'unknown'})",
        str((gate_step.get("with") or {}).get("jibril_version", "")) or "action default",
        deliberate="the gate names the release tag under test",
    )
    compare(
        "api_token input",
        str((upstream_step.get("with") or {}).get("api_token", "")),
        str((gate_step.get("with") or {}).get("api_token", "")),
    )
    compare(
        "instrumented job permissions",
        permissions_of(upstream_test_job, upstream_test) or "inherited",
        permissions_of(reproduce, gate_job) or "inherited",
    )
    # The ordered run-step layout before the workload decides Jibril's __run_N
    # attribution. The gate runs a shorter job than pnpm's test job on purpose,
    # so equality is the wrong bar; what has to hold is the part of the layout
    # the skew is a function of: how many id-bearing run steps precede the
    # workload, and whether the step immediately before it carries an id.
    upstream_sequence = run_step_sequence(upstream_test_job, UPSTREAM_WORKLOAD_STEP_PREFIX)
    gate_sequence = run_step_sequence(reproduce, WORKLOAD_STEP)

    def skew_shape(sequence: list[str]) -> str:
        if not sequence:
            return "no run step before the workload"
        return (
            f"{sequence.count('id')} id-bearing before the workload, "
            f"last one {sequence[-1]}"
        )

    compare(
        "run-step layout before the workload",
        f"{skew_shape(upstream_sequence)} ({' '.join(upstream_sequence) or 'none'})",
        f"{skew_shape(gate_sequence)} ({' '.join(gate_sequence) or 'none'})",
        ok=bool(upstream_sequence) and skew_shape(upstream_sequence) == skew_shape(gate_sequence),
        note="the gate runs fewer steps than pnpm's test job; the skew is a "
             "function of the id-bearing count and the last step before the workload",
    )

    record = {
        "upstream": {
            "sha": args.upstream_sha,
            "instrumented_cell": cell,
            "cells": all_cells(upstream_ci),
            "reusable_calls": upstream_calls,
            "attribution": attribution(upstream_test_job, UPSTREAM_WORKLOAD_STEP_PREFIX),
            "shape": upstream_shape,
            "action_default_version": args.upstream_action_default_version,
        },
        "gate": {
            "call": gate_call,
            "runner": str(reproduce.get("runs-on", "?")),
            "attribution": attribution(reproduce, WORKLOAD_STEP),
            "shape": gate_shape,
            "action_default_version": args.action_default_version,
        },
        "drift": drift,
        "drift_count": sum(1 for d in drift if d["verdict"] == "drift"),
        "posture": posture(reproduce, "gate reproduce", gate_job, args.action_default_version)
        + posture(upstream_test_job, "upstream test", upstream_test, args.upstream_action_default_version),
        "release_workflows": release_report(
            {
                "release.yml": os.path.join(up, "release.yml"),
                "update-latest.yml": os.path.join(up, "update-latest.yml"),
            }
        ),
        "coverage": {
            "cells": all_cells(upstream_ci),
            "instrumented": sum(1 for c in all_cells(upstream_ci) if c["instrumented"]),
            "total": len(all_cells(upstream_ci)),
            # The fork's own matrix: the gate proves nothing about a cell pnpm
            # instruments and the fork does not, or the other way round.
            "local_instrumented": sum(1 for c in all_cells(local_ci) if c["instrumented"]),
            "local_total": len(all_cells(local_ci)),
            "instrumented_cells": [c["cell"] for c in all_cells(upstream_ci) if c["instrumented"]],
            "local_instrumented_cells": [c["cell"] for c in all_cells(local_ci) if c["instrumented"]],
        },
    }
    json.dump(record, sys.stdout, indent=2, sort_keys=False, default=str)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
