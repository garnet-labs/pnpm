import {
  buildRunProfile,
  isRealRecordedStep,
  summarizeProfile,
} from "./review.mjs"

function asRecord(profile) {
  if (profile === null || typeof profile !== "object") return null
  if (Array.isArray(profile.egress)) return profile
  const source = Array.isArray(profile.profiles) ? profile.profiles[0] : profile
  if (source && Array.isArray(source.associations)) {
    const run = source.run ?? {}
    return summarizeProfile({
      timestamp: source.timestamp,
      github: {
        ...run,
        sha: run.sha ?? run.commit_sha ?? "",
      },
      network: {
        egress: {
          peers: source.associations.map((association) => ({
            remote_names: association.remote_names ?? [],
            remote_address: association.remote_address ?? "",
            remote_ports: association.remote_ports ?? [],
            proc_trees: [{
              pid: association.pid ?? null,
              ancestry: association.ancestry ?? [],
              github_step: association.github_step ?? "",
            }],
          })),
        },
      },
      profile_id: run.profile_id ?? "",
    })
  }
  if (Array.isArray(profile.network?.egress?.peers)) return summarizeProfile(profile)
  return null
}

function normalizedProfile(profile, fallbackSha) {
  const record = asRecord(profile)
  if (record === null) return null
  const github = record.github ?? {}
  const fullSha = String(github.sha ?? record.full_sha ?? record.sha ?? fallbackSha ?? "")
  const runId = String(github.run_id ?? record.run_id ?? "")
  const profileId = String(record.profile_id ?? record.profileId ?? "")
  const built = buildRunProfile(record, {
    headSha: fullSha,
    runId,
    repository: github.repository ?? record.repository ?? "",
    githubServerUrl: "https://github.com",
    publicReportUrl: "https://app.garnet.ai",
    permalinkUrl: record.permalink ?? "",
  })
  return { ...record, ...built, github: { ...github, sha: fullSha, run_id: runId }, profile_id: profileId }
}

function ancestryFor(association) {
  return (Array.isArray(association?.ancestry) ? association.ancestry : [])
    .filter((name) => typeof name === "string" && name !== "")
    .map((name) => name.replace(/\d{4,}$/, "").trim())
    .filter((name) => name !== "")
}

function isWorkloadAssociation(association) {
  const ancestry = Array.isArray(association?.ancestry) ? association.ancestry : []
  return ancestry.includes("Runner.Worker") || isRealRecordedStep(association?.step ?? "")
}

function sectionFor(association) {
  return isWorkloadAssociation(association) ? "workload" : "runner background"
}

/**
 * Index recorded destinations by name, preserving the acting ancestry.
 * @param {Record<string, any>|null} record
 * @returns {Map<string, string[]>}
 */
export function destinationIndex(record) {
  const index = new Map()
  const associations = Array.isArray(record?.egress) ? record.egress : []
  for (const association of associations) {
    const destination = String(association?.name ?? association?.address ?? "")
    if (destination === "") continue
    const ancestry = ancestryFor(association)
    const actor = ancestry.length > 0 ? ancestry.join(" → ") : "unknown (not recorded)"
    const actors = index.get(destination) ?? new Set()
    actors.add(actor)
    index.set(destination, actors)
  }
  return new Map([...index.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([destination, actors]) => [destination, [...actors].sort()]))
}

/**
 * Compare destinations recorded in two summarized profiles.
 * @param {Record<string, any>|null} baseline
 * @param {Record<string, any>|null} update
 * @returns {{before: Map<string, string[]>, after: Map<string, string[]>, added: string[], removed: string[], shared: string[]}}
 */
export function diffDestinations(baseline, update) {
  const before = destinationIndex(baseline)
  const after = destinationIndex(update)
  const added = [...after.keys()].filter((destination) => !before.has(destination))
  const removed = [...before.keys()].filter((destination) => !after.has(destination))
  const shared = [...after.keys()].filter((destination) => before.has(destination))
  return { before, after, added, removed, shared }
}

function networkEntries(record, names) {
  const associations = Array.isArray(record?.egress) ? record.egress : []
  const wanted = new Set(names)
  return associations
    .filter((association) => wanted.has(String(association?.name ?? association?.address ?? "")))
    .map((association) => ({
      destination: String(association.name ?? association.address),
      section: sectionFor(association),
      process: ancestryFor(association).at(-1) ?? null,
      ancestry: ancestryFor(association),
    }))
    .sort((left, right) => `${left.destination}\u0000${left.section}`.localeCompare(`${right.destination}\u0000${right.section}`))
}

function processEntries(record) {
  const associations = Array.isArray(record?.egress) ? record.egress : []
  const unique = new Map()
  for (const association of associations) {
    const ancestry = ancestryFor(association)
    if (ancestry.length === 0) continue
    const section = sectionFor(association)
    unique.set(`${section}\u0000${ancestry.join("\u0000")}`, { ancestry, section })
  }
  return [...unique.values()].sort((left, right) => `${left.section}\u0000${left.ancestry.join("\u0000")}`
    .localeCompare(`${right.section}\u0000${right.ancestry.join("\u0000")}`))
}

function fileEntries(profile, key) {
  const direct = profile?.[`files_${key}`]
  const nested = profile?.files?.[key]
  const entries = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : []
  return entries.map((entry) => ({
    path: typeof entry === "string" ? entry : String(entry?.path ?? entry?.filename ?? ""),
    section: entry?.section === "runner background" ? "runner background" : "workload",
    ...(entry?.process !== undefined ? { process: entry.process } : {}),
  })).filter((entry) => entry.path !== "")
}

