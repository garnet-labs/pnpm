import { readFile } from "node:fs/promises"
import { isIP } from "node:net"
import { pathToFileURL } from "node:url"

import { isTrustedEvidenceComment } from "./garnet-evidence-mirror.mjs"

const BEGIN = "<!-- garnet:workload:begin -->"
const END = "<!-- garnet:workload:end -->"
const BEGIN_LINE_RE = /^<!-- garnet:workload:begin -->[ \t]*\r?$/m
const END_LINE_RE = /^<!-- garnet:workload:end -->[ \t]*\r?$/m
const COMMIT_RE = /<!--\s*garnet:commit\s+([0-9a-f]{40})\s*-->/
const PROFILE_RE = /https:\/\/app\.garnet\.ai\/public\/runs\/(\d+)\?profile=([0-9a-f-]+)/i
const BODY_LIMIT = 65536
const env = globalThis.process.env
const api = env.GITHUB_API_URL || "https://api.github.com"
const repo = env.GITHUB_REPOSITORY
const prNumber = env.PR_NUMBER
const headSha = env.HEAD_SHA

export function classifyAssociation(association) {
  const step = association.github_step || ""
  const ancestry = association.ancestry || []
  return /^99\.\s/.test(step) || (!step && !ancestry.includes("Runner.Worker"))
    ? "platform"
    : "workload"
}

export function destinationFor(association) {
  return association.remote_names?.[0] || association.remote_address
}

export function renderDestination(destination) {
  if (isIP(destination)) return destination
  const dot = destination.lastIndexOf(".")
  return dot === -1 ? destination : `${destination.slice(0, dot)}[.]${destination.slice(dot + 1)}`
}

export function groupAssociations(associations) {
  const groups = new Map()
  for (const association of associations) {
    const destination = destinationFor(association)
    const group = groups.get(destination) || { chains: 0, processes: new Set() }
    group.chains += 1
    if (association.process) group.processes.add(association.process)
    groups.set(destination, group)
  }
  return [...groups.entries()]
    .map(([destination, group]) => ({
      destination,
      chains: group.chains,
      processes: [...group.processes].sort(),
    }))
    .sort((left, right) => right.chains - left.chains || left.destination.localeCompare(right.destination))
}

export function partitionProfile(profile) {
  const associations = profile.associations || []
  const workload = associations.filter((association) => classifyAssociation(association) === "workload")
  const platform = associations.filter((association) => classifyAssociation(association) === "platform")
  return {
    workload: groupAssociations(workload),
    platform: groupAssociations(platform),
    total: associations.length,
    workloadChains: workload.length,
    platformChains: platform.length,
  }
}

function mapByDestination(rows) {
  return new Map(rows.map((row) => [row.destination, row]))
}

function deltaFor(current, baseline) {
  const currentByDestination = mapByDestination(current)
  const baselineByDestination = mapByDestination(baseline)
  const added = current.filter((row) => !baselineByDestination.has(row.destination))
  const removed = baseline.filter((row) => !currentByDestination.has(row.destination))
  const changed = current.filter((row) => {
    const previous = baselineByDestination.get(row.destination)
    return previous && (
      previous.chains !== row.chains ||
      previous.processes.join("\u0000") !== row.processes.join("\u0000")
    )
  })
  return {
    baselineByDestination,
    currentByDestination,
    added,
    removed,
    changed,
    destinationsSame: added.length === 0 && removed.length === 0,
    same: added.length === 0 && removed.length === 0 && changed.length === 0,
  }
}

function renderProcesses(processes) {
  return processes.map((process) => `\`${process}\``).join(", ")
}

function renderRows(rows, baselineRows = null) {
  const baselineByDestination = baselineRows ? mapByDestination(baselineRows) : null
  const currentDestinations = new Set(rows.map((row) => row.destination))
  const rendered = rows.map((row) => {
    const previous = baselineByDestination?.get(row.destination)
    const delta = !baselineByDestination
      ? null
      : !previous
        ? "new"
        : previous.chains === row.chains
          ? "—"
          : `${previous.chains} → ${row.chains}`
    return {
      ...row,
      delta,
    }
  })
  if (baselineRows) {
    for (const row of baselineRows) {
      if (!currentDestinations.has(row.destination)) {
        rendered.push({ ...row, chains: 0, delta: "gone" })
      }
    }
  }
  rendered.sort((left, right) => right.chains - left.chains || left.destination.localeCompare(right.destination))
  return rendered.map((row) => (
    `| \`${renderDestination(row.destination)}\` | ${row.chains} | ${row.delta} | ${renderProcesses(row.processes)} |`
  ))
}

function renderRowsWithoutDelta(rows) {
  return rows.map((row) => (
    `| \`${renderDestination(row.destination)}\` | ${row.chains} | ${renderProcesses(row.processes)} |`
  ))
}

