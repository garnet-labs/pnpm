#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const outputPath = process.env.OBSERVATION_JSON_PATH
if (!outputPath) throw new Error("OBSERVATION_JSON_PATH is required")

const workspace = mkdtempSync(join(tmpdir(), "pnpm-peer-validation-"))
writeFileSync(join(workspace, "package.json"), `${JSON.stringify({
  name: "peer-validation-replay",
  version: "1.0.0",
  peerDependencies: {
    "@pnpm.e2e/foo": "@pnpm.e2e/foo@1.0.0",
  },
}, null, 2)}\n`)

const binary = resolve("target/release/pnpm")
const result = spawnSync(binary, ["install", "--ignore-scripts"], {
  cwd: workspace,
  encoding: "utf8",
  env: {
    ...process.env,
    CI: "true",
    NO_COLOR: "1",
  },
})

const linkPath = join(workspace, "node_modules", "@pnpm.e2e", "foo")
let linkTarget = ""
try {
  linkTarget = readlinkSync(linkPath)
} catch {
  linkTarget = ""
}

let lockfile = ""
try {
  lockfile = readFileSync(join(workspace, "pnpm-lock.yaml"), "utf8")
} catch {
  lockfile = ""
}

const stderr = result.stderr || ""
const observation = {
  schema: "garnet-replay/native-oracle/v1",
  exitCode: result.status,
  signal: result.signal,
  errorCodeObserved: stderr.includes("ERR_PNPM_INVALID_PEER_DEPENDENCY_SPECIFICATION"),
  danglingSymlinkCreated: linkTarget !== "",
  symlinkTarget: linkTarget,
  lockfileRecordedLink: lockfile.includes("link:@pnpm.e2e/foo@1.0.0"),
  stdout: (result.stdout || "").slice(-4000),
  stderr: stderr.slice(-4000),
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(observation, null, 2)}\n`)
console.log(JSON.stringify(observation, null, 2))
