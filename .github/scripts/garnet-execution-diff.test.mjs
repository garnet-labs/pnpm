import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  chainIdentity,
  diffSides,
  executionJob,
  evaluateGates,
  extractProfileLink,
  profileLinksFromLogs,
  renderReceipt,
  stableSets,
  summarizeProfile,
  upsertExecutionDiff,
  workloadActivityCounts,
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
    workload_present: true,
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
  assert.match(block, /\*\*workload \+1 destination −0 destinations · \+1 execution chain −0 execution chains\*\*/)
  assert.match(block, /\| `github\[.\]com` \| 0\/3 \| 3\/3 · 1 chain \| new \|/)
  const foldStart = block.indexOf("<details open>")
  const foldEnd = block.indexOf("</details>", foldStart)
  const chainDiff = block.indexOf("```diff", foldStart)
  assert.ok(foldStart < chainDiff && chainDiff < foldEnd)
  assert.match(block, /^\+ Runner\.Worker › node → github\[.\]com$/m)
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
  assert.match(block, /\*\*workload: no stable change\*\* — 1 destination differs between runs/)
  assert.match(block, /\| `github\[.\]com` \| 0\/3 \| 1\/3 · 1 chain \| variance \|/)
})

test("a destination gone from every head repetition is removed", () => {
  const base = fixtureSet()
  const head = fixtureSet().map((item) => ({ ...item, profiles: [{ ...item.profiles[0], associations: [] }] }))
  const diff = diffSides(sideSummaries(base.slice(0, 3)), sideSummaries(head.slice(3)))
  assert.deepEqual(diff.workload.removed, ["registry.npmjs.org"])
  const block = receipt(diff, "determinable", [...base.slice(0, 3), ...head.slice(3)])
  assert.match(block, /\| `registry\.npmjs\[.\]org` \| 3\/3 · 1 chain \| 0\/3 \| gone \|/)
  assert.match(block, /<summary>workload · 1 destination \(0 at head, 1 base only\) · 0 with run-to-run variance · 1 stable change<\/summary>/)
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
  assert.match(result.reasons.join("; "), /base moved/)
  assert.match(result.reasons.join("; "), /executed commit mismatch/)
  assert.match(result.reasons.join("; "), /job execution-diff-base-1 concluded failure/)
  assert.match(result.reasons.join("; "), /jobs found: 1\/6/)
  assert.match(result.reasons.join("; "), /profiles published: 5\/6/)
})

test("missing workload fixtures make the affected side undeterminable", () => {
  const missingBase = cells().map((cell) => cell.side === "base" ? { ...cell, workload_present: false } : cell)
  const result = evaluateGates({
    pr: { head: { sha: "h".repeat(40) }, base: { sha: "e".repeat(40) } },
    cells: missingBase,
    jobs: cells().map((cell) => ({ name: cell.job, conclusion: "success" })),
    profiles: fixtureSet(),
    headSha: "h".repeat(40),
    runId: "99",
  })
  assert.match(result.reasons.join("; "), /workload fixture absent at base/)
})

test("missing execution jobs are reported", () => {
  const result = evaluateGates({
    pr: { head: { sha: "h".repeat(40) }, base: { sha: "e".repeat(40) } },
    cells: cells(),
    jobs: cells().slice(0, 5).map((cell) => ({ name: cell.job, conclusion: "success" })),
    profiles: fixtureSet(),
    headSha: "h".repeat(40),
    runId: "99",
  })
  assert.match(result.reasons.join("; "), /jobs found: 5\/6/)
})

test("matrix job logs identify profiles by side and repetition", () => {
  const jobs = [
    { id: 11, name: "execution-diff (base, 2)" },
    { id: 12, name: "unrelated" },
  ]
  const logs = new Map([[
    11,
    "Garnet Run Profile report: https://app.garnet.ai/public/runs/99?profile=abc-123&utm_source=github",
  ]])
  assert.deepEqual(executionJob(jobs[0].name), {
    id: undefined,
    side: "base",
    rep: 2,
    identity: "execution-diff/base/2",
    display_name: jobs[0].name,
  })
  assert.deepEqual(extractProfileLink(logs.get(11)), {
    url: "https://app.garnet.ai/public/runs/99?profile=abc-123",
    run_id: "99",
    profile_id: "abc-123",
  })
  assert.deepEqual(profileLinksFromLogs(jobs, logs), [{
    id: 11,
    side: "base",
    rep: 2,
    identity: "execution-diff/base/2",
    display_name: jobs[0].name,
    url: "https://app.garnet.ai/public/runs/99?profile=abc-123",
    run_id: "99",
    profile_id: "abc-123",
  }])
})