function side(profile, fallbackSha) {
  const record = normalizedProfile(profile, fallbackSha)
  if (record === null) return null
  return record
}

/**
 * Build a schema-compatible live replay Execution Diff from profile records.
 * @param {{baseline?: unknown, update?: unknown, meta?: Record<string, any>}} input
 * @returns {Record<string, any>}
 */
export function executionDiffFromProfiles({ baseline = null, update = null, meta = {} } = {}) {
  const base = side(baseline, meta.baselineSha)
  const head = side(update, meta.headSha)
  const comparisonAvailable = base !== null && head !== null
  const baseSha = meta.baselineSha || base?.github?.sha || null
  const headSha = meta.headSha || head?.github?.sha || null
  const baseRunId = meta.baseRunId ?? (base?.github?.run_id || base?.run_id || null)
  const headRunId = meta.headRunId ?? (head?.github?.run_id || head?.run_id || meta.runId || null)
  const baseProfileId = meta.baseProfileId ?? (base?.profile_id || null)
  const headProfileId = meta.headProfileId ?? (head?.profile_id || null)
  const destinationDiff = comparisonAvailable
    ? diffDestinations(base, head)
    : { before: new Map(), after: new Map(), added: [], removed: [], shared: [] }
  const baseProcesses = processEntries(base)
  const headProcesses = processEntries(head)
  const processKey = (entry) => `${entry.section}\u0000${entry.ancestry.join("\u0000")}`
  const baseKeys = new Set(baseProcesses.map(processKey))
  const headKeys = new Set(headProcesses.map(processKey))
  const processAdded = comparisonAvailable
    ? headProcesses.filter((entry) => !baseKeys.has(processKey(entry)))
    : []
  const processRemoved = comparisonAvailable
    ? baseProcesses.filter((entry) => !headKeys.has(processKey(entry)))
    : []
  const filesAdded = comparisonAvailable ? fileEntries(head, "added") : []
  const filesRemoved = comparisonAvailable ? fileEntries(base, "removed") : []
  const networkAdded = networkEntries(head, destinationDiff.added)
  const networkRemoved = networkEntries(base, destinationDiff.removed)
  const kinds = []
  if ((base?.egress?.length ?? 0) > 0 || (head?.egress?.length ?? 0) > 0) kinds.push("network")
  if (baseProcesses.length > 0 || processAdded.length > 0) kinds.push("process")
  if (filesAdded.length > 0 || filesRemoved.length > 0) kinds.push("file")
  const changed = networkAdded.length + networkRemoved.length + processAdded.length + processRemoved.length + filesAdded.length + filesRemoved.length > 0
  const repository = meta.repository ?? head?.github?.repository ?? base?.github?.repository ?? ""
  const [owner = "", name = ""] = String(repository).split("/")
  const jobs = Number.isInteger(head?.n_jobs) ? head.n_jobs : head === null ? null : 1
  const dependency = meta.dependency
  const diff = {
    schema_version: "execution-diff/v1",
    mode: "live-replay",
    label: meta.label === "constructed" ? "constructed" : "real",
    repo: {
      owner,
      name: name || String(repository),
      url: meta.repoUrl ?? (repository ? `https://github.com/${repository}` : "https://github.com"),
    },
    ...(meta.note !== undefined ? { note: meta.note } : {}),
    pull_request: {
      number: Number.isInteger(meta.prNumber) && meta.prNumber > 0 ? meta.prNumber : 1,
      url: meta.prUrl ?? "",
      title: meta.title ?? (dependency ? `Dependency replay: ${dependency}` : "Dependency replay"),
      ...(dependency ? { dependency: { name: dependency, from: meta.from ?? null, to: meta.to ?? null } } : {}),
    },
    base: { sha: baseSha, profile_id: baseProfileId, run_id: baseRunId },
    head: { sha: headSha, profile_id: headProfileId, run_id: headRunId },
    comparison: {
      available: comparisonAvailable,
      scope: comparisonAvailable ? meta.comparisonScope ?? "immediate-parent-to-head" : "unavailable",
    },
    execution_diff: {
      processes_added: processAdded,
      processes_removed: processRemoved,
      network_added: networkAdded,
      network_removed: networkRemoved,
      files_added: filesAdded,
      files_removed: filesRemoved,
      kinds_recorded: kinds,
      totals: {
        execution_chains: head?.egress?.length ?? null,
        destinations: head === null ? null : destinationIndex(head).size,
        jobs_recorded: jobs,
        jobs_changed: changed ? 1 : 0,
        jobs_unchanged: changed ? 0 : jobs,
        workload: { added: networkAdded.filter((entry) => entry.section === "workload").length, removed: networkRemoved.filter((entry) => entry.section === "workload").length },
        runner_background: { added: networkAdded.filter((entry) => entry.section === "runner background").length, removed: networkRemoved.filter((entry) => entry.section === "runner background").length },
      },
    },
    receipt_urls: {
      base: meta.baseReceiptUrl ?? null,
      head: meta.headReceiptUrl ?? null,
      ...(meta.headJsonUrl !== undefined ? { head_json: meta.headJsonUrl } : {}),
      ...(meta.prCommentUrl !== undefined ? { pr_comment: meta.prCommentUrl } : {}),
    },
    recorded: {
      at: meta.recordedAt ?? head?.timestamp ?? null,
      contract: meta.contract ?? "6.9.8",
      source: "live-replay-profile",
    },
  }
  return diff
}
