# Cargo-filter replay

This fork-only replay records the same filtered JavaScript dependency install at
two adjacent commits.

- Baseline: `cargo.enabled: false`
- Update: `cargo.enabled: true`
- Command: `pnpm install --frozen-lockfile --filter pacquet`
- Scope: `immediate-parent-to-head`
- Decision question: does enabling Cargo add attributable Cargo work even when
  the install is filtered to one JavaScript package?
- This is an isolated diagnostic specimen, not a routine contribution.
