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

const execFileAsync = promisify(execFile)
const BEGIN = "<!-- garnet:execution-diff:begin -->"
const END = "<!-- garnet:execution-diff:end -->"
const BEGIN_LINE_RE = /^<!-- garnet:execution-diff:begin -->[ \t]*\r?$/m
const END_LINE_RE = /^<!-- garnet:execution-diff:end -->[ \t]*\r?$/m
const PROFILE_RE = /Garnet Run Profile report:\s*(https:\/\/app\.garnet\.ai\/public\/runs\/(\d+)\?profile=([0-9a-f-]+))(?:&[^\s]*)?/i
const EXECUTION_JOB_RE = /^execution-diff \((base|head), ([123])\)$/
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

export function evaluateGates({
  pr,
  cells,
  jobs,
  profiles,
  profileLinks = [],
  headSha,
  mergeCommitSha,
  runId,
}) {
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
  const workloadRuns = workloadActivityCounts(cells, profiles)
  for (const side of ["base", "head"]) {
    if (cells.some((cell) => cell.side === side && cell.workload_present)
      && workloadRuns[side] > 0 && workloadRuns[side] < 3) {
      reasons.push(`workload activity recorded in ${workloadRuns[side]}/3 ${side} runs`)
    }
  }
  for (const link of profileLinks) {
    if (!link.url) reasons.push(`profile link missing in ${link.display_name}`)
    else if (link.public === false) reasons.push(`profile not public: ${link.identity}`)
  }
  const uniqueProfiles = new Map(profiles
    .map((profile) => [profileIdentity(profile), profile])
    .filter(([identity, profile]) => identity && String(profileRun(profile)?.run_id) === String(runId)))
  if (uniqueProfiles.size < 6) reasons.push(`profiles published: ${uniqueProfiles.size}/6`)
  for (const [identity, profile] of uniqueProfiles) {
    const run = profile.profiles?.[0]?.run || profile.run
    const acceptedCommits = new Set([headSha, mergeCommitSha])
    if (!acceptedCommits.has(run.commit_sha)) reasons.push(`profile commit mismatch in ${identity}`)
  }
  const lineageMissing = [...uniqueProfiles.values()].reduce((count, profile) => (
    count + (profile.profiles || [profile]).reduce((inner, item) => (
      inner + (item.associations || []).filter((association) => association.lineage_recorded === false).length
    ), 0)
  ), 0)
  if (lineageMissing) reasons.push(`lineage not recorded for ${lineageMissing} chains`)
  return { status: reasons.length ? "undeterminable" : "determinable", reasons }
}

export function workloadActivityCounts(cells, profiles) {
  return ["base", "head"].reduce((counts, side) => {
    const activeReps = new Set(cells
      .filter((cell) => cell.side === side && cell.workload_present)
      .map((cell) => {
        const profile = profiles.find((item) => profileIdentity(item) === cell.profile_job)
        return profile && profileSummary(profile).workload.size ? cell.rep : null
      })
      .filter((rep) => rep !== null))
    counts[side] = activeReps.size
    return counts
  }, { base: 0, head: 0 })
}

