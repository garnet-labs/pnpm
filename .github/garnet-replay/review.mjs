#!/usr/bin/env node
/**
 * Execution Profiles — no-App fallback PR comment renderer.
 *
 * Renders the fallback Execution Profiles comment for repos WITHOUT the
 * Garnet GitHub App installed. The authoritative narrative comment is posted by
 * the control-plane App (see garnet-org/control-plane githubapp/comment.go); this
 * renderer produces the same title and the same evidence framing from the
 * `garnet_run_profile_comment` artifact captured by the Jibril eBPF sensor while
 * the PR's CI actually ran. The artifact it describes is an **Execution Profile**.
 *
 * Evidence framing (identical on every surface — PR comment, Actions step
 * summary): the comment is a deterministic snapshot of what the run did. It
 * renders NO verdicts, statuses, icons, or check markers of any kind — only
 * facts, answering "what happened in this PR?". Which evidence classes appear
 * is driven by FACT_CATEGORIES (launch scope: lineage + egress).
 *
 * Structure is locked by the vendored v6.9.8 vocabulary: a linked headline,
 * a two-line meta block (finding, then one quiet provenance line), one
 * top-level row per job with one block holding every
 * recorded root (independent roots whitespace-separated — there is no
 * workload/background partition), shaped observation terminals
 * ('○ <destination>' for network), bracket factual context, and the
 * grammar explainer. Chain counts never render on the human surface.
 * One meaning per style: <strong> marks the process that acted (an observed
 * action directly beneath it), <em> wraps annotations only ((…) bracket
 * context); every other tree character is plain.
 *
 * Rendering target is GitHub-flavored markdown: no color, no images, no SVG,
 * no icons — the evidence lives in words only.
 *
 * The script is dependency-free (Node 18+ globals only) so it can be dropped into
 * any repo or lifted into a standalone GitHub App later.
 */

import { readFile, appendFile } from "node:fs/promises"
import { resolve } from "node:path"
import { argv } from "node:process"
import { fileURLToPath } from "node:url"

export const COMMENT_MARKER = "<!-- garnet-runtime-review -->"

/**
 * Markers emitted by the control-plane GitHub App comment (the AUTHORITATIVE
 * Execution Profiles comment). When the App has commented — either the pending
 * placeholder or the final review — this fallback defers and does NOT post, so
 * repos WITH the App installed never see duplicate comments. Mirrors the
 * Action-side suppression (garnet-org/action, pr-comment-plan.js).
 */
export const CONTROL_PLANE_MARKERS = [
  "garnet-control-plane-pr-comment:v1",
  "garnet-control-plane-pending-pr-comment:v1",
]

/**
 * Evidence categories the review surfaces. Launch scope is lineage + egress;
 * files and assertions stay in the raw profile data and can be enabled here
 * without renderer changes (mirrors control-plane githubapp/comment.go).
 */
export const FACT_CATEGORIES = {
  egress: true,
  lineage: true,
  files: false,
  assertions: false,
}

/** @returns {Record<string, any>} */
function readConfig() {
  return {
    profilePath: process.env.PROFILE_JSON_PATH || "/var/log/jibril.profile.json",
    diffPath: process.env.DIFF_PATH || "",
    githubToken: process.env.GITHUB_TOKEN || "",
    githubApiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    githubServerUrl: process.env.GITHUB_SERVER_URL || "https://github.com",
    repository: process.env.GITHUB_REPOSITORY || "",
    prNumber: process.env.PR_NUMBER || "",
    headSha: process.env.HEAD_SHA || process.env.GITHUB_SHA || "",
    runId: process.env.GITHUB_RUN_ID || "",
    publicReportUrl: process.env.PUBLIC_REPORT_URL || "https://app.garnet.ai",
    // The tokenless, public, works-logged-out permalink for the run profile page.
    permalinkUrl: process.env.PERMALINK_URL || process.env.REPORT_URL || "",
    failOnError: (process.env.FAIL_ON_ERROR || "true") !== "false",
  }
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function readFileSafe(path) {
  if (!path) return ""
  try {
    return await readFile(path, "utf8")
  } catch (_) {
    return ""
  }
}

/**
 * Escape a value destined for INSIDE a `code span`: a stray backtick would break
 * out of the span, so neutralize it (and collapse newlines).
 * @param {unknown} value
 */
const escapeCode = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "ʼ")
    .replace(/[\r\n]+/g, " ")
    .trim()

