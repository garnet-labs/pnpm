import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

import {
  classifyAssociation,
  destinationFor,
  renderDestination,
} from "./garnet-workload-view.mjs"
import { isTrustedEvidenceComment } from "./garnet-evidence-mirror.mjs"

const execFileAsync = promisify(execFile)
const BEGIN = "<!-- garnet:execution-diff:begin -->"
const END = "<!-- garnet:execution-diff:end -->"
const BEGIN_LINE_RE = /^<!-- garnet:execution-diff:begin -->[ \t]*\r?$/m
const END_LINE_RE = /^<!-- garnet:execution-diff:end -->[ \t]*\r?$/m
const COMMIT_RE = /<!--\s*garnet:commit\s+([0-9a-f]{40})\s*-->/
const PROFILE_RE = /https:\/\/app\.garnet\.ai\/public\/runs\/(\d+)\?profile=([0-9a-f-]+)/gi
const PROFILE_JOB_RE = /^execution-diff\/(base|head)\/([123])$/
const BODY_LIMIT = 65536
const RUNNER_LABEL = "ubuntu-24.04"
const env = globalThis.process.env
const api = env.GITHUB_API_URL || "https://api.github.com"

export function chainIdentity(association) {
  return `${(association.ancestry || []).join(" › ")} → ${destinationFor(association)}`
}

export function summarizeProfile(profile) {
  const workload = new Map()
  const platform = new Map()
  const chains = { workload: new Set(), platform: new Set() }
  let lineageMissing = 0
  const associations = profile.associations || []
  for (const association of associations) {
    const partition = classifyAssociation(association)
    const destination = destinationFor(association)
    const group = (partition === "workload" ? workload : platform).get(destination) || {
      chains: 0,
      processes: new Set(),
    }
    group.chains += 1
    if (association.process) group.processes.add(association.process)
    const groups = partition === "workload" ? workload : platform
    groups.set(destination, group)
    chains[partition].add(chainIdentity(association))
    if (association.lineage_recorded === false) lineageMissing += 1
  }
  return { workload, platform, chains, lineageMissing, total: associations.length }
}

export function stableSets(summaries) {
  return {
    workload: stablePartition(summaries, "workload"),
    platform: stablePartition(summaries, "platform"),
    chains: {
      workload: stableChainPartition(summaries, "workload"),
      platform: stableChainPartition(summaries, "platform"),
    },
  }
}

export function diffSides(base, head) {
  return {
    workload: diffPartition(base.workload, head.workload, base.chains.workload, head.chains.workload),
    platform: diffPartition(base.platform, head.platform, base.chains.platform, head.chains.platform),
  }
}

export function evaluateGates({ pr, cells, jobs, profiles, headSha, runId }) {
  const reasons = []
  if (pr.head?.sha !== headSha) reasons.push("PR head moved")
  if (cells.some((cell) => cell.side === "base" && cell.expected_sha !== pr.base?.sha)) reasons.push("base moved")
  if (cells.length < 6) reasons.push(`cell artifacts: ${cells.length}/6`)
  const absentWorkloadSides = new Set(cells.filter((cell) => !cell.workload_present).map((cell) => cell.side))
  for (const side of [...absentWorkloadSides].sort()) reasons.push(`workload fixture absent at ${side}`)
  for (const cell of cells) {
    if (cell.executed_sha !== cell.expected_sha) {
      reasons.push(`executed commit mismatch in ${cell.profile_job}`)
    }
  }
  const executionJobs = jobs.filter((job) => (
    /^execution-diff(?: \((?:base|head), [123]\)|-(?:base|head)-[123])$/.test(job.name)
  ))
  if (executionJobs.length < 6) reasons.push(`jobs found: ${executionJobs.length}/6`)
  for (const job of executionJobs) {
    if (job.conclusion !== "success") {
      reasons.push(`job ${job.name} concluded ${job.conclusion}`)
    }
  }
  const matchingProfiles = dedupeProfiles(profiles).filter((profile) => {
    const run = profile.profiles?.[0]?.run || profile.run
    return String(run?.run_id) === String(runId) && PROFILE_JOB_RE.test(run?.job || "")
  })
  const uniqueProfiles = new Map()
  for (const profile of matchingProfiles) {
    const run = profile.profiles?.[0]?.run || profile.run
    uniqueProfiles.set(run.job, profile)
  }
  if (uniqueProfiles.size < 6) reasons.push(`profiles published: ${uniqueProfiles.size}/6`)
  for (const profile of uniqueProfiles.values()) {
    const run = profile.profiles?.[0]?.run || profile.run
    if (run.commit_sha !== headSha) reasons.push(`profile commit mismatch in ${run.job}`)
  }
  const lineageMissing = [...uniqueProfiles.values()].reduce((count, profile) => (
    count + (profile.profiles || [profile]).reduce((inner, item) => (
      inner + (item.associations || []).filter((association) => association.lineage_recorded === false).length
    ), 0)
  ), 0)
  if (lineageMissing) reasons.push(`lineage not recorded for ${lineageMissing} chains`)
  return { status: reasons.length ? "undeterminable" : "determinable", reasons }
}

