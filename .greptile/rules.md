# Garnet Runtime Review (Greptile adapter)

Apply `REVIEW.md` at the repository root. In short:

- The pull request description carries a `Runtime evidence (Garnet)` section
  between `<!-- garnet:evidence:begin -->` and `<!-- garnet:evidence:end -->`.
- Use it only when its `<!-- garnet:commit <sha> -->` equals the pull request
  head. A different SHA, a pending section or a missing section is no runtime
  evidence, not a clean run.
- Prefix each runtime-grounded statement exactly with
  `Runtime evidence (Garnet, head <sha7>): ` and name the execution chain,
  destination and workflow/job it came from.
- Never repeat verdicts, scores or safety judgments from the record. Judge the
  diff yourself.
