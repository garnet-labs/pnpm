# proxy-routing

Runs `pnpm ping` once against the public registry from a project whose
`.npmrc` says `proxy=false`, while `HTTP_PROXY`/`HTTPS_PROXY` name a local
forward proxy on `127.0.0.1:3128`. The proxy tunnels CONNECT requests and logs
each target. The script prints the ping result and the proxy log; it asserts
nothing. One GET of `/-/ping` is the only registry traffic.