function renderDeltaLines(delta) {
  const lines = []
  for (const row of delta.added) {
    lines.push(`+ \`${renderDestination(row.destination)}\` reached by ${renderProcesses(row.processes)}`)
  }
  for (const row of delta.removed) {
    lines.push(`− \`${renderDestination(row.destination)}\``)
  }
  return lines
}

function renderTable(rows, baselineRows = null) {
  const headers = baselineRows
    ? ["| destination | chains | Δ vs base | reached by |", "|---|---:|---|---|"]
    : ["| destination | chains | reached by |", "|---|---:|---|"]
  return [
    ...headers,
    ...(baselineRows ? renderRows(rows, baselineRows) : renderRowsWithoutDelta(rows)),
  ]
}

export function renderWorkloadBlock(profile, baselineProfile = null) {
  const current = partitionProfile(profile)
  const baseline = baselineProfile ? partitionProfile(baselineProfile) : null
  const run = profile.run
  const sha7 = run.commit_sha.slice(0, 7)
  const lines = [
    BEGIN,
    "## Workload behaviour (Garnet)",
    "",
    `\`${run.workflow}\` / \`${run.job}\` · head \`${sha7}\` · ${current.workloadChains}&nbsp;workload chains · ${current.platformChains}&nbsp;runner-platform chains`,
    "",
  ]

  if (baseline) {
    const workloadDelta = deltaFor(current.workload, baseline.workload)
    const base7 = baselineProfile.run.commit_sha.slice(0, 7)
    if (workloadDelta.same) {
      lines.push(`**Workload behaviour unchanged vs \`${base7}\`** — same destinations, same reaching processes.`)
    } else if (workloadDelta.destinationsSame) {
      lines.push(
        `**Workload destinations unchanged vs \`${base7}\`** — connection volume ` +
        `${baseline.workloadChains} → ${current.workloadChains} chains.`,
      )
    } else {
      lines.push(`**Workload behaviour vs \`${base7}\`: +${workloadDelta.added.length} −${workloadDelta.removed.length} destinations**`)
      lines.push(...renderDeltaLines(workloadDelta))
    }
    const platformDelta = deltaFor(current.platform, baseline.platform)
    if (!platformDelta.same) {
      lines.push(`runner platform: +${platformDelta.added.length} −${platformDelta.removed.length} destinations · not workload behaviour`)
    }
    lines.push("")
  }

  const workloadBaselineRows = baseline?.workload || null
  const platformBaselineRows = baseline?.platform || null
  const workloadGoneCount = workloadBaselineRows
    ? workloadBaselineRows.filter((row) => !current.workload.some((currentRow) => currentRow.destination === row.destination)).length
    : 0
  const platformGoneCount = platformBaselineRows
    ? platformBaselineRows.filter((row) => !current.platform.some((currentRow) => currentRow.destination === row.destination)).length
    : 0
  const workloadSummary = workloadGoneCount
    ? `${current.workloadChains}&nbsp;workload chains · ${current.workload.length}&nbsp;destinations at head, ${workloadGoneCount}&nbsp;gone`
    : `${current.workloadChains}&nbsp;workload chains · ${current.workload.length}&nbsp;destinations`
  const platformSummary = platformGoneCount
    ? `runner platform · ${current.platformChains}&nbsp;chains · ${current.platform.length}&nbsp;destinations at head, ${platformGoneCount}&nbsp;gone · no recorded workflow step`
    : `runner platform · ${current.platformChains}&nbsp;chains · ${current.platform.length}&nbsp;destinations · no recorded workflow step`
  lines.push(
    `<details open><summary>${workloadSummary}</summary>`,
    "",
    ...renderTable(current.workload, workloadBaselineRows),
    "",
    "</details>",
    "",
    `<details><summary>${platformSummary}</summary>`,
    "",
    ...renderTable(current.platform, platformBaselineRows),
    "",
    "</details>",
    "",
    `<sub>recorded at the kernel by Garnet · profile <a href="https://app.garnet.ai/public/runs/${run.run_id}?profile=${run.profile_id}">view →</a></sub>`,
    END,
  )
  return lines.join("\n")
}

export function reconcileProfile(profile) {
  const partition = partitionProfile(profile)
  return {
    totalMatches: partition.workloadChains + partition.platformChains === partition.total,
    workloadRowsMatch: partition.workload.length === new Set(partition.workload.map((row) => row.destination)).size,
    platformRowsMatch: partition.platform.length === new Set(partition.platform.map((row) => row.destination)).size,
    workloadChains: partition.workloadChains,
    platformChains: partition.platformChains,
    total: partition.total,
    workloadDestinations: partition.workload.length,
    platformDestinations: partition.platform.length,
  }
}

export function renderProfile(headProfile, baselineProfile = null) {
  return renderWorkloadBlock(
    headProfile.profiles[0],
    baselineProfile ? baselineProfile.profiles[0] : null,
  )
}

