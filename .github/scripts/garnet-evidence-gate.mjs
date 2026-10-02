import { pathToFileURL } from "node:url";

/**
 * Publishes the `garnet/evidence` check run on the pull request head.
 *
 * A workflow_run job's own check run is attached to the default-branch commit
 * GitHub ran it from, never to the pull request head, so a job named
 * `garnet/evidence` can neither be a required check on the pull request nor be
 * seen by the re-review step. This script creates the check run itself, bound
 * to HEAD_SHA, with the same fail-closed reading of the record as REVIEW.md:
 *   success   a finalized record from the Garnet App is bound to the exact head
 *   pending   a record for the head exists but is still being written
 *   failure   no record from the Garnet App is bound to the head
 * Missing, stale or third-party evidence is failure. Nothing here judges the
 * pull request.
 * Required environment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA.
 * Optional: GARNET_RECORD_WORKFLOWS (JSON array of recorder workflow names; while
 * any of them is still running on the head the check stays in progress).
 * Optional environment: GITHUB_API_URL, GITHUB_SERVER_URL, GITHUB_RUN_ID,
 * GARNET_GATE_MODE (check-run, the default, or comment: no checks:write, the
 * reading goes to a workflow annotation and one per-head pull request comment).
 */
const RUNTIME_REVIEW_MARKER = "<!-- garnet-runtime-review -->"
const PENDING_MARKER = "garnet-control-plane-pending-pr-comment"
const COMMIT_RE = /<!--\s*garnet:commit\s+([0-9a-f]{40})\s*-->/
const SUMMARY_RE = /<!-- garnet:summary (\{.*?\}) -->/
const TRUSTED_AUTHORS = new Set([
  "garnet-runtime-review[bot]",
  "garnet-runtime-review-dev[bot]",
  "garnet-ai[bot]",
])
export const EVIDENCE_CHECK = "garnet/evidence"

const api = process.env.GITHUB_API_URL || "https://api.github.com"
const repo = process.env.GITHUB_REPOSITORY
const prNumber = process.env.PR_NUMBER
const headSha = process.env.HEAD_SHA

async function github(path, init = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

async function listComments() {
  const all = []
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(`/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`)
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all
}

/**
 * How the Garnet App's comments read for one head.
 * @param {{user?: {login?: string}, body?: string}[]} comments
 * @param {string} head 40-hex head sha
 * @param {{state?: "ready"|"pending"|"unknown", pending?: string[]}} [listeners]
 * @returns {{state: "success"|"pending"|"failure", summary: string, recorded: string|null, jobs: number|null, capture: string|null}}
 */
export function evidenceStateFor(comments, head, listeners = { state: "ready", pending: [] }) {
  const sha7 = head.slice(0, 7)
  const bound = (Array.isArray(comments) ? comments : []).filter((comment) => {
    if (!TRUSTED_AUTHORS.has(comment?.user?.login)) return false
    if (typeof comment?.body !== "string" || !comment.body.includes(RUNTIME_REVIEW_MARKER)) return false
    const commit = COMMIT_RE.exec(comment.body)
    return commit !== null && commit[1] === head
  })
  if (bound.length === 0) {
    return { state: "failure", summary: `No Runtime Review comment from the Garnet App is bound to head ${sha7}. Missing evidence is no record, not a clean run.`, recorded: null, jobs: null, capture: null }
  }
  let incompleteCapture = null
  for (const comment of bound) {
    if (comment.body.includes(PENDING_MARKER)) continue
    const summary = SUMMARY_RE.exec(comment.body)
    if (summary === null) continue
    let parsed = null
    try {
      parsed = JSON.parse(summary[1])
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== "object") continue
    if (parsed.status !== undefined && parsed.status !== "finalized") continue
    const recorded = typeof parsed.recorded === "string" ? parsed.recorded : null
    const jobs = typeof parsed.jobs === "number" ? parsed.jobs : null
    const captureDeclared = Object.prototype.hasOwnProperty.call(parsed, "capture_quality")
      || Object.prototype.hasOwnProperty.call(parsed, "capture")
    const captureValue = parsed.capture_quality ?? parsed.capture ?? null
    const capture = typeof captureValue === "string" ? captureValue : null
    if (captureDeclared && captureValue !== "complete") {
      if (incompleteCapture === null) incompleteCapture = { declared: true, value: captureValue }
      continue
    }
    if (!captureDeclared) {
      if (incompleteCapture === null) incompleteCapture = { declared: false, value: null }
      continue
    }
    if (listeners.state === "unknown") {
      return {
        state: "pending",
        summary: `The Runtime Review record for head ${sha7} is complete, but recorder listener state is unavailable. Pending evidence is no record.`,
        recorded: null,
        jobs: null,
        capture,
      }
    }
    if (listeners.state === "pending") {
      const pending = Array.isArray(listeners.pending) && listeners.pending.length > 0
        ? listeners.pending.join(", ")
        : "a recorder listener"
      return {
        state: "pending",
        summary: `The Runtime Review record for head ${sha7} is complete, but ${pending} is still running. Pending evidence is no record.`,
        recorded: null,
        jobs: null,
        capture,
      }
    }
    const facts = [jobs !== null ? `${jobs} job${jobs === 1 ? "" : "s"}` : null, recorded !== null ? `recorded ${recorded}` : null].filter((item) => item !== null).join(" · ")
    return { state: "success", summary: `A finalized Runtime Review record from the Garnet App is bound to head ${sha7}${facts === "" ? "" : ` (${facts})`}. The record is evidence, not a judgment.`, recorded, jobs, capture }
  }
  if (incompleteCapture !== null) {
    const summary = incompleteCapture.declared
      ? `The Runtime Review record for head ${sha7} does not declare complete capture (reported ${incompleteCapture.value}). Partial evidence is not success.`
      : `The Runtime Review record for head ${sha7} is finalized, but its contract does not declare capture completeness, so the evidence is undeterminable.`
    return {
      state: "failure",
      summary,
      recorded: null,
      jobs: null,
      capture: incompleteCapture.value,
    }
  }
  return { state: "pending", summary: `The Runtime Review record for head ${sha7} is still being written. Pending evidence is no record.`, recorded: null, jobs: null, capture: null }
}

/**
 * Recorder workflow runs on this head that are not finished yet. A finalized
 * record from one recorder says nothing about the others; while any listened
 * recorder is still running the reading stays pending.
 * @param {{name?: string, status?: string}[]} runs workflow runs for the head
 * @param {string[]} recorderNames workflow names the gate listens to
 * @returns {string[]} names of unfinished recorder runs
 */
export function unsettledRecorders(runs, recorderNames) {
  const names = Array.isArray(recorderNames) ? recorderNames : []
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => typeof run?.name === "string" && names.includes(run.name) && run.status !== "completed")
    .map((run) => run.name)
}