test("missing profile links and non-public profiles are gate reasons", () => {
  const links = [
    { display_name: "execution-diff (base, 2)", identity: "execution-diff/base/2" },
    { display_name: "execution-diff (head, 1)", identity: "execution-diff/head/1", url: "https://app.garnet.ai/public/runs/99?profile=missing", public: false },
  ]
  const result = evaluateGates({
    pr: { head: { sha: "h".repeat(40) }, base: { sha: "e".repeat(40) } },
    cells: cells(),
    jobs: cells().map((cell) => ({ name: `execution-diff (${cell.side}, ${cell.rep})`, conclusion: "success" })),
    profiles: fixtureSet(),
    profileLinks: links,
    headSha: "h".repeat(40),
    mergeCommitSha: undefined,
    runId: "99",
  })
  assert.match(result.reasons.join("; "), /profile link missing in execution-diff \(base, 2\)/)
  assert.match(result.reasons.join("; "), /profile not public: execution-diff\/head\/1/)
})

test("profile commit gate accepts the merge commit", () => {
  const merge = "m".repeat(40)
  const profiles = fixtureSet().map((item) => ({
    ...item,
    profiles: [{ ...item.profiles[0], run: { ...item.profiles[0].run, commit_sha: merge } }],
  }))
  const result = evaluateGates({
    pr: { head: { sha: "h".repeat(40) }, base: { sha: "e".repeat(40) } },
    cells: cells(),
    jobs: cells().map((cell) => ({ name: `execution-diff (${cell.side}, ${cell.rep})`, conclusion: "success" })),
    profiles,
    headSha: "h".repeat(40),
    mergeCommitSha: merge,
    runId: "99",
  })
  assert.equal(result.status, "determinable")
})

test("empty platform partitions render none recorded", () => {
  const diff = diffSides(sideSummaries(fixtureSet().slice(0, 3)), sideSummaries(fixtureSet().slice(3)))
  const block = receipt(diff)
  assert.match(block, /<details><summary>runner platform[\s\S]*?\nnone recorded\n\n<\/details>/)
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
  assert.match(block, /workload · 1 destination · 1 with run-to-run variance · 0 stable changes/)
})

test("machine marker is valid JSON", () => {
  const diff = diffSides(sideSummaries(fixtureSet().slice(0, 3)), sideSummaries(fixtureSet().slice(3)))
  const block = receipt(diff)
  const marker = block.match(/<!-- garnet:execution-diff:summary (.+) -->/)[1]
  const machine = JSON.parse(marker)
  assert.equal(machine.status, "determinable")
  assert.equal(machine.base, "b".repeat(40))
  assert.equal(machine.head, "h".repeat(40))
  assert.deepEqual(machine.capture, { base_workload_runs: 3, head_workload_runs: 3 })
})

test("partial workload capture is undeterminable", () => {
  const profiles = fixtureSet().map((item, index) => index === 4 || index === 5
    ? { ...item, profiles: [{ ...item.profiles[0], associations: [] }] }
    : item)
  const result = evaluateGates({
    pr: { head: { sha: "h".repeat(40) }, base: { sha: "e".repeat(40) } },
    cells: cells(),
    jobs: cells().map((cell) => ({ name: `execution-diff (${cell.side}, ${cell.rep})`, conclusion: "success" })),
    profiles,
    headSha: "h".repeat(40),
    runId: "99",
  })
  assert.deepEqual(workloadActivityCounts(cells(), profiles), { base: 3, head: 1 })
  assert.match(result.reasons.join("; "), /workload activity recorded in 1\/3 head runs/)
  const block = renderReceipt({
    status: result.status,
    reasons: result.reasons,
    meta: { base: "e".repeat(40), head: "h".repeat(40), run_id: "99", action_sha: actionSha },
    diff: {
      workload: { added: [], removed: [], variance: [], chains: { added: [], removed: [] } },
      platform: { added: [], removed: [], variance: [], chains: { added: [], removed: [] } },
    },
    profiles,
    cells: cells(),
  })
  assert.doesNotMatch(block, /\| `registry\.npmjs\[.\]org` \| .* \| .* \| variance \|/)
})

test("undeterminable receipts retain observed execution differences", () => {
  const base = fixtureSet().slice(0, 3)
  const head = fixtureSet().slice(3).map((item) => ({
    ...item,
    profiles: [{ ...item.profiles[0], associations: [...item.profiles[0].associations, assoc({ name: "github.com" })] }],
  }))
  const profiles = [...base, ...head]
  const result = evaluateGates({
    pr: { head: { sha: "h".repeat(40) }, base: { sha: "e".repeat(40) } },
    cells: cells().map((cell) => cell.side === "base" ? { ...cell, workload_present: false } : cell),
    jobs: cells().map((cell) => ({ name: `execution-diff (${cell.side}, ${cell.rep})`, conclusion: "success" })),
    profiles,
    headSha: "h".repeat(40),
    runId: "99",
  })
  const diff = diffSides(sideSummaries(base), sideSummaries(head))
  const block = renderReceipt({
    status: result.status,
    reasons: result.reasons,
    meta: { base: "e".repeat(40), head: "h".repeat(40), run_id: "99", action_sha: actionSha },
    diff,
    profiles,
    cells: cells().map((cell) => cell.side === "base" ? { ...cell, workload_present: false } : cell),
  })
  assert.match(block, /<summary>workload · 2 destinations · 0 with run-to-run variance · 1 stable change<\/summary>/)
  assert.match(block, /\| `github\[.\]com` \| 0\/3 \| 3\/3 · 1 chain \| new \|/)
  const marker = JSON.parse(block.match(/<!-- garnet:execution-diff:summary (.+) -->/)[1])
  assert.equal(marker.status, "undeterminable")
  assert.deepEqual(marker.workload.added, ["github.com"])
})