async function github(path, init = {}) {
  const response = await globalThis.fetch(`${api}${path}`, {
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

async function listComments() {
  const comments = []
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(`/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`)
    comments.push(...batch)
    if (batch.length < 100) break
  }
  return comments
}

function selectHeadProfileComment(comments) {
  return comments.find((comment) => {
    if (!isTrustedEvidenceComment(comment)) return false
    const commit = COMMIT_RE.exec(comment.body)
    return commit?.[1] === headSha && PROFILE_RE.test(comment.body)
  }) || null
}

async function fetchProfile(runId, profileId, label) {
  const url = `https://app.garnet.ai/api/public/runs/${runId}?profile=${profileId}`
  const response = await globalThis.fetch(url)
  if (!response.ok) {
    globalThis.console.log(`${label} profile fetch returned HTTP ${response.status}; skipping.`)
    return null
  }
  const profile = await response.json()
  if (!Array.isArray(profile.profiles) || !profile.profiles[0]) {
    globalThis.console.log(`${label} profile response had no profiles; skipping.`)
    return null
  }
  return profile
}

async function readBaseline() {
  let baseline
  try {
    baseline = JSON.parse(await readFile(new globalThis.URL("../../.garnet/workload-baseline.json", import.meta.url), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  if (
    typeof baseline.run_id !== "string" ||
    typeof baseline.profile_id !== "string" ||
    !/^[0-9a-f]{40}$/.test(baseline.commit)
  ) {
    throw new Error("invalid .garnet/workload-baseline.json")
  }
  return baseline
}

function removeSection(body) {
  const begin = BEGIN_LINE_RE.exec(body)
  if (!begin) return body
  const after = body.slice(begin.index)
  const end = END_LINE_RE.exec(after)
  if (!end) return body
  return body.slice(0, begin.index) + after.slice(end.index + end[0].length)
}

export function upsert(body, block) {
  const begin = BEGIN_LINE_RE.exec(body)
  if (begin) {
    const after = body.slice(begin.index)
    const end = END_LINE_RE.exec(after)
    if (!end) return null
    return body.slice(0, begin.index) + block + after.slice(end.index + end[0].length)
  }
  return `${body.trimEnd()}\n\n${block}\n`
}

async function main() {
  if (!env.GITHUB_TOKEN || !repo || !prNumber || !headSha) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER and HEAD_SHA are required")
  }
  const comments = await listComments()
  const comment = selectHeadProfileComment(comments)
  if (!comment) {
    globalThis.console.log(`No trusted head-bound Garnet profile comment found for ${headSha.slice(0, 7)}; skipping.`)
    return
  }
  const profileLink = PROFILE_RE.exec(comment.body)
  const headProfile = await fetchProfile(profileLink[1], profileLink[2], "head")
  if (!headProfile) return
  const baselineIdentity = await readBaseline()
  const baselineProfile = baselineIdentity
    ? await fetchProfile(baselineIdentity.run_id, baselineIdentity.profile_id, "baseline")
    : null
  if (baselineIdentity && !baselineProfile) return
  let usableBaselineProfile = baselineProfile
  if (baselineProfile && baselineProfile.profiles[0].run.commit_sha !== baselineIdentity.commit) {
    globalThis.console.log(
      `Baseline profile commit mismatch (${baselineProfile.profiles[0].run.commit_sha.slice(0, 7)} != ${baselineIdentity.commit.slice(0, 7)}); rendering head-only.`,
    )
    usableBaselineProfile = null
  }
  const pr = await github(`/repos/${repo}/pulls/${prNumber}`)
  if (pr.head?.sha !== headSha) {
    globalThis.console.log(`PR head moved (${pr.head?.sha?.slice(0, 7)} != ${headSha.slice(0, 7)}); skipping stale profile.`)
    return
  }
  const bodyWithoutSection = removeSection(pr.body || "")
  const block = renderProfile(headProfile, usableBaselineProfile)
  if (bodyWithoutSection.length + block.length > BODY_LIMIT) {
    globalThis.console.log("Workload view exceeds the PR description size budget; skipping.")
    return
  }
  const nextBody = upsert(pr.body || "", block)
  if (nextBody === null) {
    globalThis.console.log("Malformed workload section delimiters found; skipping without writing.")
    return
  }
  if (!nextBody.trim()) {
    globalThis.console.log("Refusing to write an empty PR description; skipping.")
    return
  }
  if (nextBody === pr.body) {
    globalThis.console.log("Workload view already current; nothing to do.")
    return
  }
  await github(`/repos/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ body: nextBody }),
  })
  globalThis.console.log(`Mirrored workload view for head ${headSha.slice(0, 7)}.`)
}

if (globalThis.process.argv[1] && import.meta.url === pathToFileURL(globalThis.process.argv[1]).href) await main()
