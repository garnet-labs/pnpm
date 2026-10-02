---
name: garnet-runtime-review
description: Ground pull request review in the head-bound Garnet Runtime Review record mirrored into the pull request description. Use when reviewing any pull request in this repository.
---

# Garnet Runtime Review

Read `REVIEW.md` at the repository root and apply it. The pull request
description carries a `Runtime evidence (Garnet)` section between
`<!-- garnet:evidence:begin -->` and `<!-- garnet:evidence:end -->`.

1. Compare the `<!-- garnet:commit <sha> -->` marker with the pull request
   head. Equal: the record is evidence for this head. Different, pending or
   missing: say so; that is no runtime evidence, not a clean run.
2. Prefix every runtime-grounded statement exactly with
   `Runtime evidence (Garnet, head <sha7>): ` followed by the execution chain,
   destination, workflow/job and the Execution Profile URL when present.
3. Cross-check the recorded execution chains and destinations against what the
   diff implies. Name anything the record shows that the diff does not explain
   and anything the diff implies that the record does not show.
4. Never repeat verdicts, scores or safety judgments from the record. Judgment
   comes from the diff.