export function dedupeProfiles(profiles) {
  const unique = new Map()
  for (const profile of profiles) {
    const run = profileRun(profile)
    if (!run?.job) continue
    const current = unique.get(run.job)
    if (!current || profileTimestamp(profile) >= profileTimestamp(current)) unique.set(run.job, profile)
  }
  return [...unique.values()]
}

export function renderReceipt({ status, reasons, meta, diff, profiles, cells }) {
  const baseSha = meta.base
  const headSha = meta.head
  const headline = status === "undeterminable"
    ? `**undeterminable** — ${reasons.join("; ")}`
    : diff.workload.added.length === 0 && diff.workload.removed.length === 0
      ? "**workload unchanged** — same destinations and execution chains in all 3 runs per side"
      : `**workload +${diff.workload.added.length} −${diff.workload.removed.length} destinations · +${diff.workload.chains.added.length} −${diff.workload.chains.removed.length} execution chains** (stable across all 3 runs per side)`
  const baseProfiles = profiles.filter((profile) => profileSide(profile) === "base")
  const headProfiles = profiles.filter((profile) => profileSide(profile) === "head")
  const allProfiles = [...baseProfiles, ...headProfiles]
  const lineageTotal = allProfiles.reduce((total, profile) => total + profileSummary(profile).total, 0)
  const lineageMissing = allProfiles.reduce((total, profile) => total + profileSummary(profile).lineageMissing, 0)
  const runners = [...new Set(cells.map((cell) => cell.runner_name).filter(Boolean))].sort()
  const imageCell = cells.find((cell) => cell.image_os || cell.image_version) || {}
  const workloadTable = renderPartitionTable("workload", baseProfiles, headProfiles, diff.workload)
  const platformTable = renderPartitionTable("platform", baseProfiles, headProfiles, diff.platform)
  const rowsAtHead = workloadTable.rows.filter((row) => row.head.reps > 0).length
  const varianceAtHead = workloadTable.rows.filter((row) => row.delta === "variance").length
  const platformRowsAtHead = platformTable.rows.filter((row) => row.head.reps > 0).length
  const platformVariance = platformTable.rows.filter((row) => row.delta === "variance").length
  const links = renderProfileLinks(profiles)
  const machine = {
    contract: "execution-diff/v1",
    status,
    base: baseSha,
    head: headSha,
    run_id: String(meta.run_id),
    repetitions: 3,
    runner: RUNNER_LABEL,
    workload: {
      added: diff.workload.added,
      removed: diff.workload.removed,
      variance: diff.workload.variance,
      chains_added: diff.workload.chains.added.length,
      chains_removed: diff.workload.chains.removed.length,
    },
    platform: {
      added: diff.platform.added,
      removed: diff.platform.removed,
      variance: diff.platform.variance,
      chains_added: diff.platform.chains.added.length,
      chains_removed: diff.platform.chains.removed.length,
    },
    profiles: allProfiles.map((profile) => {
      const run = profileRun(profile)
      return { side: profileSide(profile), rep: Number(run.job.split("/").at(-1)), run_id: String(run.run_id), profile_id: run.profile_id }
    }),
    reasons,
  }
  return [
    BEGIN,
    "## Execution diff (Garnet)",
    "",
    `base \`${baseSha.slice(0, 7)}\` → head \`${headSha.slice(0, 7)}\` · \`Garnet Execution Diff\` / \`execution-diff\` · \`${RUNNER_LABEL}\`${imageCell.image_os || imageCell.image_version ? ` (${[imageCell.image_os, imageCell.image_version].filter(Boolean).join(" ")})` : ""} · 3 runs per side · ${headline}`,
    "",
    `<details open><summary>workload · ${rowsAtHead} destinations at head · ${varianceAtHead} with run-to-run variance</summary>`,
    "",
    ...workloadTable.lines,
    ...(diff.workload.chains.added.length || diff.workload.chains.removed.length
      ? ["", "```diff", ...renderChainChanges(diff.workload), "```"]
      : []),
    "",
    "</details>",
    "",
    `<details><summary>runner platform · ${platformRowsAtHead} destinations at head · ${platformVariance} with run-to-run variance · no recorded workflow step, no Runner.Worker descent</summary>`,
    "",
    ...platformTable.lines,
    ...(diff.platform.chains.added.length || diff.platform.chains.removed.length
      ? ["", "```diff", ...renderChainChanges(diff.platform), "```"]
      : []),
    "",
    "</details>",
    "",
    `capture: ${allProfiles.length}/6 profiles · lineage recorded ${lineageTotal ? Math.round((lineageTotal - lineageMissing) / lineageTotal * 100) : 0}% · executed commit verified ${cells.filter((cell) => cell.executed_sha === cell.expected_sha).length}/6 cells · runners ${runners.join(", ") || "none recorded"}`,
    `profiles: ${links || "none published"}`,
    "",
    "Same workload, same runner label; rows marked new or gone appear in all 3 runs of one side and none of the other.",
    "",
    `<sub>recorded at the kernel by Garnet · \`garnet-org/action@${meta.action_sha.slice(0, 7)}\` (v2.3.0-rc.1)</sub>`,
    `<!-- garnet:execution-diff:summary ${JSON.stringify(machine)} -->`,
    END,
  ].join("\n")
}