test("complete and absent workload activity do not trigger partial capture", () => {
  const complete = evaluateGates({
    pr: { head: { sha: "h".repeat(40) }, base: { sha: "e".repeat(40) } },
    cells: cells(),
    jobs: cells().map((cell) => ({ name: `execution-diff (${cell.side}, ${cell.rep})`, conclusion: "success" })),
    profiles: fixtureSet(),
    headSha: "h".repeat(40),
    runId: "99",
  })
  const absentProfiles = fixtureSet().map((item, index) => index >= 3
    ? { ...item, profiles: [{ ...item.profiles[0], associations: [] }] }
    : item)
  const absentCells = cells().map((cell) => cell.side === "head" ? { ...cell, workload_present: true } : cell)
  const absent = evaluateGates({
    pr: { head: { sha: "h".repeat(40) }, base: { sha: "e".repeat(40) } },
    cells: absentCells,
    jobs: absentCells.map((cell) => ({ name: `execution-diff (${cell.side}, ${cell.rep})`, conclusion: "success" })),
    profiles: absentProfiles,
    headSha: "h".repeat(40),
    runId: "99",
  })
  assert.equal(complete.reasons.some((reason) => reason.includes("workload activity recorded")), false)
  assert.equal(absent.reasons.some((reason) => reason.includes("workload activity recorded")), false)
})

function assertFoldCounts(block, label) {
  const start = block.indexOf(`<summary>${label}`)
  const end = block.indexOf("</details>", start)
  const section = block.slice(start, end)
  const summary = section.match(new RegExp(`<summary>${label} · (\\d+) destinations?(?: \\((\\d+) at head, (\\d+) base only\\))? · (\\d+) with run-to-run variance · (\\d+) stable changes?(?: · [^<]+)?</summary>`))
  assert.ok(summary)
  const total = Number(summary[1])
  const atHead = summary[2] === undefined ? total : Number(summary[2])
  const baseOnly = summary[3] === undefined ? 0 : Number(summary[3])
  const variance = Number(summary[4])
  const stableChanges = Number(summary[5])
  const rows = section.split("\n").filter((line) => line.startsWith("| `"))
  const rowAtHead = rows.filter((line) => Number(line.split("|")[3].trim().match(/^(\d+)\/3/)?.[1] || 0) > 0).length
  const rowVariance = rows.filter((line) => line.split("|")[4].trim() === "variance").length
  const rowStableChanges = rows.filter((line) => ["new", "gone"].includes(line.split("|")[4].trim())).length
  assert.equal(rows.length, total)
  assert.equal(atHead + baseOnly, total)
  assert.equal(rowAtHead, atHead)
  assert.equal(rowVariance, variance)
  assert.equal(rowStableChanges, stableChanges)
  assert.equal(variance + stableChanges + rows.filter((line) => line.split("|")[4].trim() === "—").length, total)
}

test("fold summaries reconcile with rendered rows", () => {
  const base = fixtureSet()
  const head = fixtureSet().map((item, index) => index === 3
    ? { ...item, profiles: [{ ...item.profiles[0], associations: [] }] }
    : item)
  const diff = diffSides(sideSummaries(base.slice(0, 3)), sideSummaries(head.slice(3)))
  const block = receipt(diff, "determinable", [...base.slice(0, 3), ...head.slice(3)])
  assertFoldCounts(block, "workload")
  assertFoldCounts(block, "runner platform")
})

test("fold summaries reconcile for the real profile fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("./__fixtures__/pr30-1b57225.json", import.meta.url)))
  const profiles = ["base", "head"].flatMap((side) => [1, 2, 3].map((rep) => ({
    ...fixture,
    execution_diff: { identity: `execution-diff/${side}/${rep}`, side, rep, url: "https://example.test/profile" },
  })))
  const syntheticCells = cells()
  const summaries = profiles.map((item) => summarizeProfile(item.profiles[0]))
  const diff = diffSides(stableSets(summaries.slice(0, 3)), stableSets(summaries.slice(3)))
  const block = receipt(diff, "determinable", profiles)
  assertFoldCounts(block, "workload")
  assertFoldCounts(block, "runner platform")
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