/**
 * The reading once recorder completeness is known: success only when every
 * listened recorder run on the head has finished.
 * @param {ReturnType<typeof evidenceStateFor>} reading
 * @param {string[]} unsettled from `unsettledRecorders`
 * @param {string} head
 * @returns {ReturnType<typeof evidenceStateFor>}
 */
export function withRecorderCompleteness(reading, unsettled, head) {
  if (reading.state !== "success" || unsettled.length === 0) return reading
  const sha7 = head.slice(0, 7)
  return { state: "pending", summary: `A record is bound to head ${sha7} but ${unsettled.length} recorder run${unsettled.length === 1 ? " is" : "s are"} still running (${[...new Set(unsettled)].join(", ")}). Capture is not complete until they finish.`, recorded: reading.recorded, jobs: reading.jobs }
}

/**
 * @param {string|undefined} raw GARNET_RECORD_WORKFLOWS, a JSON array of workflow names
 * @returns {string[]}
 */
export function parseRecorderNames(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return []
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) throw new Error("GARNET_RECORD_WORKFLOWS must be a JSON array of workflow names")
  return parsed
}

const TITLES = { success: "Head-bound Runtime Review record", pending: "Record still being written", failure: "No head-bound Runtime Review record" }

/**
 * @param {string|undefined} raw GARNET_GATE_MODE
 * @returns {"check-run"|"comment"}
 */
export function parseGateMode(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "check-run"
  const mode = raw.trim()
  if (mode !== "check-run" && mode !== "comment") throw new Error("GARNET_GATE_MODE must be check-run or comment")
  return mode
}

/**
 * The per-head gate comment marker. A new head gets a new comment.
 * @param {string} head 40-hex head sha
 * @returns {string}
 */
export function gateCommentMarker(head) {
  return `<!-- garnet:evidence-gate ${head} -->`
}

/**
 * The pull request comment body publishing one reading in comment mode.
 * @param {{state: "success"|"pending"|"failure", summary: string}} reading
 * @param {string} head
 * @param {string|null} detailsUrl workflow run link, when known
 * @returns {string}
 */
export function gateCommentBody(reading, head, detailsUrl) {
  return [
    gateCommentMarker(head),
    `**${EVIDENCE_CHECK}: ${reading.state}** — ${TITLES[reading.state]}`,
    reading.summary,
    ...(detailsUrl !== null ? [`[workflow run](${detailsUrl})`] : []),
  ].join("\n")
}

/**
 * The gate comment already posted for this head, if any.
 * @param {{id?: number, body?: string}[]} comments
 * @param {string} head
 * @returns {{id?: number, body?: string}|null}
 */
