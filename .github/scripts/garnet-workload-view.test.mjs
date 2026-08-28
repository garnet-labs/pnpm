import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  classifyAssociation,
  destinationFor,
  reconcileProfile,
  renderDestination,
  renderWorkloadBlock,
} from "./garnet-workload-view.mjs"

async function fixture(name) {
  return JSON.parse(await readFile(`/home/ubuntu/garnet-profiles/${name}`, "utf8"))
}

function tableRowCounts(block) {
  return [...block.matchAll(/<details(?: open)?><summary>.*?<\/summary>([\s\S]*?)<\/details>/g)]
    .map((match) => (match[1].match(/^\| `/gm) || []).length)
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
  assert.match(block, /\*\*Workload behaviour vs `ba67148`: \+0 −0 destinations\*\*/)
  assert.match(block, /~ `github\[.\]com` · 14 → 23 chains/)
  assert.match(block, /Platform delta: \+8 −6 destinations/)
  assert.deepEqual(tableRowCounts(block), [10, 23])
})