const escapeCodeSpan = (value) =>
  String(value ?? "")
    .replace(/`/g, "ʼ")
    .replace(/[\r\n]+/g, " ")
    .trim()

/**
 * Clean free-text (rendered OUTSIDE code spans, e.g. an assertion description):
 * keep intentional inline-code backticks, just collapse newlines/pipes so the
 * single-line comment layout holds.
 * @param {unknown} value
 */
const cleanText = (value) =>
  String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|")
    .trim()

/**
 * Markdown-link-safe URL: only http(s) targets are allowed (a hostile env
 * var can't smuggle `javascript:`/`data:` schemes into the CTA), and the
 * characters that could terminate or restructure the `[label](url)` form
 * are percent-encoded.
 * @param {unknown} value
 * @returns {string} the safe URL, or "" when the value is not http(s)
 */
export function safeLinkUrl(value) {
  const raw = String(value ?? "").trim()
  if (!/^https?:\/\//i.test(raw)) return ""
  return raw.replace(/[()<>\\ \u0000-\u001f\u007f]/g, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")
    return `%${hex}`
  })
}

/**
 * Collapse the raw Jibril profile into a compact execution record: the job name,
 * assertions, and per-peer egress with the acting process (lineage tail).
 * @param {unknown} profile
 */
export function summarizeProfile(profile) {
  if (!profile || typeof profile !== "object") return null
  const p = /** @type {Record<string, any>} */ (profile)
  const github = p?.scenarios?.github || p?.github || {}

  const assertions = Array.isArray(p?.assertions)
    ? p.assertions.map((a) => ({
        id: a?.assertion_id || a?.id || a?.result_id || a?.name || a?.rule || a?.kind || "",
        result: a?.result,
        category: a?.class_id || a?.category || a?.class || "",
        description: a?.description || "",
      }))
    : []

  const egressPeers = Array.isArray(p?.network?.egress?.peers)
    ? p.network.egress.peers
    : []
  const egress = egressPeers.flatMap((peer) => {
    const trees = peer?.proc_trees || peer?.ProcTrees || []
    const recordedTrees = trees.length ? trees : [null]
    const names = (peer?.remote_names || peer?.RemoteNames || []).filter(Boolean)
    const name = names[0] || peer?.remote_address || ""
    return recordedTrees.map((tree) => {
      const ancestry = ((tree?.ancestry || tree?.Ancestry || []) || []).filter(Boolean)
      const detections = (peer?.detections || peer?.Detections || [])
        .map((d) => (typeof d === "string" ? d : d?.name || d?.type || d?.id || d?.kind || ""))
        .filter(Boolean)
      return {
        name,
        address: peer?.remote_address || "",
        ports: (peer?.remote_ports || peer?.RemotePorts || []).map(String),
        pid: tree?.pid ?? tree?.Pid ?? peer?.pid ?? peer?.Pid ?? null,
        ancestry,
        result: String(peer?.result ?? peer?.Result ?? "").toLowerCase(),
        detections,
        step: tree?.github_step || tree?.GithubStep || peer?.github_step || peer?.GithubStep || "",
      }
    })
  })

  return {
    timestamp: p?.timestamp,
    github: {
      workflow: github.workflow || "",
      job: github.job || "",
      sha: github.sha || "",
      run_id: github.run_id || "",
      actor: github.actor || "",
      repository: github.repository || p?.repository || "",
    },
    profile_id: p?.Profile?.ID || p?.profile_id || p?.profileId || "",
    assertions,
    egress,
  }
}

/**
 * Derive the Execution Profile object from a single job's execution record.
 * Deterministic and record-driven: every recorded destination association is
 * carried through — no registry allowlist, salience ranking, or quieting layer
 * decides what renders (contract `comment.foldOpenRuling`,
 * `losslessProjection`).
 *
 * @param {ReturnType<typeof summarizeProfile>} rec
 * @param {ReturnType<typeof readConfig>} cfg
 */
export function buildRunProfile(rec, cfg) {
  const job = rec?.github?.job || "ci"
  const sha = String(rec?.github?.sha || cfg.headSha || "").slice(0, 7) || "unknown"
  const runId = rec?.github?.run_id || cfg.runId || ""
  const profileId = rec?.profile_id || ""
  const publicBase = String(cfg.publicReportUrl || "https://app.garnet.ai").replace(/\/$/, "")
  const permalinkCandidate =
    cfg.permalinkUrl ||
    (runId && profileId
      ? `${publicBase}/public/runs/${encodeURIComponent(runId)}?profile=${encodeURIComponent(profileId)}&utm_source=github&utm_medium=pr_comment`
      : "")
  const permalink = safeLinkUrl(
    permalinkCandidate &&
      (permalinkCandidate.includes("utm_source=")
        ? permalinkCandidate
        : `${permalinkCandidate}${permalinkCandidate.includes("?") ? "&" : "?"}utm_source=github&utm_medium=pr_comment`),
  )

  const egress = Array.isArray(rec?.egress) ? rec.egress : []

  return {
    sha,
    full_sha: String(rec?.github?.sha || cfg.headSha || ""),
    n_jobs: 1,
    commit_url: (rec?.github?.repository || cfg.repository) && String(rec?.github?.sha || cfg.headSha || "")
      ? `${cfg.githubServerUrl}/${rec?.github?.repository || cfg.repository}/commit/${String(rec.github.sha || cfg.headSha)}`
      : "",
    permalink,
    job,
    workflow: rec?.github?.workflow || "workflow",
    repository: rec?.github?.repository || cfg.repository || "",
    githubServerUrl: cfg.githubServerUrl,
    run_id: runId,
    profile_id: profileId,
    timestamp: rec?.timestamp,
    egress,
  }
}

function defang(value) {
  const text = escapeCode(value)
  if (!text.includes(".") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    return text
  }
  const index = text.lastIndexOf(".")
  return `${text.slice(0, index)}[.]${text.slice(index + 1)}`
}

function displayProcess(value) {
  return cleanText(value).replace(/\d{4,}$/, "").trim()
}

function numericPort(value) {
  const match = /^\s*(\d+)/.exec(String(value ?? ""))
  return match ? Number(match[1]) : null
}

function isLoopback(value) {
  return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/.test(
    String(value ?? ""),
  )
}

/**
 * The standardized cloud IMDS constant (contract notes.instanceMetadata):
 * a per-record protocol fact like the dns-resolver note. Vendor-specific
 * addresses render bare — no vendor address enums or labels.
 */
const INSTANCE_METADATA_ADDRESS = "169.254.169.254"

/**
 * Contract-locked bracket-context suffix lists (vocab notes.githubInfrastructure /
 * notes.garnetSensor) — vendored byte-identically, never extended in a renderer.
 */
const GITHUB_INFRASTRUCTURE_SUFFIXES = [
  ".githubapp.com",
  ".actions.githubusercontent.com",
]
const GITHUB_INFRASTRUCTURE_TRUNCATED_SUFFIXES = [".githubapp"]
const GARNET_SENSOR_SUFFIXES = [".garnet.ai"]

/**
 * A recorded name is GitHub infrastructure when it ends with a locked domain
 * suffix, or with a truncated suffix carrying exactly one label before it —
 * a truncated direct child of githubapp.com. Recorded names are
 * workload-influenceable, so a deeper name under the non-public truncated
 * suffix never earns the trust cue.
 */
export function isGithubInfrastructureName(name) {
  return (
    GITHUB_INFRASTRUCTURE_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    GITHUB_INFRASTRUCTURE_TRUNCATED_SUFFIXES.some(
      (suffix) =>
        name.endsWith(suffix) &&
        name.length > suffix.length &&
        !name.slice(0, -suffix.length).includes("."),
    )
  )
}

function bracketContext(association) {
  const dns =
    isLoopback(association.address) &&
    association.ports.some((port) => numericPort(port) === 53)
  if (dns) return "dns resolver"
  if (
    association.address === INSTANCE_METADATA_ADDRESS ||
    association.name === INSTANCE_METADATA_ADDRESS
  ) {
    return "cloud metadata"
  }
  const name = String(association.name ?? "").toLowerCase()
  if (isGithubInfrastructureName(name)) {
    return "github infra"
  }
  if (name === "garnet.ai" || GARNET_SENSOR_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return "garnet sensor"
  }
  return ""
}

/**
 * Observed network action leaf (vocab copy.terminalNetwork): a shaped
 * terminal '○ <destination>' with factual '(…)' context — italic, like
 * every annotation. '□' (file) and '▷' (execution) are reserved and never
 * render until those observation classes surface.
 */
function associationDestination(association) {
  const destination = defang(association.name || association.address)
  const context = bracketContext(association)
  return `○ ${destination}${context ? ` <em>(${context})</em>` : ""}`
}

function htmlAttributeUrl(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

/**
 * The step annotation renders only the part of a recorded step name that
 * reliably means something to a reader: the step's own text, quoted. The
 * runner's leading 'NN. ' ordinal is presentation noise and strips; an
 * unexpanded workflow expression (`${{ matrix.job_name }}`) is template
 * syntax rather than a name — when one survives, the annotation drops
 * entirely. The record keeps the raw name either way; the annotation is
 * decoration, so dropping it changes no structure, count, or comparison.
 */
function displayStep(value) {
  const stripped = cleanText(value)
    .replace(/^\d+\.\s+/, "")
    .replace(/\s*\(\s*\$\{\{[^}]*\}\}\s*\)/g, "")
    .replace(/\$\{\{[^}]*\}\}/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\//gi, "")
    .trim()
  return /\$\{\{/.test(stripped) ? "" : stripped
}

function formatTimestamp(value) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
}

/**
 * Human-line timestamp at minute precision (contract v6.9.8
 * `comment.metaWeight`); the marker keeps the record's full-precision stamp.
 */
function minuteStamp(stamp) {
  return stamp.replace(/(\d{2}:\d{2}):\d{2}/, "$1")
}

/**
 * One job = one block: the trie merges every recorded root's chains, and
 * independent recorded ancestry roots render in the same block separated by
 * one blank line (contract v6.9 `jobBlockRuling`) — whitespace means
 * independent recorded roots, never a category. A real recorded workflow
 * step renders once per path as `(step: "<name>")` on the shallowest
 * process line where that recorded step applies — descendants with the
 * same recorded step inherit it silently and a descendant whose recorded
 * step differs renders its own (contract `attribution.githubStep`) —
 * factual context only, italic like every annotation; the tree's
 * structure, counts, and ordering are identical with or without step
 * metadata. Bold marks the process that acted — a node with an observed
 * action directly beneath it; every other tree character is plain.
 */
function isWorkloadRoot(node) {
  if (node.name === "Runner.Worker") return true
  if (node.steps.size > 0) return true
  return [...node.children.values()].some(isWorkloadRoot)
}

function renderTree(associations) {
  const root = { children: new Map(), destinations: [], steps: new Set() }
  const sorted = [...associations].sort((a, b) => {
    const lineage = a.ancestry.join("\u0000").localeCompare(b.ancestry.join("\u0000"))
    if (lineage) return lineage
    const address = String(a.address || a.name).localeCompare(String(b.address || b.name))
    if (address) return address
    return Number(a.pid ?? Number.MAX_SAFE_INTEGER) - Number(b.pid ?? Number.MAX_SAFE_INTEGER)
  })

  for (const association of sorted) {
    const ancestry = association.ancestry.length
      ? association.ancestry.map(displayProcess)
      : ["unknown (not recorded)"]
    const step = displayStep(association.step)
    const realStep = step && isRealRecordedStep(step) ? step : ""
    let node = root
    ancestry.forEach((name) => {
      if (!node.children.has(name)) {
        node.children.set(name, { name, children: new Map(), destinations: [], steps: new Set() })
      }
      node = node.children.get(name)
    })
    if (realStep) node.steps.add(realStep)
    node.destinations.push(association)
  }

  const lines = []
  function append(node, prefix, isLast, suppressGlyph = false, topLevel = false, inheritedSteps = new Set()) {
    // Silent inheritance: a step annotation renders once per path, on the
    // shallowest process line where that recorded step applies.
    const ownSteps = [...node.steps].filter((step) => !inheritedSteps.has(step)).sort((a, b) => a.localeCompare(b))
    if (node.name) {
      // Bold marks the process that acted: an observed action sits directly
      // beneath it. Decoration only; the terminal itself carries the fact.
      const name = node.destinations.length > 0
        ? `<strong>${escapeCode(node.name)}</strong>`
        : escapeCode(node.name)
      const stepNote = ownSteps
        .map((step) => ` <em>(step: &quot;${escapeCode(step)}&quot;)</em>`)
        .join("")
      lines.push(`${prefix}${suppressGlyph ? "" : isLast ? "└─ " : "├─ "}${name}${stepNote}`)
    }
    const childPrefix = node.name
      ? topLevel
        ? prefix
        : suppressGlyph
          ? `${prefix}   `
          : `${prefix}${isLast ? "   " : "│  "}`
      : prefix
    const entries = [
      ...[...node.children.values()].map((child) => ({ kind: "child", value: child })),
      ...node.destinations.map((association) => ({ kind: "destination", value: association })),
    ]
    entries.sort((a, b) => {
      // Root order (contract v6.9.8 `comment.rootOrdering`): workload roots
      // render before infrastructure-rooted ones so the signal is never
      // buried below runner plumbing. Structural facts only — destination
      // and process names never classify. Canonical order holds within
      // each group, and at every deeper level.
      if (!node.name && a.kind === "child" && b.kind === "child") {
        const rank = isWorkloadRoot(a.value) === isWorkloadRoot(b.value) ? 0 : isWorkloadRoot(a.value) ? -1 : 1
        if (rank) return rank
      }
      const left = a.kind === "child" ? a.value.name : String(a.value.address || a.value.name)
      const right = b.kind === "child" ? b.value.name : String(b.value.address || b.value.name)
      return left.localeCompare(right)
    })
    entries.forEach((entry, index) => {
      const last = index === entries.length - 1
      if (entry.kind === "child") {
        // Blank line between independent recorded roots in the same block.
        if (!node.name && lines.length) lines.push("")
        append(
          entry.value,
          childPrefix,
          node.name ? last : true,
          !node.name,
          !node.name,
          node.steps.size ? new Set([...inheritedSteps, ...node.steps]) : inheritedSteps,
        )
      } else {
        const association = entry.value
        lines.push(
          `${childPrefix}${node.name ? (last ? "└─ " : "├─ ") : ""}${associationDestination(association)}`,
        )
      }
    })
  }

  append(root, "", true)
  return lines
}

function renderJobUrl(rp) {
  if (!rp.run_id) return ""
  return safeLinkUrl(`${rp.githubServerUrl || "https://github.com"}/${rp.repository || ""}/actions/runs/${rp.run_id}`)
}

/** Vendored v6.9.8 contract copy (fixtures/runtime-review-vocab.v6.9.8.json). */
export const CONTRACT_VERSION = "6.9.8"
export const EMPTY_ROW_PROFILE_LABEL = "Garnet profile&nbsp;↗"

/**
 * The sensor's synthetic step sentinel (`NN. Runner Processes`) is not
 * attribution — only a real recorded workflow step is.
 * @param {string} step
 */
export function isRealRecordedStep(step) {
  const text = String(step ?? "").trim().replace(/^\d+\.\s+/, "")
  return text.length > 0 && !/^Runner Processes$/i.test(text)
}

function countPhrase(n, noun) {
  return `${n}&nbsp;${noun}${n === 1 ? "" : "s"}`
}

/**
 * Machine summary marker (contract v6.9.8 `comment.machineSummary`): fixed key
 * order — contract, githubMeta, commit, previous, jobs, changed, unchanged,
 * noOutbound, vanished, added, removed, vanishedDestinations, chains,
 * destinations, recorded, kinds. `chains` is the machine-register aggregate
 * (never rendered on the human surface); `recorded` is the record's
 * full-precision timestamp, rendered at minute precision on the human
 * surface; `kinds` lists the observation classes present (today ["network"]);
 * comparison-only fields are null on this snapshot-only fallback surface.
 * `githubMeta` stamps the vendored published GitHub ranges consumed by the
 * rotation join — a comparison-only join this fallback never performs and
 * whose ranges it therefore does not vendor, so the stamp is null here.
 * `--` inside JSON strings is escaped so a record-sourced value can never
 * terminate the HTML comment; JSON.parse restores the bytes.
 */
export function machineSummaryMarker(rp, { chains, destinations }) {
  const recorded = formatTimestamp(rp.timestamp)
  const summary = {
    contract: CONTRACT_VERSION,
    githubMeta: null,
    commit: String(rp.full_sha || rp.sha || ""),
    previous: null,
    jobs: rp.n_jobs ?? 1,
    changed: null,
    unchanged: null,
    noOutbound: null,
    vanished: null,
    added: null,
    removed: null,
    vanishedDestinations: null,
    chains,
    destinations,
    recorded: recorded || null,
    kinds: ["network"],
  }
  const json = JSON.stringify(summary).replace(/--/g, "-\\u002d")
  return `<!-- garnet:summary ${json} -->`
}

/**
 * The locked v6.9.8 explainer (contract `comment.explainerPlacement`): one
 * <pre> mini tree with ← arrow callouts aligned in one italic column at
 * visible offset 23, followed by the reading sentence and the legend line
 * (snapshot surface — the comparison marks line renders on comparison
 * comments only, which this fallback never emits).
 * @param {{open?: boolean}} [options]
 */
export function explainerLines({ open = false } = {}) {
  return [
    `<details${open ? " open" : ""}><summary><sub>💡 How to read this</sub></summary>`,
    "",
    "<pre>",
    "Runner.Worker          <em>← process on a path</em>",
    "└─ npm",
    "   └─ <strong>node</strong>             <em>← process that acted</em>",
    "      └─ ○ npmjs[.]org <em>← observed action</em>",
    "</pre>",
    "",
    "<sub><i>follow a path downward to see what ran and what it did — each path to an observed action is an execution chain</i></sub>",
    "",
    "<sub><i>names on the path = processes · ○ = observed action · (…) = context</i></sub>",
    "",
    "</details>",
  ]
}

export function renderRunProfile(rp) {
  // One job = one block (contract v6.9): every recorded chain renders in the
  // job's single fold — there is no workload/background partition. The
  // destination count totals the distinct rendered ○ leaves exactly.
  const associations = Array.isArray(rp.egress) ? rp.egress : []
  const destinationSet = new Set(associations.map((e) => e.name || e.address).filter(Boolean))
  const chainCount = associations.length
  const headlineUrl = safeLinkUrl(rp.commit_url)
  const shaLink = headlineUrl ? `[\`${escapeCodeSpan(rp.sha)}\`](${headlineUrl})` : `\`${escapeCodeSpan(rp.sha)}\``
  const lines = [COMMENT_MARKER, `<!-- garnet-run-profile -->`]
  if (rp.full_sha) lines.push(`<!-- garnet:commit ${escapeCode(rp.full_sha)} -->`)
  lines.push(
    machineSummaryMarker(rp, {
      chains: chainCount,
      destinations: destinationSet.size,
    }),
  )
  lines.push(`**Execution Profiles recorded for ${rp.n_jobs} job${rp.n_jobs === 1 ? "" : "s"}, triggered by ${shaLink}**`, "")
  const timestamp = formatTimestamp(rp.timestamp)
  // Meta block (v6.9.8 `comment.metaWeight`): finding first, then one quiet
  // provenance line. The snapshot finding is the destination total, which
  // sums the job folds' trees exactly; provenance carries the record's
  // timestamp at minute precision (full precision lives in the marker).
  // Chain counts never render on the human surface.
  const provenance = [
    "recorded at the kernel by Garnet",
    ...(timestamp ? [minuteStamp(timestamp)] : []),
  ]
  lines.push(
    `> *${countPhrase(destinationSet.size, "destination")}*`,
    `> <sub>${provenance.join(" · ")}</sub>`,
    "",
  )
  const rowUrl = renderJobUrl(rp)
  const jobLink = rowUrl
    ? `<a href="${htmlAttributeUrl(rowUrl)}"><code>${escapeCode(rp.job)}</code>&nbsp;↗</a>`
    : `<code>${escapeCode(rp.job)}</code>`
  if (associations.length === 0) {
    // Empty projection: a plain <sub> row that keeps the job's Execution
    // Profile link — an empty egress projection never implies Garnet
    // observed nothing.
    const profileLink = rp.permalink
      ? ` · <a href="${htmlAttributeUrl(rp.permalink)}">${EMPTY_ROW_PROFILE_LABEL}</a>`
      : ""
    lines.push(`<sub><code>${escapeCode(rp.workflow)}</code> / ${jobLink} — no outbound destinations recorded.${profileLink}</sub>`, "")
  } else {
    // Fold row: identity plus the one destination fact — no step-name
    // sentence (step attributions render in the tree itself).
    lines.push(`<details><summary><code>${escapeCode(rp.workflow)}</code> / ${jobLink} · ${countPhrase(destinationSet.size, "destination")}</summary>`, "")
    lines.push("<pre>", ...renderTree(associations), "</pre>", "")
    if (rp.permalink) {
      lines.push(`<p align="right"><sub><a href="${htmlAttributeUrl(rp.permalink)}">View this job's Execution Profile in Garnet →</a></sub></p>`, "")
    }
    lines.push("</details>", "")
  }
  lines.push("---", "", ...explainerLines())
  return lines.join("\n")
}

/**
 * Single comment per PR, re-posted at the BOTTOM on every run so the latest
 * profile always shows chronologically: delete any prior comment carrying the
 * marker (paginated), then create a fresh one. Deletion failures are non-fatal.
 *
 * @param {ReturnType<typeof readConfig>} cfg
 * @param {string} body
 */
async function repostPrComment(cfg, body) {
  if (!cfg.githubToken || !cfg.repository || !cfg.prNumber) {
    console.warn("Skipping PR comment: missing GITHUB_TOKEN, GITHUB_REPOSITORY, or PR_NUMBER.")
    return
  }
  const base = `${cfg.githubApiUrl}/repos/${cfg.repository}/issues/${cfg.prNumber}/comments`
  const headers = {
    authorization: `Bearer ${cfg.githubToken}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  }

  const staleIds = []
  let appCommented = false
  for (let page = 1; page <= 10; page += 1) {
    const listRes = await fetch(`${base}?per_page=100&page=${page}`, { headers })
    if (!listRes.ok) {
      console.warn(`Could not list PR comments (${listRes.status}); will create a new one.`)
      break
    }
    const comments = await listRes.json()
    if (!Array.isArray(comments) || comments.length === 0) break
    for (const c of comments) {
      if (typeof c?.body !== "string") continue
      if (c.body.includes(COMMENT_MARKER)) staleIds.push(c.id)
      if (CONTROL_PLANE_MARKERS.some(marker => c.body.includes(marker))) appCommented = true
    }
    if (comments.length < 100) break
  }

  // The control-plane App comment is authoritative. When it is present, remove
  // any fallback comment we posted earlier and defer — never post a duplicate.
  for (const id of staleIds) {
    const delRes = await fetch(`${cfg.githubApiUrl}/repos/${cfg.repository}/issues/comments/${id}`, {
      method: "DELETE",
      headers,
    })
    if (delRes.ok || delRes.status === 404) {
      console.log(`Removed previous Execution Profiles comment (#${id}).`)
    } else {
      console.warn(`Could not delete previous comment #${id} (${delRes.status}).`)
    }
  }

  if (appCommented) {
    console.log("Control-plane App comment present; deferring (no fallback comment posted).")
    return
  }

  const postRes = await fetch(base, { method: "POST", headers, body: JSON.stringify({ body }) })
  if (!postRes.ok) {
    throw new Error(`Failed to create PR comment (${postRes.status}): ${await postRes.text()}`)
  }
  console.log("Posted Execution Profiles comment.")
}

/** @param {string} body */
async function writeStepSummary(body) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) return
  try {
    await appendFile(file, `${body}\n`)
  } catch (err) {
    console.warn(`Could not write step summary: ${err.message}`)
  }
}

