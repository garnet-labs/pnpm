const fs = require('node:fs')
const path = require('node:path')

const markerDir = process.env.GARNET_SPECIMEN_MARKER_DIR
if (!markerDir) throw new Error('GARNET_SPECIMEN_MARKER_DIR is required')

fs.mkdirSync(markerDir, { recursive: true })
fs.writeFileSync(path.join(markerDir, 'git-prepare.json'), `${JSON.stringify({
  cwd: process.cwd(),
  lifecycleEvent: process.env.npm_lifecycle_event,
  pid: process.pid,
  ppid: process.ppid,
}, null, 2)}\n`)
fs.writeFileSync('prepared.txt', 'prepare ran\n')
