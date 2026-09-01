import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  chainIdentity,
  diffSides,
  evaluateGates,
  renderReceipt,
  stableSets,
  summarizeProfile,
  upsertExecutionDiff,
} from "./garnet-execution-diff.mjs"

const actionSha = "c747ff1f597c84579e10173301a31c30bb815181"

function assoc({ name, process = "node", ancestry = ["Runner.Worker", "node"], step = "1. Run", lineage = true }) {
  return {
    remote_names: [name],
    remote_address: name,
    process,
    ancestry,
    github_step: step,
    lineage_recorded: lineage,
  }
}

function profile(job, associations, runId = "99") {
  return {
    profiles: [{
      run: { profile_id: `${job}-profile`, run_id: runId, job, commit_sha: "h".repeat(40) },
      associations,
    }],
  }
}

function fixtureSet(destination = "registry.npmjs.org") {
  return ["base", "head"].flatMap((side) => [1, 2, 3].map((rep) => profile(`execution-diff/${side}/${rep}`, [assoc({ name: destination })])))
}

function sideSummaries(profiles) {
  return stableSets(profiles.map((item) => summarizeProfile(item.profiles[0])))
}

function cells() {
  return ["base", "head"].flatMap((side) => [1, 2, 3].map((rep) => ({
    side,
    rep,
    profile_job: `execution-diff/${side}/${rep}`,
    expected_sha: "e".repeat(40),
    executed_sha: "e".repeat(40),
    job: `execution-diff-${side}-${rep}`,
    runner_name: "GitHub Actions 1",
    image_os: "ubuntu24",
    image_version: "20260901.1",
  })))
}

function receipt(diff, status = "determinable", profiles = fixtureSet()) {
  return renderReceipt({
    status,
    reasons: status === "determinable" ? [] : ["profiles published: 5/6"],
    meta: { base: "b".repeat(40), head: "h".repeat(40), run_id: "99", action_sha: actionSha },
    diff,
    profiles,
    cells: cells(),
  })
}

test("identical repetitions are unchanged with zero variance", () => {
  const profiles = fixtureSet()
  const diff = diffSides(
    sideSummaries(profiles.slice(0, 3)),
    sideSummaries(profiles.slice(3)),
  )
  assert.deepEqual(diff.workload.added, [])
  assert.deepEqual(diff.workload.removed, [])
  assert.deepEqual(diff.workload.variance, [])
  assert.match(receipt(diff), /\*\*workload unchanged\*\*/)
})

test("a destination added in all head repetitions is new", () => {
  const base = fixtureSet()
  const head = fixtureSet().map((item) => ({
    ...item,
    profiles: [{ ...item.profiles[0], associations: [...item.profiles[0].associations, assoc({ name: "github.com" })] }],
  }))
  const diff = diffSides(sideSummaries(base.slice(0, 3)), sideSummaries(head.slice(3)))
  assert.deepEqual(diff.workload.added, ["github.com"])
  assert.equal(diff.workload.chains.added.length, 1)
  const block = receipt(diff, "determinable", [...base.slice(0, 3), ...head.slice(3)])
  assert.match(block, /\*\*workload \+1 −0 destinations · \+1 −0 execution chains\*\*/)
  assert.match(block, /\| `github\[.\]com` \| 0\/3 \| 3\/3 · 1 chain \| new \|/)
})

test("a destination in one repetition is variance, not added", () => {
  const base = fixtureSet()
  const head = fixtureSet().map((item, index) => index === 3
    ? { ...item, profiles: [{ ...item.profiles[0], associations: [...item.profiles[0].associations, assoc({ name: "github.com" })] }] }
    : item)
  const diff = diffSides(sideSummaries(base.slice(0, 3)), sideSummaries(head.slice(3)))
  assert.deepEqual(diff.workload.added, [])
  assert.deepEqual(diff.workload.variance, ["github.com"])
  const block = receipt(diff, "determinable", [...base.slice(0, 3), ...head.slice(3)])
  assert.match(block, /\*\*workload unchanged\*\*/)
  assert.match(block, /\| `github\[.\]com` \| 0\/3 \| 1\/3 · 1 chain \| variance \|/)
})

test("a destination gone from every head repetition is removed", () => {
  const base = fixtureSet()
  const head = fixtureSet().map((item) => ({ ...item, profiles: [{ ...item.profiles[0], associations: [] }] }))
  const diff = diffSides(sideSummaries(base.slice(0, 3)), sideSummaries(head.slice(3)))
  assert.deepEqual(diff.workload.removed, ["registry.npmjs.org"])
  const block = receipt(diff, "determinable", [...base.slice(0, 3), ...head.slice(3)])
  assert.match(block, /\| `registry\.npmjs\[.\]org` \| 3\/3 · 1 chain \| 0\/3 \| gone \|/)
})

