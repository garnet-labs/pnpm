// Opens many short TCP connections to a local listener so Jibril has a large
// flow backlog to report at shutdown, like pnpm's tests against the local pnpr
// registry, only larger.
import net from 'node:net'

const total = Number(process.env.FLOWS ?? '20000')
const concurrency = Number(process.env.CONCURRENCY ?? '64')

const server = net.createServer(socket => {
  socket.on('data', () => socket.end('ok'))
  socket.on('error', () => {})
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

let started = 0
let done = 0
let failed = 0
const t0 = Date.now()

function one () {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('hi'))
    socket.on('data', () => socket.end())
    socket.on('close', () => resolve())
    socket.on('error', () => { failed++; resolve() })
  })
}

async function worker () {
  while (started < total) {
    started++
    await one()
    done++
    if (done % 5000 === 0) console.log(`flows: ${done}/${total} (${Math.round((Date.now() - t0) / 1000)}s)`)
  }
}

await Promise.all(Array.from({ length: concurrency }, worker))
server.close()
console.log(`flow storm done: ${done} connections, ${failed} failed, ${Math.round((Date.now() - t0) / 1000)}s`)
