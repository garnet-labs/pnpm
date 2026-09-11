#!/usr/bin/env node

import { readFile } from "node:fs/promises"

const marker = "<!-- garnet-replay-native-oracle -->"

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
}

function value(input) {
  if (input === null || input === undefined) return "unavailable"
  if (typeof input === "boolean") return input ? "yes" : "no"
  return `\`${String(input).replace(/`/g, "ʼ")}\``
}

const baseline = await readJson(process.env.BASELINE_OBSERVATION_PATH)
const update = await readJson(process.env.UPDATE_OBSERVATION_PATH)
const baselineSha = process.env.BASELINE_SHA || ""
const headSha = process.env.HEAD_SHA || ""
const repository = process.env.GITHUB_REPOSITORY || ""
const prNumber = process.env.PR_NUMBER || ""
const token = process.env.GITHUB_TOKEN || ""
const api = process.env.GITHUB_API_URL || "https://api.github.com"

const body = [
  marker,
  "**Native postcondition oracle: silent success → fail closed**",
  "",
  "| Observation | Baseline | Update |",
  "|---|---:|---:|",
  `| Exit code | ${value(baseline?.exitCode)} | ${value(update?.exitCode)} |`,
  `| Public validation error | ${value(baseline?.errorCodeObserved)} | ${value(update?.errorCodeObserved)} |`,
  `| Dangling symlink created | ${value(baseline?.danglingSymlinkCreated)} | ${value(update?.danglingSymlinkCreated)} |`,
  `| Invalid link written to lockfile | ${value(baseline?.lockfileRecordedLink)} | ${value(update?.lockfileRecordedLink)} |`,
  "",
  `<sub>baseline \`${baselineSha.slice(0, 7)}\` → update \`${headSha.slice(0, 7)}\` · immediate parent to head · this table is a native fixture oracle, not Garnet evidence</sub>`,
  "",
  "The separate Garnet comment records the exact-commit execution profiles. The replay is decision-useful only if that receipt adds a material fact beyond this table.",
].join("\n")

if (!token || !repository || !prNumber) {
  console.log(body)
  process.exit(0)
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "x-github-api-version": "2022-11-28",
}
const pullUrl = `${api}/repos/${repository}/pulls/${prNumber}`
const pull = await fetch(pullUrl, { headers })
if (!pull.ok) throw new Error(`Could not read PR (${pull.status})`)
const current = await pull.json()
if (current.head?.sha !== headSha) {
  console.warn(`PR head moved to ${current.head?.sha}; not publishing oracle for ${headSha}`)
  process.exit(0)
}

const commentsUrl = `${api}/repos/${repository}/issues/${prNumber}/comments`
const comments = await fetch(`${commentsUrl}?per_page=100`, { headers })
if (!comments.ok) throw new Error(`Could not list comments (${comments.status})`)
for (const comment of await comments.json()) {
  if (comment.user?.login === "github-actions[bot]" && comment.body?.includes(marker)) {
    await fetch(`${api}/repos/${repository}/issues/comments/${comment.id}`, {
      method: "DELETE",
      headers,
    })
  }
}

const posted = await fetch(commentsUrl, {
  method: "POST",
  headers,
  body: JSON.stringify({ body }),
})
if (!posted.ok) throw new Error(`Could not post oracle (${posted.status})`)
