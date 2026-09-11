# Peer-validation execution replay

This fork-only replay records the same malformed `peerDependencies` install at
two exact commits.

- Baseline: pnpm v12 silently accepts the malformed peer specifier.
- Update: the resolver validates the peer specifier before resolution.
- Scope: `immediate-parent-to-head`.
- Native oracle: exit code, public error code, symlink state, and lockfile state.
- Garnet evidence: exact-commit process lineage and outbound destinations.
- Share gate: the receipt is useful only if it adds a material execution fact
  beyond the native oracle.

This is a constructed replay in an approved fork. It is not a routine
contribution and must not create upstream-visible references.