async function main() {
  const cfg = readConfig()

  const profileRaw = await readFileSafe(cfg.profilePath)
  let rec = null
  if (profileRaw.trim()) {
    try {
      rec = summarizeProfile(JSON.parse(profileRaw))
    } catch (err) {
      console.warn(`Could not parse profile JSON at ${cfg.profilePath}: ${err.message}`)
    }
  } else {
    console.warn(`No execution record found at ${cfg.profilePath}.`)
  }

  if (!rec) {
    const sha = (cfg.headSha || "unknown").slice(0, 7)
    const body = [
      COMMENT_MARKER,
      "<!-- garnet-run-profile -->",
      ...(cfg.headSha ? [`<!-- garnet:commit ${cfg.headSha} -->`] : []),
      `**Execution Profiles recording for jobs triggered by ${cfg.repository && cfg.headSha ? `[\`${sha}\`](${cfg.githubServerUrl}/${cfg.repository}/commit/${cfg.headSha})` : `\`${sha}\``}**`,
      "",
      "⏳ Execution Profiles for this commit are still being recorded — this comment updates in place as jobs finish.",
      "",
      "---",
      "",
      ...explainerLines({ open: true }),
    ].join("\n")
    await repostPrComment(cfg, body)
    await writeStepSummary(body)
    return
  }

  const rp = buildRunProfile(rec, cfg)
  const body = renderRunProfile(rp)
  await repostPrComment(cfg, body)
  await writeStepSummary(body)
  console.log(`Execution Profiles complete (${rp.egress.length} execution chain(s) surfaced).`)
}

const isDirectRun = argv[1] && fileURLToPath(import.meta.url) === resolve(argv[1])

if (isDirectRun) {
  main().catch((err) => {
    const cfg = readConfig()
    console.error(`Execution Profiles failed: ${err.message}`)
    if (cfg.failOnError) {
      process.exitCode = 1
    }
  })
}