export function existingGateComment(comments, head) {
  const marker = gateCommentMarker(head)
  return (Array.isArray(comments) ? comments : []).find((comment) => typeof comment?.body === "string" && comment.body.includes(marker)) ?? null
}

/**
 * The check-run body to publish for one reading.
 * @param {{state: "success"|"pending"|"failure", summary: string}} reading
 * @param {string} head
 * @param {string|null} detailsUrl
 * @returns {Record<string, unknown>}
 */
export function checkRunPayload(reading, head, detailsUrl) {
  return {
    name: EVIDENCE_CHECK,
    head_sha: head,
    ...(detailsUrl !== null ? { details_url: detailsUrl } : {}),
    ...(reading.state === "pending" ? { status: "in_progress" } : { status: "completed", conclusion: reading.state }),
    output: { title: TITLES[reading.state], summary: reading.summary },
  }
}

/**
 * Whether the newest existing `garnet/evidence` check run already says this.
 * @param {{name?: string, id?: number, status?: string, conclusion?: string|null, output?: {summary?: string}}[]} checkRuns
 * @param {Record<string, unknown>} payload
 * @returns {boolean}
 */
export function alreadyPublished(checkRuns, payload) {
  const runs = (Array.isArray(checkRuns) ? checkRuns : []).filter((run) => run?.name === EVIDENCE_CHECK)
  if (runs.length === 0) return false
  const latest = runs.reduce((best, run) => (typeof run.id === "number" && (best === null || run.id > best.id) ? run : best), null)
  if (latest === null) return false
  const conclusion = payload.status === "completed" ? payload.conclusion : null
  return latest.status === payload.status && (latest.conclusion ?? null) === conclusion && latest.output?.summary === payload.output.summary
}

async function main() {
  if (!process.env.GITHUB_TOKEN || !repo || !prNumber || !headSha) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER and HEAD_SHA are required")
  }
  const pr = await github(`/repos/${repo}/pulls/${prNumber}`)
  if (pr.state !== "open") {
    console.log(`PR #${prNumber} is ${pr.state}; nothing to gate.`)
    return
  }
  if (pr.head?.sha !== headSha) {
    console.log(`PR head moved (${pr.head?.sha?.slice(0, 7)} != ${headSha.slice(0, 7)}); not publishing a check for a stale head.`)
    return
  }
  const mode = parseGateMode(process.env.GARNET_GATE_MODE)
  const recorders = parseRecorderNames(process.env.GARNET_RECORD_WORKFLOWS)
  const runsPage = recorders.length === 0 ? null : await github(`/repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100`)
  const comments = await listComments()
  const reading = withRecorderCompleteness(evidenceStateFor(comments, headSha), unsettledRecorders(runsPage?.workflow_runs, recorders), headSha)
  const server = process.env.GITHUB_SERVER_URL || "https://github.com"
  const detailsUrl = process.env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : null
  if (mode === "comment") {
    if (reading.state === "success") console.log(`::notice title=${EVIDENCE_CHECK}::${reading.summary}`)
    if (reading.state === "pending") console.log(`::warning title=${EVIDENCE_CHECK}::${reading.summary}`)
    const body = gateCommentBody(reading, headSha, detailsUrl)
    const posted = existingGateComment(comments, headSha)
    if (posted !== null && posted.body === body) {
      console.log(`${EVIDENCE_CHECK} comment on ${headSha.slice(0, 7)} already reads ${reading.state}; nothing to do.`)
    } else if (posted !== null) {
      await github(`/repos/${repo}/issues/comments/${posted.id}`, { method: "PATCH", body: JSON.stringify({ body }) })
      console.log(`updated the ${EVIDENCE_CHECK} comment on head ${headSha.slice(0, 7)} for PR #${prNumber}: ${reading.state}`)
    } else {
      await github(`/repos/${repo}/issues/${prNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) })
      console.log(`posted the ${EVIDENCE_CHECK} comment on head ${headSha.slice(0, 7)} for PR #${prNumber}: ${reading.state}`)
    }
  } else {
    const payload = checkRunPayload(reading, headSha, detailsUrl)
    const existing = await github(`/repos/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(EVIDENCE_CHECK)}&per_page=100`)
    if (alreadyPublished(existing?.check_runs, payload)) {
      console.log(`${EVIDENCE_CHECK} on ${headSha.slice(0, 7)} already reads ${reading.state}; nothing to do.`)
    } else {
      await github(`/repos/${repo}/check-runs`, { method: "POST", body: JSON.stringify(payload) })
      console.log(`published ${EVIDENCE_CHECK} = ${reading.state} on head ${headSha.slice(0, 7)} for PR #${prNumber}`)
    }
  }
  if (reading.state === "failure") {
    console.log(`::error::pull request ${prNumber}: ${reading.summary}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
