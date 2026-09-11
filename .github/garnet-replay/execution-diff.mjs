const PROFILE_RE = /[?&]profile=([0-9a-f-]{36})/i
const DESTINATION_RE = /^([+-])\s*[│├└─\s]*○ (.+?)\s*$/
const RUN_RE = /\/(?:actions\/runs|public\/runs)\/(\d+)/i
export const DEPENDENCY_RE = /(?:bump|update)\s+(\S+)\s+(?:from\s+(\S+)\s+)?to\s+(\S+)/i

export { executionDiffFromProfiles } from "./profile-diff.mjs"

function diffDestinations(commentBody) {
  const added = []
  const removed = []
  const blocks = typeof commentBody === "string" ? commentBody.matchAll(/```diff\n(.*?)```/gs) : []
  for (const block of blocks) {
    let section = "workload"
    for (const line of block[1].split("\n")) {
      if (line.includes("runner background")) {
        section = "runner background"
      }
      const match = DESTINATION_RE.exec(line)
      if (match === null) {
        continue
      }
      const entry = {
        destination: match[2],
        section,
        process: null,
        ancestry: [],
      }
      ;(match[1] === "+" ? added : removed).push(entry)
    }
  }
  return { added, removed }
}

function receiptUrl(runId, profileId, json = false) {
  if (typeof runId !== "string" || runId === "" || typeof profileId !== "string" || profileId === "") {
    return null
  }
  const path = json ? "https://app.garnet.ai/api/public/runs" : "https://app.garnet.ai/public/runs"
  return `${path}/${runId}?profile=${profileId}`
}

/**
 * Build an Execution Diff from an exact-head GitHub App receipt.
 * @param {Record<string, any>} pr
 * @param {{mode?: "known-evidence"|"live-replay", label?: "real"|"constructed"}} [options]
 * @returns {Record<string, any>|null}
 */
export function buildExecutionDiff(pr, { mode = "known-evidence", label = "real" } = {}) {
  if (pr?.garnet_exact_head !== true || pr.garnet_summary === null || typeof pr.garnet_summary !== "object") {
    return null
  }
  const summary = pr.garnet_summary
  const body = typeof pr.garnet_comment_body === "string" ? pr.garnet_comment_body : ""
  const profileId = PROFILE_RE.exec(body)?.[1] ?? null
  const runId = RUN_RE.exec(body)?.[1] ?? null
  const previous = typeof summary.previous === "string" ? summary.previous : null
  const dependencyMatch = typeof pr.title === "string" ? DEPENDENCY_RE.exec(pr.title) : null
  const dependency = dependencyMatch === null
    ? null
    : { name: dependencyMatch[1], from: dependencyMatch[2] ?? null, to: dependencyMatch[3] }
  const { added, removed } = diffDestinations(body)
  const diff = {
    schema_version: "execution-diff/v1",
    mode,
    label,
    repo: {
      owner: pr.url.split("/")[3],
      name: pr.url.split("/")[4],
      url: `https://github.com/${pr.url.split("/")[3]}/${pr.url.split("/")[4]}`,
    },
    pull_request: {
      number: pr.pr_number,
      url: pr.url,
      title: pr.title,
      ...(dependency === null ? {} : { dependency }),
    },
    base: { sha: previous, profile_id: null, run_id: null },
    head: { sha: pr.head_sha, profile_id: profileId, run_id: runId },
    comparison: {
      available: previous !== null,
      scope: previous === null ? "unavailable" : "previous-recorded-head-to-head",
    },
    execution_diff: {
      processes_added: [],
      processes_removed: [],
      network_added: added,
      network_removed: removed,
      files_added: [],
      files_removed: [],
      kinds_recorded: Array.isArray(summary.kinds) ? summary.kinds : [],
      totals: {
        execution_chains: summary.chains ?? null,
        destinations: summary.destinations ?? null,
        jobs_recorded: summary.jobs ?? null,
        jobs_changed: summary.changed ?? null,
        jobs_unchanged: summary.unchanged ?? null,
        workload: { added: summary.added ?? null, removed: summary.removed ?? null },
        runner_background: {
          added: summary.backgroundAdded ?? null,
          removed: summary.backgroundRemoved ?? null,
        },
      },
    },
    receipt_urls: {
      base: null,
      head: receiptUrl(runId, profileId),
      head_json: receiptUrl(runId, profileId, true),
      pr_comment: pr.garnet_comment_url ?? null,
    },
    recorded: {
      at: summary.recorded ?? null,
      contract: summary.contract ?? null,
      source: "github-app-comment",
    },
  }
  return diff
}

/**
 * Render an Execution Diff in the compact known-evidence text format.
 * @param {Record<string, any>} diff
 * @returns {string}
 */
export function renderExecutionDiffText(diff) {
  const lines = [
    `receipt_id: ${diff.head.profile_id}`,
    `head: ${diff.head.sha}`,
  ]
  if (diff.comparison.available === true) {
    lines.push(`compared with previous recorded head: ${diff.base.sha}`)
  } else {
    lines.push("comparison unavailable (no previous recorded head)")
  }
  const totals = diff.execution_diff.totals
  lines.push(
    `workload: ${totals.jobs_changed} job(s) changed, ${totals.jobs_unchanged} unchanged; ` +
      `destinations +${totals.workload.added} -${totals.workload.removed}`,
  )
  const network = diff.execution_diff
  lines.push(`recorded network evidence: ${totals.execution_chains} execution chains, ${totals.destinations} destinations`)
  for (const entry of network.network_added) {
    lines.push(`  + ${entry.destination} (${entry.section})`)
  }
  for (const entry of network.network_removed) {
    lines.push(`  - ${entry.destination} (${entry.section})`)
  }
  if (network.network_added.length === 0 && network.network_removed.length === 0) {
    lines.push("  no destination additions or removals recorded")
  }
  lines.push(`file evidence: ${network.kinds_recorded.includes("file") ? "recorded" : "none recorded for this run"}`)
  lines.push("deterministic detections: none recorded")
  lines.push(`recorded at: ${diff.recorded.at} · contract ${diff.recorded.contract}`)
  return lines.join("\n")
}