export function upsertExecutionDiff(body, block) {
  const begin = BEGIN_LINE_RE.exec(body)
  if (begin) {
    const after = body.slice(begin.index)
    const end = END_LINE_RE.exec(after)
    if (!end) return null
    return body.slice(0, begin.index) + block + after.slice(end.index + end[0].length)
  }
  return `${body.trimEnd()}\n\n${block}\n`
}

function stablePartition(summaries, partition) {
  const destinations = union(summaries.map((summary) => new Set(summary[partition].keys())))
  const stable = new Set([...destinations].filter((destination) => summaries.every((summary) => summary[partition].has(destination))))
  const variance = new Set([...destinations].filter((destination) => !stable.has(destination)))
  const details = new Map()
  for (const destination of destinations) {
    const present = summaries.map((summary) => summary[partition].get(destination)).filter(Boolean)
    const processes = new Set(present.flatMap((group) => [...group.processes]))
    details.set(destination, {
      reps: present.length,
      chainsMin: Math.min(...present.map((group) => group.chains)),
      chainsMax: Math.max(...present.map((group) => group.chains)),
      processes: [...processes].sort(),
    })
  }
  return { stable, variance, details }
}

function stableChainPartition(summaries, partition) {
  const sets = summaries.map((summary) => summary.chains[partition])
  const all = union(sets)
  const stable = new Set([...all].filter((chain) => sets.every((set) => set.has(chain))))
  return { stable, variance: new Set([...all].filter((chain) => !stable.has(chain))) }
}

function diffPartition(base, head, baseChains, headChains) {
  return {
    ...diffSets(base, head),
    chains: diffSets(baseChains, headChains),
  }
}

function diffSets(base, head) {
  const baseAll = new Set([...base.stable, ...base.variance])
  const headAll = new Set([...head.stable, ...head.variance])
  const added = [...head.stable].filter((destination) => !baseAll.has(destination)).sort()
  const removed = [...base.stable].filter((destination) => !headAll.has(destination)).sort()
  const variance = [...new Set([...base.variance, ...head.variance])].sort()
  const bothUnstable = [...baseAll].filter((destination) => (
    headAll.has(destination) && (!base.stable.has(destination) || !head.stable.has(destination))
  ))
  for (const destination of bothUnstable) if (!variance.includes(destination)) variance.push(destination)
  variance.sort()
  return {
    added,
    removed,
    variance,
    unchanged: [...head.stable].filter((destination) => base.stable.has(destination)).sort(),
  }
}

