import { pathToFileURL } from "node:url";

/**
 * Mirrors trusted Garnet Runtime Review bytes into a PR description.
 *
 * Contract: verbatim bytes, exact garnet:commit head binding, line-anchored
 * delimiters, a head-bound pointer at the GitHub body cap or on delimiter
 * collision, and trusted authors only.
 * Required environment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA.
 * Optional environment: GITHUB_API_URL.
 */
const RUNTIME_REVIEW_MARKER = "<!-- garnet-runtime-review -->"
const BEGIN = "<!-- garnet:evidence:begin -->"
const END = "<!-- garnet:evidence:end -->"
const BEGIN_LINE_RE = /^<!-- garnet:evidence:begin -->[ \t]*\r?$/m
const END_LINE_RE = /^<!-- garnet:evidence:end -->[ \t]*\r?$/m
const COMMIT_RE = /<!--\s*garnet:commit\s+([0-9a-f]{40})\s*-->/
const BODY_LIMIT = 65536
const TRUSTED_AUTHORS = new Set([
  "github-actions[bot]",
  "garnet-runtime-review[bot]",
  "garnet-runtime-review-dev[bot]",
])
const GARNET_OWNED_MARKER_RE =
  /<!--\s*garnet-(?:control-plane|action)(?:-pending)?-pr-comment:v1(?::[a-z0-9.-]+)?\s*-->/

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
  return res.json()
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
 * @param {{user?: {login?: string}, body?: string}} comment
 * @returns {boolean}
 */
export function isTrustedEvidenceComment(comment) {
  return (
    TRUSTED_AUTHORS.has(comment?.user?.login) &&
    typeof comment?.body === "string" &&
    comment.body.includes(RUNTIME_REVIEW_MARKER) &&
    GARNET_OWNED_MARKER_RE.test(comment.body)
  )
}

function selectEvidenceComment(comments) {
  const bound = comments.filter((comment) => {
    if (!isTrustedEvidenceComment(comment)) return false
    const match = COMMIT_RE.exec(comment.body)
    return match !== null && match[1] === headSha
  })
  return bound.find((comment) => comment.body.includes(":v1:app.garnet.ai")) ?? bound[0] ?? null
}

function section(inner) {
  return [BEGIN, "## Runtime evidence (Garnet)", "", inner, END].join("\n")
}

function preambleFor(head) {
  const sha7 = head.slice(0, 7)
  const preamble = [
    `Kernel-recorded execution record for head \`${head}\`, mirrored verbatim from`,
    "the sticky Garnet Runtime Review comment on this PR so reviewers that read only",
    "the description ground in the same bytes. Facts only. Judgment stays with the",
    "reviewer. Cite grounded findings as:",
    "",
    `> Runtime evidence (Garnet, head \`${sha7}\`): \`<execution chain>\` → \`<destination>\` (\`<workflow>/<job>\`) — <Execution Profile URL>`,
    "",
  ].join("\n")
  return preamble
}

function pointerSection(comment, head, preamble, reason) {
  const sha7 = head.slice(0, 7)
  return section(
    `<!-- garnet:commit ${head} -->\n${preamble}\nThe record for head \`${sha7}\` is not mirrored here because ${reason}` +
      ` Read it verbatim in [the sticky Garnet Runtime Review comment](${comment.html_url}).`,
  )
}

/**
 * @param {{body: string, html_url?: string}} comment
 * @param {string} head
 * @param {number} remainingBudget
 * @returns {string}
 */
export function renderEvidenceSection(comment, head, remainingBudget) {
  const preamble = preambleFor(head)
  const mirrored = [
    "<details><summary>Execution record (verbatim mirror)</summary>",
    "",
    comment.body,
    "",
    "</details>",
  ].join("\n")
  const full = section(`${preamble}\n${mirrored}`)
  if (hasDelimiterCollision(comment.body)) {
    return pointerSection(
      comment,
      head,
      preamble,
      "the source bytes contain a reserved line-anchored evidence delimiter.",
    )
  }
  if (full.length <= remainingBudget) return full
  return pointerSection(comment, head, preamble, "it exceeds the description size budget.")
}

/**
 * @param {string} body
 * @returns {boolean}
 */
export function hasDelimiterCollision(body) {
  return BEGIN_LINE_RE.test(body) || END_LINE_RE.test(body)
}

function missingSection() {
  return section(
    `No runtime evidence is bound to head \`${headSha.slice(0, 7)}\` yet. The sticky Garnet` +
      " Runtime Review comment either has not been posted for this head or describes an earlier" +
      " commit. Missing evidence means *no record*, not a clean run.",
  )
}

function removeSection(body) {
  const begin = BEGIN_LINE_RE.exec(body)
  if (!begin) return body
  const after = body.slice(begin.index)
  const end = END_LINE_RE.exec(after)
  if (!end) return body
  return body.slice(0, begin.index) + after.slice(end.index + end[0].length)
}

function upsert(body, block) {
  const begin = BEGIN_LINE_RE.exec(body)
  if (begin) {
    const after = body.slice(begin.index)
    const end = END_LINE_RE.exec(after)
    if (end) {
      return body.slice(0, begin.index) + block + after.slice(end.index + end[0].length)
    }
  }
  return `${body.trimEnd()}\n\n${block}\n`
}

async function main() {
  if (!process.env.GITHUB_TOKEN || !repo || !prNumber || !headSha) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER and HEAD_SHA are required")
  }
  const pr = await github(`/repos/${repo}/pulls/${prNumber}`)
  if (pr.head?.sha !== headSha) {
    console.log(`PR head moved (${pr.head?.sha?.slice(0, 7)} != ${headSha.slice(0, 7)}); not mirroring a stale record.`)
    return
  }
  const comment = selectEvidenceComment(await listComments())
  const currentBody = pr.body ?? ""
  const bodyWithoutSection = removeSection(currentBody)
  const block = comment
    ? renderEvidenceSection(comment, headSha, BODY_LIMIT - bodyWithoutSection.length)
    : missingSection()
  const nextBody = upsert(currentBody, block)
  if (nextBody === currentBody) {
    console.log("Evidence section already current; nothing to do.")
    return
  }
  await github(`/repos/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ body: nextBody }),
  })
  console.log(
    comment
      ? `Mirrored head-bound record (comment ${comment.id}) into the PR description.`
      : "No head-bound record found; description section states evidence is missing.",
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
