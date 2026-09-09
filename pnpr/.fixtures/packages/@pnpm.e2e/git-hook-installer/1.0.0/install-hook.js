'use strict'
const fs = require('fs')
const path = require('path')

// The project running the install, the way simple-git-hooks and husky find it.
const projectDir = process.env.INIT_CWD
if (!projectDir) throw new Error('INIT_CWD is not set')

const hooksDir = path.join(projectDir, '.git', 'hooks')
fs.mkdirSync(hooksDir, { recursive: true })
fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "pre-commit hook installed by @pnpm.e2e/git-hook-installer"\n', { mode: 0o755 })