test("platform-only changes do not affect the workload headline", () => {
  const base = fixtureSet()
  const head = fixtureSet().map((item) => ({
    ...item,
    profiles: [{ ...item.profiles[0], associations: [...item.profiles[0].associations, assoc({ name: "169.254.169.123", ancestry: ["systemd"], step: "" })] }],
  }))
  const diff = diffSides(sideSummaries(base.slice(0, 3)), sideSummaries(head.slice(3)))
  assert.deepEqual(diff.workload.added, [])
  assert.match(receipt(diff), /\*\*workload unchanged\*\*/)
})

test("all gate failures are collected", () => {
  const baseCells = cells().slice(0, 5)
  baseCells[0].executed_sha = "x".repeat(40)
  const result = evaluateGates({
    pr: { head: { sha: "m".repeat(40) } },
    cells: baseCells,
    jobs: [{ name: "execution-diff-base-1", conclusion: "failure" }],
    profiles: fixtureSet().slice(0, 5).map((item) => item),
    headSha: "h".repeat(40),
    runId: "99",
  })
  assert.equal(result.status, "undeterminable")
  assert.match(result.reasons.join("; "), /PR head moved/)
  assert.match(result.reasons.join("; "), /executed commit mismatch/)
  assert.match(result.reasons.join("; "), /job execution-diff-base-1 concluded failure/)
  assert.match(result.reasons.join("; "), /profiles published: 5\/6/)
})

test("lineage loss is undeterminable", () => {
  const profiles = fixtureSet().map((item, index) => index === 0
    ? { ...item, profiles: [{ ...item.profiles[0], associations: [assoc({ name: "x", lineage: false })] }] }
    : item)
  const result = evaluateGates({
    pr: { head: { sha: "h".repeat(40) } },
    cells: cells(),
    jobs: cells().map((cell) => ({ name: cell.job, conclusion: "success" })),
    profiles,
    headSha: "h".repeat(40),
    runId: "99",
  })
  assert.match(result.reasons.join("; "), /lineage not recorded for 1 chains/)
})

test("summary counts are adjacent to rendered rows", () => {
  const base = fixtureSet()
  const head = fixtureSet().map((item, index) => index === 3
    ? { ...item, profiles: [{ ...item.profiles[0], associations: [] }] }
    : item)
  const diff = diffSides(sideSummaries(base.slice(0, 3)), sideSummaries(head.slice(3)))
  const block = receipt(diff, "determinable", [...base.slice(0, 3), ...head.slice(3)])
  assert.match(block, /workload · 1 destinations at head · 1 with run-to-run variance/)
})

test("machine marker is valid JSON", () => {
  const diff = diffSides(sideSummaries(fixtureSet().slice(0, 3)), sideSummaries(fixtureSet().slice(3)))
  const block = receipt(diff)
  const marker = block.match(/<!-- garnet:execution-diff:summary (.+) -->/)[1]
  const machine = JSON.parse(marker)
  assert.equal(machine.status, "determinable")
  assert.equal(machine.base, "b".repeat(40))
  assert.equal(machine.head, "h".repeat(40))
})

test("upsert replaces, appends, and rejects malformed delimiters", () => {
  const block = `${"<!-- garnet:execution-diff:begin -->"}\nnew\n<!-- garnet:execution-diff:end -->`
  assert.match(upsertExecutionDiff("before", block), /before\n\n<!-- garnet:execution-diff:begin -->/)
  assert.match(upsertExecutionDiff("before\n\n<!-- garnet:execution-diff:begin -->\nold\n<!-- garnet:execution-diff:end -->", block), /before\n\n<!-- garnet:execution-diff:begin -->\nnew/)
  assert.equal(upsertExecutionDiff("<!-- garnet:execution-diff:begin -->\npartial", block), null)
})

test("the live PR 30 fixture partitions every association", async () => {
  const fixture = JSON.parse(await readFile(new URL("./__fixtures__/pr30-1b57225.json", import.meta.url)))
  const summary = summarizeProfile(fixture.profiles[0])
  const workload = [...summary.workload.values()].reduce((total, group) => total + group.chains, 0)
  const platform = [...summary.platform.values()].reduce((total, group) => total + group.chains, 0)
  assert.equal(workload + platform, summary.total)
  assert.equal(chainIdentity(fixture.profiles[0].associations[0]).includes("→"), true)
})