export function renderReceipt({ status, reasons, meta, diff, profiles, cells }) {
  const baseSha = meta.base
  const headSha = meta.head
  const baseProfiles = profiles.filter((profile) => profileSide(profile) === "base")
  const headProfiles = profiles.filter((profile) => profileSide(profile) === "head")
  const allProfiles = [...baseProfiles, ...headProfiles]
  const lineageTotal = allProfiles.reduce((total, profile) => total + profileSummary(profile).total, 0)
  const lineageMissing = allProfiles.reduce((total, profile) => total + profileSummary(profile).lineageMissing, 0)
  const runners = [...new Set(cells.map((cell) => cell.runner_name).filter(Boolean))].sort()
  const imageCell = cells.find((cell) => cell.image_os || cell.image_version) || {}
  const workloadTable = renderPartitionTable("workload", baseProfiles, headProfiles, diff.workload)
  const platformTable = renderPartitionTable("platform", baseProfiles, headProfiles, diff.platform)
  const headline = renderHeadline(status, reasons, diff.workload, workloadTable.summary)
  const workloadRuns = workloadActivityCounts(cells, profiles)
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
    capture: {
      base_workload_runs: workloadRuns.base,
      head_workload_runs: workloadRuns.head,
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
      return { side: profileSide(profile), rep: profileRep(profile), run_id: String(run.run_id), profile_id: run.profile_id }
    }),
    reasons,
  }
  return [
    BEGIN,
    "## Execution diff (Garnet)",
    "",
    `base \`${baseSha.slice(0, 7)}\` → head \`${headSha.slice(0, 7)}\` · \`Garnet Execution Diff\` / \`execution-diff\` · \`${RUNNER_LABEL}\`${imageCell.image_os || imageCell.image_version ? ` (${[imageCell.image_os, imageCell.image_version].filter(Boolean).join(" ")})` : ""} · 3 runs per side · ${headline}`,
    "",
    `<details open><summary>${renderPartitionSummary("workload", workloadTable.summary)}</summary>`,
    "",
    ...workloadTable.lines,
    ...(diff.workload.chains.added.length || diff.workload.chains.removed.length
      ? ["", "```diff", ...renderChainChanges(diff.workload), "```"]
      : []),
    "",
    "</details>",
    "",
    `<details><summary>${renderPartitionSummary("runner platform", platformTable.summary)} · no recorded workflow step, no Runner.Worker descent</summary>`,
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
  const chainVariance = new Set((diff.chains?.variance || []).map((chain) => chain.slice(chain.lastIndexOf(" → ") + 3)))
  const rows = [...destinations].map((destination) => {
    const baseDetail = base[partition].details.get(destination) || emptyDetail()
    const headDetail = head[partition].details.get(destination) || emptyDetail()
    const delta = diff.added.includes(destination)
      ? "new"
      : diff.removed.includes(destination)
        ? "gone"
        : diff.variance.includes(destination) || chainVariance.has(destination)
          ? "variance"
          : "—"
    return { destination, base: baseDetail, head: headDetail, delta }
  }).sort((left, right) => right.head.chainsMax - left.head.chainsMax || left.destination.localeCompare(right.destination))
  const summary = {
    total: rows.length,
    atHead: rows.filter((row) => row.head.reps > 0).length,
    baseOnly: rows.filter((row) => row.head.reps === 0 && row.base.reps > 0).length,
    variance: rows.filter((row) => row.delta === "variance").length,
    stableChanges: rows.filter((row) => row.delta === "new" || row.delta === "gone").length,
    unchanged: rows.filter((row) => row.delta === "—").length,
  }
  return {
    rows,
    summary,
    lines: rows.length
      ? [
        "| destination | base | head | Δ | reached by |",
        "|---|---|---|---|---|",
        ...rows.map((row) => `| \`${renderDestination(row.destination)}\` | ${formatDetail(row.base)} | ${formatDetail(row.head)} | ${row.delta} | ${row.head.processes.length || row.base.processes.length ? [...new Set([...row.base.processes, ...row.head.processes])].sort().map((process) => `\`${process}\``).join(", ") : "—"} |`),
      ]
      : ["none recorded"],
  }
}

function renderHeadline(status, reasons, diff, summary) {
  if (status === "undeterminable") return `**undeterminable** — ${reasons.join("; ")}`
  const stableDestinationChanges = diff.added.length + diff.removed.length
  const stableChainChanges = diff.chains.added.length + diff.chains.removed.length
  if (!stableDestinationChanges && !stableChainChanges) {
    if (summary.variance) {
      const noun = summary.variance === 1 ? "destination" : "destinations"
      const verb = summary.variance === 1 ? "differs" : "differ"
      return `**workload: no stable change** — ${summary.variance} ${noun} ${verb} between runs`
    }
    return "**workload unchanged** — same destinations and execution chains in all 3 runs per side"
  }
  const variance = summary.variance ? ` · ${summary.variance} with run-to-run variance` : ""
  return `**workload +${diff.added.length} ${noun(diff.added.length, "destination")} −${diff.removed.length} ${noun(diff.removed.length, "destination")} · +${diff.chains.added.length} ${noun(diff.chains.added.length, "execution chain")} −${diff.chains.removed.length} ${noun(diff.chains.removed.length, "execution chain")}${variance}** (stable across all 3 runs per side)`
}

function renderPartitionSummary(partition, summary) {
  const coverage = summary.baseOnly ? ` (${summary.atHead} at head, ${summary.baseOnly} base only)` : ""
  return `${partition} · ${plural(summary.total, "destination")}${coverage} · ${summary.variance} with run-to-run variance · ${plural(summary.stableChanges, "stable change")}`
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

function plural(count, singular) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

function noun(count, singular) {
  return count === 1 ? singular : `${singular}s`
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

function profileIdentity(profile) {
  return profile.execution_diff?.identity || profileRun(profile)?.job
}

function profileSide(profile) {
  return profile.execution_diff?.side || profileIdentity(profile)?.split("/")[1]
}

function profileRep(profile) {
  return profile.execution_diff?.rep || Number(profileIdentity(profile)?.split("/").at(-1))
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
      .sort((left, right) => profileRep(left) - profileRep(right))
      .map((profile) => {
        const run = profileRun(profile)
        const url = profile.execution_diff?.url || `https://app.garnet.ai/public/runs/${run.run_id}?profile=${run.profile_id}`
        return `[${profileRep(profile)}](${url})`
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
    github(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.RUN_ID}/jobs?filter=latest&per_page=100`),
    github(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.RUN_ID}/artifacts?per_page=100`),
  ])
  const cells = await readCells(artifactsResponse.artifacts || [])
  const profileDiscovery = await pollProfiles(jobsResponse.jobs || [])
  const profiles = profileDiscovery.profiles
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
    profileLinks: profileDiscovery.links,
    headSha: env.HEAD_SHA,
    runId: env.RUN_ID,
    mergeCommitSha: latestPr.merge_commit_sha,
  })
  const diff = diffSides(
    stableSets(profiles.filter((profile) => profileSide(profile) === "base").map(profileSummary)),
    stableSets(profiles.filter((profile) => profileSide(profile) === "head").map(profileSummary)),
  )
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

