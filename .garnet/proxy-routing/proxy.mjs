// Minimal forward proxy for the fixture: answers HTTP CONNECT by opening the
// requested host:port and piping both sockets, and logs every CONNECT target
// to the file named by PROXY_LOG. Nothing is cached, rewritten or inspected.
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import process from 'node:process'

const port = Number(process.env.PROXY_PORT ?? '3128')
const logFile = process.env.PROXY_LOG ?? 'proxy.log'

const server = http.createServer((req, res) => {
  fs.appendFileSync(logFile, `${req.method} ${req.url}\n`)
  res.writeHead(501).end()
})

server.on('connect', (req, clientSocket, head) => {
  const [host, targetPort] = req.url.split(':')
  fs.appendFileSync(logFile, `CONNECT ${req.url}\n`)
  const upstream = net.connect(Number(targetPort ?? '443'), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstream.destroy())
})

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(logFile, '')
  console.log(`proxy listening on 127.0.0.1:${port}`)
})
