// A real HTTP server on 127.0.0.1 for the tests of the HTTP client, the downloads and the GitHub
// releases: they run against sockets, not against a stubbed `fetch`.
import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

export interface RecordedRequest {
  method: string
  /** Path and query, as received. */
  url: string
  headers: IncomingHttpHeaders
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export interface TestServer {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  url: string
  /** Every request received so far, in order. */
  requests: RecordedRequest[]
  /** Replaces the handler (the one given to `startTestServer` answers until then). */
  handle(handler: RequestHandler): void
  /** Stops listening and drops the open connections (a hanging response included). */
  close(): Promise<void>
}

export async function startTestServer(initial: RequestHandler): Promise<TestServer> {
  let handler = initial
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers })
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => res.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    handle: (next) => {
      handler = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** Answers with a status, headers and a body (its Content-Length included), then ends the response. */
export function reply(
  res: ServerResponse,
  status: number,
  body: string | Buffer = '',
  headers: Record<string, string | number> = {},
): void {
  res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers })
  res.end(body)
}

/** A network failure: the connection is cut before any byte of answer. */
export const dropConnection: RequestHandler = (req) => {
  req.socket.destroy()
}

/**
 * A `fetch` that sends the requests aimed at `hosts` (for instance `api.github.com`) to `server`,
 * keeping the path and the query. The code under test still sees the real URL, so what it decides
 * from the host (the GitHub token) is decided as in production.
 */
export function fetchVia(server: TestServer, ...hosts: string[]): typeof fetch {
  return (input, init) => {
    const original = new URL(input instanceof Request ? input.url : input.toString())
    const target = hosts.includes(original.host)
      ? `${server.url}${original.pathname}${original.search}`
      : original
    return fetch(target, init)
  }
}

/** A recorded GitHub API JSON fixture (tests/fixtures/github), parsed. */
export function githubFixture(name: string): unknown {
  const file = fileURLToPath(new URL(`../fixtures/github/${name}`, import.meta.url))
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}
