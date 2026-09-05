# Copilot review instructions

Apply the repository review framework in [REVIEW_GUIDE.md](../REVIEW_GUIDE.md)
(security first, performance second; surface only issues tied to the changed
code) and the agent conventions in [AGENTS.md](../AGENTS.md).

Ground every review in the PR's runtime evidence per [REVIEW.md](../REVIEW.md):

- The PR description carries a `Runtime evidence (Garnet)` section between
  `<!-- garnet:evidence:begin -->` and `<!-- garnet:evidence:end -->`. It
  mirrors the head-SHA-bound, kernel-recorded execution profile of the
  instrumented CI run.
- Open the review with one line:
  `**Runtime grounding** (head \`<sha7>\`): <what the recorded run showed
  against what this diff should do>`.
- Use the record only when its `<!-- garnet:commit <sha> -->` marker equals
  the PR head; state stale, pending, or absent evidence explicitly and treat
  it as no runtime evidence.
- Reconcile the recorded execution chains and outbound destinations with what
  the diff implies. Prefix runtime-grounded statements with
  `Runtime evidence (Garnet, head <sha7>):`; label everything else as static
  inference.
- Never treat missing evidence as proof of absent behavior, never claim
  coverage the record does not show, and never repeat the record's own
  verdicts or safety judgments.
