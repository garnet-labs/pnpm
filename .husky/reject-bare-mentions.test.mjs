import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { fileURLToPath, URL } from "node:url"

const hookPath = fileURLToPath(new URL("./reject-bare-mentions.mjs", import.meta.url))

const cases = [
  {
    name: "accepts the Devin co-author trailer",
    message: "chore: x\n\nCo-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>",
    exitCode: 0,
  },
  {
    name: "accepts a conventional co-author trailer",
    message: "chore: x\n\nCo-authored-by: A <a@b.com>",
    exitCode: 0,
  },
  {
    name: "accepts a scoped package in backticks",
    message: "fix: bump `@pnpm/core`",
    exitCode: 0,
  },
  {
    name: "ignores mentions on git comment lines",
    message: "chore: x\n# @someone in a comment line",
    exitCode: 0,
  },
  {
    name: "rejects a mention in an angle-bracketed path",
    message: "fix: see <docs/@alice>",
    exitCode: 1,
    offendingHandle: "@alice",
  },
  {
    name: "rejects an angle-bracketed mention",
    message: "see <@foo>",
    exitCode: 1,
    offendingHandle: "@foo",
  },
  {
    name: "rejects a plain mention",
    message: "ping @someone",
    exitCode: 1,
    offendingHandle: "@someone",
  },
  {
    name: "rejects an unquoted scoped package",
    message: "fix: bump @pnpm/core",
    exitCode: 1,
    offendingHandle: "@pnpm/core",
  },
  {
    name: "rejects a mention following an email",
    message: "chore: x\n\nCo-authored-by: A <a@b.com> cc @someone",
    exitCode: 1,
    offendingHandle: "@someone",
  },
  {
    name: "accepts a plain address GitHub will not linkify",
    message: "see <a@localhost>",
    exitCode: 0,
  },
]

for (const { name, message, exitCode, offendingHandle } of cases) {
  test(name, () => {
    const tempDir = mkdtempSync(join(tmpdir(), "reject-bare-mentions-"))
    try {
      const messagePath = join(tempDir, "commit-message.txt")
      writeFileSync(messagePath, message)
      const result = spawnSync(process.execPath, [hookPath, messagePath], { encoding: "utf8" })

      assert.equal(result.status, exitCode, result.stderr)
      if (offendingHandle !== undefined) {
        assert.ok(result.stderr.includes(offendingHandle), `stderr should include ${offendingHandle}`)
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
}
