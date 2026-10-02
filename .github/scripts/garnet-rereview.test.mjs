import assert from "node:assert/strict"
import test from "node:test"

import {
  commentToken,
  fallbackEvidenceState,
  renderRequestComment,
} from "./garnet-rereview.mjs"

const HEAD = "a".repeat(40)
const OTHER = "b".repeat(40)
const TRUSTED = "garnet-runtime-review[bot]"

function record(head = HEAD, summary = { status: "finalized", capture_quality: "complete", jobs: 1, recorded: "1 chain" }) {
  return {
    user: { login: TRUSTED },
    body: [
      "<!-- garnet-runtime-review -->",
      `<!-- garnet:commit ${head} -->`,
      `<!-- garnet:summary ${JSON.stringify(summary)} -->`,
    ].join("\n"),
  }
}

test("commentToken prefers the configured user token", () => {
  assert.deepEqual(commentToken({ GARNET_REVIEW_TRIGGER_TOKEN: "u", GITHUB_TOKEN: "w" }), { token: "u", identity: "user" })
  assert.deepEqual(commentToken({ GARNET_REVIEW_TRIGGER_TOKEN: "", GITHUB_TOKEN: "w" }), { token: "w", identity: "workflow" })
  assert.deepEqual(commentToken({ GITHUB_TOKEN: "w" }), { token: "w", identity: "workflow" })
})

test("renderRequestComment leads with the lock marker and only mention lines", () => {
  const body = renderRequestComment(["coderabbit", "qodo", "devin"], HEAD)
  assert.ok(body.startsWith(`<!-- garnet:rereview ${HEAD} -->`))
  assert.match(body, /@coderabbitai review/)
  assert.match(body, /^\/review$/m)
  assert.doesNotMatch(body, /devin/i)
})

test("fallbackEvidenceState: finalized complete record with settled recorders is success", () => {
  const runs = [{ name: "TS CI", status: "completed" }]
  assert.equal(fallbackEvidenceState([record()], runs, ["TS CI"], HEAD), "success")
})

test("fallbackEvidenceState: capture not declared is failure", () => {
  const summary = { status: "finalized", jobs: 1 }
  assert.equal(fallbackEvidenceState([record(HEAD, summary)], [], [], HEAD), "failure")
})

test("fallbackEvidenceState: a pending placeholder keeps polling", () => {
  const comment = {
    user: { login: TRUSTED },
    body: `<!-- garnet-runtime-review -->\n<!-- garnet:commit ${HEAD} -->\ngarnet-control-plane-pending-pr-comment`,
  }
  assert.equal(fallbackEvidenceState([comment], [], [], HEAD), "pending")
})

test("fallbackEvidenceState: a record bound to another head is failure", () => {
  assert.equal(fallbackEvidenceState([record(OTHER)], [], [], HEAD), "failure")
})

test("fallbackEvidenceState: an untrusted author is failure", () => {
  const comment = { ...record(), user: { login: "github-actions[bot]" } }
  assert.equal(fallbackEvidenceState([comment], [], [], HEAD), "failure")
})

test("fallbackEvidenceState: an unsettled recorder run is pending", () => {
  const runs = [{ name: "TS CI", status: "in_progress" }]
  assert.equal(fallbackEvidenceState([record()], runs, ["TS CI"], HEAD), "pending")
})
