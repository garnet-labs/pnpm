import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  classifyAssociation,
  destinationFor,
  reconcileProfile,
  renderDestination,
  renderProfile,
  renderWorkloadBlock,
  upsert,
} from "./garnet-workload-view.mjs"

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"))
}

function tableRowCounts(block) {
  return [...block.matchAll(/<details(?: open)?><summary>.*?<\/summary>([\s\S]*?)<\/details>/g)]
    .map((match) => (match[1].match(/^\| `/gm) || []).length)
}

function tableSummaryReconciliation(block) {
  return [...block.matchAll(/<details(?: open)?><summary>(.*?)<\/summary>([\s\S]*?)<\/details>/g)]
    .map((match) => {
      const withGone = match[1].match(/(\d+)&nbsp;destinations at head, (\d+)&nbsp;gone/)
      const headDestinations = withGone
        ? Number(withGone[1])
        : Number(match[1].match(/· (\d+)&nbsp;destinations/)?.[1])
      const goneDestinations = withGone ? Number(withGone[2]) : 0
      const rows = match[2].match(/^\| `[^`]+` \| (\d+) \|/gm) || []
      return {
        headDestinations,
        goneDestinations,
        nonZeroRows: rows.filter((row) => !/\| 0 \|/.test(row)).length,
        zeroRows: rows.filter((row) => /\| 0 \|/.test(row)).length,
      }
    })
}

test("classifies associations using only the specified platform signals", () => {
  assert.equal(classifyAssociation({ github_step: "99. Runner Processes", ancestry: ["Runner.Worker"] }), "platform")
  assert.equal(classifyAssociation({ github_step: "", ancestry: ["systemd"] }), "platform")
  assert.equal(classifyAssociation({ github_step: "", ancestry: ["Runner.Worker"] }), "workload")
  assert.equal(classifyAssociation({ github_step: "11. Validate test chunk inputs", ancestry: [] }), "workload")
  assert.equal(destinationFor({ remote_names: ["registry.example.org"], remote_address: "192.0.2.1" }), "registry.example.org")
  assert.equal(destinationFor({ remote_names: [], remote_address: "192.0.2.1" }), "192.0.2.1")
  assert.equal(renderDestination("registry.example.org"), "registry.example[.]org")
  assert.equal(renderDestination("192.0.2.1"), "192.0.2.1")
})

test("renders the PR 30 fixture head-only", async () => {
  const profile = (await fixture("pr30-1b57225.json")).profiles[0]
  const reconciliation = reconcileProfile(profile)
  assert.deepEqual(reconciliation, {
    totalMatches: true,
    workloadRowsMatch: true,
    platformRowsMatch: true,
    workloadChains: 131,
    platformChains: 30,
    total: 161,
    workloadDestinations: 10,
    platformDestinations: 21,
  })
  const block = renderWorkloadBlock(profile)
  assert.match(block, /^<!-- garnet:workload:begin -->$/m)
  assert.match(block, /## Workload behaviour \(Garnet\)/)
  assert.match(block, /131&nbsp;workload chains · 10&nbsp;destinations/)
  assert.match(block, /runner platform · 30&nbsp;chains · 21&nbsp;destinations/)
  assert.match(block, /registry\.npmjs\[.\]org/)
  assert.deepEqual(tableRowCounts(block), [10, 21])
})

test("renders the PR 17 fixture against the PR 30 baseline", async () => {
  const head = (await fixture("pr17-8e34879.json")).profiles[0]
  const baseline = (await fixture("pr30-1b57225.json")).profiles[0]
  const reconciliation = reconcileProfile(head)
  assert.deepEqual(reconciliation, {
    totalMatches: true,
    workloadRowsMatch: true,
    platformRowsMatch: true,
    workloadChains: 187,
    platformChains: 34,
    total: 221,
    workloadDestinations: 10,
    platformDestinations: 23,
  })
  const block = renderWorkloadBlock(head, baseline)
  assert.match(block, /\*\*Workload destinations unchanged vs `ba67148`\*\*/)
  assert.match(block, /connection volume 131 → 187 chains\./)
  assert.doesNotMatch(block, /^~/m)
  assert.match(block, /runner platform: \+8 −6 destinations · not workload behaviour/)
  assert.doesNotMatch(block, /^Platform /m)
  assert.match(block, /\| destination \| chains \| Δ vs base \| reached by \|/)
  assert.deepEqual(tableRowCounts(block), [10, 29])
  assert.deepEqual(tableSummaryReconciliation(block), [
    { headDestinations: 10, goneDestinations: 0, nonZeroRows: 10, zeroRows: 0 },
    { headDestinations: 23, goneDestinations: 6, nonZeroRows: 23, zeroRows: 6 },
  ])
  for (const row of baseline.associations) {
    if (classifyAssociation(row) === "workload") {
      assert.ok(block.includes(`| \`${renderDestination(destinationFor(row))}\` |`))
    }
  }
})

test("renders the head-only path through the main render call", async () => {
  const profile = await fixture("pr30-1b57225.json")
  const block = renderProfile(profile, null)
  assert.doesNotMatch(block, /vs `.*`/)
  assert.match(block, /131&nbsp;workload chains/)
})

test("renders all three workload headline cases", async () => {
  const baseline = await fixture("pr30-1b57225.json")
  const identical = renderWorkloadBlock(baseline.profiles[0], baseline.profiles[0])
  assert.match(identical, /\*\*Workload behaviour unchanged vs `ba67148`\*\*/)

  const reduced = JSON.parse(JSON.stringify(baseline))
  const dropped = reduced.profiles[0].associations.findIndex((association) => (
    classifyAssociation(association) === "workload" && destinationFor(association) === "registry.npmjs.org"
  ))
  reduced.profiles[0].associations.splice(dropped, 1)
  const volumeOnly = renderWorkloadBlock(reduced.profiles[0], baseline.profiles[0])
  assert.match(volumeOnly, /\*\*Workload destinations unchanged vs `ba67148`/)
  assert.match(volumeOnly, /connection volume 131 → 130 chains\./)

  const changed = JSON.parse(JSON.stringify(baseline))
  changed.profiles[0].associations = changed.profiles[0].associations.filter((association) => (
    !(classifyAssociation(association) === "workload" && destinationFor(association) === "pnpm.io")
  ))
  changed.profiles[0].associations.push({
    ...changed.profiles[0].associations.find((association) => classifyAssociation(association) === "workload"),
    remote_address: "203.0.113.10",
    remote_names: ["new.example.org"],
  })
  const destinationChange = renderWorkloadBlock(changed.profiles[0], baseline.profiles[0])
  assert.match(destinationChange, /\*\*Workload behaviour vs `ba67148`: \+1 −1 destinations\*\*/)
  assert.match(destinationChange, /^\+ `new\.example\[.\]org` reached by /m)
  assert.match(destinationChange, /^− `pnpm\[.\]io`$/m)
  assert.doesNotMatch(destinationChange, /^~/m)
})

test("does not take the write path for malformed workload delimiters", () => {
  const body = "description\n\n<!-- garnet:workload:begin -->\npartial block"
  assert.equal(upsert(body, "replacement block"), null)
})