function renderPartitionTable(partition, baseProfiles, headProfiles, diff) {
  const base = stableSets(baseProfiles.map(profileSummary))
  const head = stableSets(headProfiles.map(profileSummary))
  const destinations = new Set([...base[partition].details.keys(), ...head[partition].details.keys()])
  const rows = [...destinations].map((destination) => {
    const baseDetail = base[partition].details.get(destination) || emptyDetail()
    const headDetail = head[partition].details.get(destination) || emptyDetail()
    const delta = diff.added.includes(destination)
      ? "new"
      : diff.removed.includes(destination)
        ? "gone"
        : diff.variance.includes(destination) || baseDetail.reps < 3 || headDetail.reps < 3
          ? "variance"
          : "—"
    return { destination, base: baseDetail, head: headDetail, delta }
  }).sort((left, right) => right.head.chainsMax - left.head.chainsMax || left.destination.localeCompare(right.destination))
  return {
    rows,
    lines: rows.length
      ? [
        "| destination | base | head | Δ | reached by |",
        "|---|---|---|---|---|",
        ...rows.map((row) => `| \`${renderDestination(row.destination)}\` | ${formatDetail(row.base)} | ${formatDetail(row.head)} | ${row.delta} | ${row.head.processes.length || row.base.processes.length ? [...new Set([...row.base.processes, ...row.head.processes])].sort().map((process) => `\`${process}\``).join(", ") : "—"} |`),
      ]
      : ["none recorded"],
  }
}

function renderChainChanges(diff) {
  return [
    ...diff.chains.added.map((chain) => `+ ${renderChain(chain)}`),
    ...diff.chains.removed.map((chain) => `- ${renderChain(chain)}`),
  ]
}

function formatDetail(detail) {
  if (!detail.reps) return "0/3"
  const range = detail.chainsMin === detail.chainsMax
    ? `${detail.chainsMin} chain${detail.chainsMin === 1 ? "" : "s"}`
    : `${detail.chainsMin}–${detail.chainsMax} chains`
  return `${detail.reps}/3 · ${range}`
}

function emptyDetail() {
  return { reps: 0, chainsMin: 0, chainsMax: 0, processes: [] }
}

function union(sets) {
  return new Set(sets.flatMap((set) => [...set]))
}

function profileSummary(profile) {
  return summarizeProfile(profile.profiles?.[0] || profile)
}

function profileRun(profile) {
  return profile.profiles?.[0]?.run || profile.run
}

function profileSide(profile) {
  return profileRun(profile).job.split("/")[1]
}

function profileTimestamp(profile) {
  const timestamp = profile.profiles?.[0]?.timestamp || profile.timestamp
  const value = Date.parse(timestamp || "")
  return Number.isNaN(value) ? 0 : value
}

function renderChain(chain) {
  const separator = " → "
  const index = chain.lastIndexOf(separator)
  if (index < 0) return chain
  return `${chain.slice(0, index)}${separator}${renderDestination(chain.slice(index + separator.length))}`
}

function renderProfileLinks(profiles) {
  return ["base", "head"].flatMap((side) => {
    const links = profiles
      .filter((profile) => profileSide(profile) === side)
      .sort((left, right) => Number(profileRun(left).job.split("/").at(-1)) - Number(profileRun(right).job.split("/").at(-1)))
      .map((profile) => {
        const run = profileRun(profile)
        return `[${run.job.split("/").at(-1)}](https://app.garnet.ai/public/runs/${run.run_id}?profile=${run.profile_id})`
      })
    return links.length ? `${side} ${links.join(" · ")}` : []
  }).join(" · ")
}

