const GITHUB_PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/i
const MARKER_COMMIT_RE = /<!--\s*garnet:commit\s+([0-9a-f]{40})\s*-->/i
const SUMMARY_RE = /<!--\s*garnet:summary\s+(\{.*?\})\s*-->/is
const PROFILE_RE = /[?&]profile=([0-9a-f-]{36})/i
const RUN_RE = /\/(?:actions\/runs|public\/runs)\/(\d+)/i
const STICKY_MARKER = "<!-- garnet-runtime-review -->"
const GARNET_BOT_LOGIN = "garnet-runtime-review[bot]"

/**
 * Parse a GitHub pull request URL.
 * @param {string} url
 * @returns {{owner: string, repo: string, number: number}}
 */
export function parsePrUrl(url) {
  if (typeof url !== "string") {
    throw new Error("expected a GitHub pull request URL")
  }
  const match = GITHUB_PR_RE.exec(url.trim())
  if (match === null) {
    throw new Error(`not a GitHub pull request URL: ${url}`)
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

/**
 * Identify a Runtime Review App comment.
 * @param {Record<string, unknown>} comment
 * @returns {boolean}
 */
export function isGarnetComment(comment) {
  const user = comment !== null && typeof comment.user === "object" && comment.user !== null
    ? /** @type {Record<string, unknown>} */ (comment.user)
    : null
  const login = user !== null && typeof user.login === "string" ? user.login : ""
  const body = typeof comment?.body === "string" ? comment.body : ""
  return login === GARNET_BOT_LOGIN || body.includes(STICKY_MARKER)
}

/**
 * Parse machine markers and links from a Runtime Review comment.
 * @param {string} commentBody
 * @returns {{markerCommit: string|null, summary: Record<string, unknown>|null, profileId: string|null, runId: string|null, permalink: string|null, body: string}}
 */
export function parseReceipt(commentBody) {
  const body = typeof commentBody === "string" ? commentBody : ""
  const markerMatch = MARKER_COMMIT_RE.exec(body)
  const summaryMatch = SUMMARY_RE.exec(body)
  let summary = null
  if (summaryMatch !== null) {
    try {
      const parsed = JSON.parse(summaryMatch[1])
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        summary = parsed
      }
    } catch {
      summary = null
    }
  }
  const profileMatch = PROFILE_RE.exec(body)
  const runMatch = RUN_RE.exec(body)
  const permalinkMatch = /https:\/\/app\.garnet\.ai\/public\/runs\/\d+(?:\?[^\s)"'<]*)?/i.exec(body)
  return {
    markerCommit: markerMatch?.[1] ?? null,
    summary,
    profileId: profileMatch?.[1] ?? null,
    runId: runMatch?.[1] ?? null,
    permalink: permalinkMatch?.[0] ?? null,
    body,
  }
}

async function githubGet(path, token) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  }
  if (typeof token === "string" && token !== "") {
    headers.authorization = `Bearer ${token}`
  }
  const response = await fetch(`https://api.github.com${path}`, { headers })
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}`)
  }
  return response.json()
}

async function fetchPages(path, token) {
  const entries = []
  for (let page = 1; ; page += 1) {
    const pageEntries = await githubGet(`${path}?per_page=100&page=${page}`, token)
    if (!Array.isArray(pageEntries)) {
      throw new Error(`GitHub API returned a non-array page for ${path}`)
    }
    entries.push(...pageEntries)
    if (pageEntries.length < 100) {
      return entries
    }
  }
}

/**
 * Fetch pull request metadata, changed files, and issue comments.
 * @param {{owner: string, repo: string, number: number, token?: string}} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchPullRequest({ owner, repo, number, token }) {
  const encodedOwner = encodeURIComponent(owner)
  const encodedRepo = encodeURIComponent(repo)
  const prPath = `/repos/${encodedOwner}/${encodedRepo}/pulls/${number}`
  const pr = /** @type {Record<string, any>} */ (await githubGet(prPath, token))
  const files = /** @type {Array<Record<string, any>>} */ (
    await fetchPages(`${prPath}/files`, token)
  )
  const comments = /** @type {Array<Record<string, any>>} */ (
    await fetchPages(`/repos/${encodedOwner}/${encodedRepo}/issues/${number}/comments`, token)
  )
  const garnet = comments.find(isGarnetComment)
  const receipt = garnet === undefined ? parseReceipt("") : parseReceipt(garnet.body)
  const headSha = pr.head.sha
  return {
    pr_number: number,
    url: pr.html_url,
    title: pr.title,
    body: pr.body ?? "",
    head_sha: headSha,
    base_sha: pr.base.sha,
    state: pr.state,
    files: files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? "",
    })),
    garnet_comment_present: garnet !== undefined,
    garnet_comment_author: garnet?.user?.login ?? null,
    garnet_comment_url: garnet?.html_url ?? null,
    garnet_exact_head: receipt.markerCommit === headSha,
    garnet_marker_commit: receipt.markerCommit,
    garnet_summary: receipt.summary,
    garnet_comment_body: garnet?.body ?? null,
    other_comments: comments
      .filter((comment) => garnet === undefined || comment.id !== garnet.id)
      .map((comment) => ({ user: comment.user?.login, body: comment.body })),
  }
}