export function executionJob(name, id = undefined) {
  const match = EXECUTION_JOB_RE.exec(name || "")
  if (!match) return null
  const [, side, rep] = match
  return {
    id,
    side,
    rep: Number(rep),
    identity: `execution-diff/${side}/${rep}`,
    display_name: name,
  }
}

export function extractProfileLink(log) {
  const match = PROFILE_RE.exec(log || "")
  if (!match) return null
  return { url: match[1], run_id: match[2], profile_id: match[3] }
}

export function profileLinksFromLogs(jobs, logs) {
  return jobs
    .map((job) => executionJob(job.name, job.id))
    .filter(Boolean)
    .map((job) => ({ ...job, ...(extractProfileLink(logs.get(job.id)) || {}) }))
}

async function pollProfiles(jobs) {
  const deadline = Date.now() + 10 * 60 * 1000
  const executionJobs = jobs
    .map((job) => executionJob(job.name, job.id))
    .filter(Boolean)
  const linksByIdentity = new Map()
  if (!executionJobs.length) return { profiles: [], links: [] }
  while (true) {
    const logs = new Map()
    await Promise.all(executionJobs.map(async (job) => {
      if (!linksByIdentity.has(job.identity)) {
        try {
          logs.set(job.id, await jobLogs(job.id))
        } catch {
          logs.set(job.id, "")
        }
      }
    }))
    const lastLinks = profileLinksFromLogs(executionJobs.map((job) => ({ name: job.display_name, id: job.id })), logs)
    for (const link of lastLinks) {
      if (link.url) linksByIdentity.set(link.identity, link)
    }
    const profiles = []
    const publicProfiles = new Set()
    await Promise.all([...linksByIdentity.values()].map(async (link) => {
      const response = await fetch(`https://app.garnet.ai/api/public/runs/${link.run_id}?profile=${link.profile_id}`)
      if (!response.ok) return
      publicProfiles.add(link.identity)
      const profile = await response.json()
      const run = profileRun(profile)
      if (String(run?.run_id) !== String(env.RUN_ID)) return
      profile.execution_diff = {
        identity: link.identity,
        side: link.side,
        rep: link.rep,
        url: link.url,
      }
      profiles.push(profile)
    }))
    const links = executionJobs.map((job) => linksByIdentity.get(job.identity) || {
      ...job,
      url: undefined,
    })
    for (const link of links) {
      if (link.url) link.public = publicProfiles.has(link.identity)
    }
    const profilesReady = profiles.length >= executionJobs.length
      && executionJobs.every((job) => linksByIdentity.has(job.identity) && publicProfiles.has(job.identity))
    if (profilesReady || Date.now() >= deadline) {
      return { profiles, links }
    }
    await new Promise((resolve) => setTimeout(resolve, 30000))
  }
}

async function jobLogs(jobId) {
  const response = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/jobs/${jobId}/logs`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "manual",
  })
  const download = response.status >= 300 && response.status < 400
    ? await fetch(response.headers.get("location"))
    : response
  if (!download.ok) throw new Error(`job ${jobId} logs: ${download.status}`)
  return download.text()
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