async function main() {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY || !env.PR_NUMBER || !env.HEAD_SHA || !env.RUN_ID) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA and RUN_ID are required")
  }
  const pr = await github(`/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}`)
  if (pr.head?.sha !== env.HEAD_SHA) {
    console.log(`PR head moved (${pr.head?.sha} != ${env.HEAD_SHA}); skipping stale execution diff.`)
    return
  }
  const [jobsResponse, artifactsResponse] = await Promise.all([
    github(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.RUN_ID}/jobs?per_page=100`),
    github(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.RUN_ID}/artifacts?per_page=100`),
  ])
  const cells = await readCells(artifactsResponse.artifacts || [])
  const profiles = dedupeProfiles(await pollProfiles())
  const latestPr = await github(`/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}`)
  if (latestPr.head?.sha !== env.HEAD_SHA) {
    console.log(`PR head moved (${latestPr.head?.sha} != ${env.HEAD_SHA}); skipping stale execution diff.`)
    return
  }
  const gate = evaluateGates({
    pr: latestPr,
    cells,
    jobs: jobsResponse.jobs || [],
    profiles,
    headSha: env.HEAD_SHA,
    runId: env.RUN_ID,
  })
  const diff = gate.status === "determinable"
    ? diffSides(
      stableSets(cells.filter((cell) => cell.side === "base").map((cell) => profileSummary(profiles.find((profile) => profileRun(profile).job === cell.profile_job)))),
      stableSets(cells.filter((cell) => cell.side === "head").map((cell) => profileSummary(profiles.find((profile) => profileRun(profile).job === cell.profile_job)))),
    )
    : emptyDiff()
  const block = renderReceipt({
    status: gate.status,
    reasons: gate.reasons,
    meta: {
      base: latestPr.base?.sha || "",
      head: env.HEAD_SHA,
      run_id: env.RUN_ID,
      action_sha: "c747ff1f597c84579e10173301a31c30bb815181",
    },
    diff,
    profiles,
    cells,
  })
  const nextBody = upsertExecutionDiff(latestPr.body || "", block)
  if (nextBody === null) {
    console.log("Malformed execution diff delimiters found; skipping without writing.")
    return
  }
  if ((latestPr.body || "").replace(BEGIN, "").replace(END, "").length + block.length > BODY_LIMIT) {
    console.log("Execution diff exceeds the PR description size budget; skipping.")
    return
  }
  if (!nextBody.trim()) {
    console.log("Refusing to write an empty PR description; skipping.")
    return
  }
  if (nextBody === latestPr.body) {
    console.log("Execution diff already current; nothing to do.")
    return
  }
  await github(`/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}`, {
    method: "PATCH",
    body: JSON.stringify({ body: nextBody }),
  })
  console.log(`Mirrored execution diff for head ${env.HEAD_SHA.slice(0, 7)}.`)
}

async function github(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  })
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

async function readCells(artifacts) {
  const cells = []
  for (const artifact of artifacts.filter((item) => item.name.startsWith("garnet-execution-diff-"))) {
    const zip = `${await mkdtemp(`${tmpdir()}/garnet-execution-diff-`)}.zip`
    const directory = await mkdtemp(`${tmpdir()}/garnet-execution-diff-unzip-`)
    const response = await fetch(artifact.archive_download_url, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` },
      redirect: "manual",
    })
    const download = response.status >= 300 && response.status < 400
      ? await fetch(response.headers.get("location"))
      : response
    if (!download.ok) throw new Error(`artifact ${artifact.name}: ${download.status}`)
    await writeFile(zip, Buffer.from(await download.arrayBuffer()))
    await execFileAsync("unzip", ["-o", zip, "-d", directory])
    const files = await findFiles(directory, "cell.json")
    if (files[0]) cells.push(JSON.parse(await readFile(files[0], "utf8")))
  }
  return cells
}

async function pollProfiles() {
  const deadline = Date.now() + 10 * 60 * 1000
  while (true) {
    const comments = await listComments()
    const links = new Map()
    for (const comment of comments) {
      if (!isTrustedEvidenceComment(comment)) continue
      if (COMMIT_RE.exec(comment.body)?.[1] !== env.HEAD_SHA) continue
      for (const match of comment.body.matchAll(PROFILE_RE)) links.set(`${match[1]}:${match[2]}`, match)
    }
    const profiles = []
    for (const match of links.values()) {
      const response = await fetch(`https://app.garnet.ai/api/public/runs/${match[1]}?profile=${match[2]}`)
      if (!response.ok) continue
      const profile = await response.json()
      const run = profileRun(profile)
      if (String(run?.run_id) === String(env.RUN_ID) && PROFILE_JOB_RE.test(run?.job || "")) profiles.push(profile)
    }
    if (new Set(profiles.map((profile) => profileRun(profile).job)).size >= 6 || Date.now() >= deadline) return profiles
    await new Promise((resolve) => setTimeout(resolve, 30000))
  }
}

async function listComments() {
  const comments = []
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(`/repos/${env.GITHUB_REPOSITORY}/issues/${env.PR_NUMBER}/comments?per_page=100&page=${page}`)
    comments.push(...batch)
    if (batch.length < 100) break
  }
  return comments
}

function emptyDiff() {
  return {
    workload: { added: [], removed: [], variance: [], unchanged: [], chains: { added: [], removed: [], variance: [], unchanged: [] } },
    platform: { added: [], removed: [], variance: [], unchanged: [], chains: { added: [], removed: [], variance: [], unchanged: [] } },
  }
}

async function findFiles(directory, name) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) files.push(...await findFiles(path, name))
    else if (entry.name === name) files.push(path)
  }
  return files
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
