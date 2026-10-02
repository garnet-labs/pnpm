import assert from "node:assert/strict"
import test from "node:test"

import {
  checkRunPayload,
  existingGateComment,
  gateCommentBody,
  parseGateMode,
} from "./garnet-evidence-gate.mjs"

const HEAD = "a".repeat(40)
const OTHER = "b".repeat(40)

test("parseGateMode defaults to check-run and rejects other values", () => {
  assert.equal(parseGateMode(undefined), "check-run")
  assert.equal(parseGateMode(""), "check-run")
  assert.equal(parseGateMode("comment"), "comment")
  assert.equal(parseGateMode("check-run"), "check-run")
  assert.throws(() => parseGateMode("checks"), /GARNET_GATE_MODE must be check-run or comment/)
})

test("gateCommentBody carries marker, state and summary without repo residue", () => {
  const reading = { state: "failure", summary: "No Runtime Review comment from the Garnet App is bound to head aaaaaaa." }
  const body = gateCommentBody(reading, HEAD, "https://github.com/o/r/actions/runs/1")
  assert.ok(body.startsWith(`<!-- garnet:evidence-gate ${HEAD} -->`))
  assert.match(body, /\*\*garnet\/evidence: failure\*\*/)
  assert.match(body, /No Runtime Review comment/)
  assert.match(body, /actions\/runs\/1/)
  assert.doesNotMatch(body, /devin|replay|harness|execution diff/i)
})

test("gateCommentBody omits the run link when no run id is known", () => {
  const body = gateCommentBody({ state: "success", summary: "s" }, HEAD, null)
  assert.doesNotMatch(body, /workflow run/)
})

test("existingGateComment matches only the comment for this head", () => {
  const comments = [
    { id: 1, body: `<!-- garnet:evidence-gate ${OTHER} -->\nold` },
    { id: 2, body: `<!-- garnet:evidence-gate ${HEAD} -->\ncurrent` },
  ]
  assert.equal(existingGateComment(comments, HEAD)?.id, 2)
  assert.equal(existingGateComment(comments, OTHER)?.id, 1)
  assert.equal(existingGateComment(comments, "c".repeat(40)), null)
})

test("checkRunPayload shape is unchanged for success, pending and failure", () => {
  const url = "https://github.com/o/r/actions/runs/1"
  assert.deepEqual(checkRunPayload({ state: "success", summary: "s" }, HEAD, url), {
    name: "garnet/evidence",
    head_sha: HEAD,
    details_url: url,
    status: "completed",
    conclusion: "success",
    output: { title: "Head-bound Runtime Review record", summary: "s" },
  })
  assert.deepEqual(checkRunPayload({ state: "pending", summary: "p" }, HEAD, null), {
    name: "garnet/evidence",
    head_sha: HEAD,
    status: "in_progress",
    output: { title: "Record still being written", summary: "p" },
  })
  assert.deepEqual(checkRunPayload({ state: "failure", summary: "f" }, HEAD, null), {
    name: "garnet/evidence",
    head_sha: HEAD,
    status: "completed",
    conclusion: "failure",
    output: { title: "No head-bound Runtime Review record", summary: "f" },
  })
})
