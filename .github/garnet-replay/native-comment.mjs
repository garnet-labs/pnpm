import { readFile } from "node:fs/promises"

const marker = "<!-- garnet-cargo-filter-native:v1 -->"
const token = process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const pullNumber = Number(process.env.PR_NUMBER)
const baselinePath = process.env.BASELINE_NATIVE_JSON_PATH
const updatePath = process.env.UPDATE_NATIVE_JSON_PATH

if (!token || !repository || !Number.isInteger(pullNumber) || !baselinePath || !updatePath) {
  throw new Error("missing native replay comment configuration")
}

const [baseline, update] = await Promise.all([
  readFile(baselinePath, "utf8").then(JSON.parse),
  readFile(updatePath, "utf8").then(JSON.parse),
])

const bool = (value) => value ? "yes" : "no"
const mib = (bytes) => (Number(bytes) / 1024 / 1024).toFixed(1)
const seconds = (milliseconds) => (Number(milliseconds) / 1000).toFixed(2)
const body = [
  marker,
  "## Native Cargo-filter oracle",
  "",
  "> Same runner image, setup, command, and lockfiles. The immediate head changes only `cargo.enabled` from `false` to `true`.",
  "",
  "| postcondition | Cargo off | Cargo on |",
  "|---|---:|---:|",
  `| install exit code | ${baseline.exitCode} | ${update.exitCode} |`,
  `| elapsed seconds | ${seconds(baseline.elapsedMs)} | ${seconds(update.elapsedMs)} |`,
  `| pnpm-managed Cargo marker | ${bool(baseline.cargoMarkerPresent)} | ${bool(update.cargoMarkerPresent)} |`,
  `| \`.pnpm/crates\` present | ${bool(baseline.cratesDirectoryPresent)} | ${bool(update.cratesDirectoryPresent)} |`,
  `| tracked Cargo config modified | ${bool(baseline.cargoConfigModified)} | ${bool(update.cargoConfigModified)} |`,
  `| registry crate entries | ${baseline.registryCrateEntries} | ${update.registryCrateEntries} |`,
  `| git crate entries | ${baseline.gitCrateEntries} | ${update.gitCrateEntries} |`,
  `| Cargo materialization MiB | ${mib(baseline.cratesDiskBytes)} | ${mib(update.cratesDiskBytes)} |`,
  "",
  "Decision gate: the Garnet receipt is useful only if its workload section attributes the added execution to pnpm/Cargo. Native postconditions prove materialization, but runner-background deltas do not.",
].join("\n")

const apiBase = `https://api.github.com/repos/${repository}/issues/${pullNumber}/comments`
const headers = {
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-github-api-version": "2022-11-28",
}
const existingResponse = await fetch(`${apiBase}?per_page=100`, { headers })
if (!existingResponse.ok) throw new Error(`comment list failed: ${existingResponse.status}`)
const existing = (await existingResponse.json()).find((comment) => comment.body?.includes(marker))
const response = await fetch(existing ? existing.url : apiBase, {
  method: existing ? "PATCH" : "POST",
  headers,
  body: JSON.stringify({ body }),
})
if (!response.ok) throw new Error(`comment write failed: ${response.status} ${await response.text()}`)
console.log(existing ? "updated native oracle comment" : "posted native oracle comment")
