# Bootstrap routing fixture

A harmless, deterministic workload for the Garnet recorder on this fork.

`run.sh` lays out the Corepack entry point (`pnpm/npm/pnpm/bin/pnpm.mjs`) the way
Corepack does: a wrapper directory without the `@pnpm/exe.<target>` package, with
`get-pnpm` in `dist/node_modules`. It runs `pnpm --version` once from a project whose
`.npmrc` names a public read-only npm mirror for the `@pnpm` scope. The native binary is
downloaded on that first run and checked against npm's registry signature.

- No credentials: npm configuration from the environment and the user `.npmrc` is cleared.
- No publication or registry mutation: two GET requests for one published package.
- `get-pnpm-0.0.5.tgz` is the exact tarball the repository lockfile pins; `run.sh` refuses
  it unless its sha512 matches the lockfile integrity.
