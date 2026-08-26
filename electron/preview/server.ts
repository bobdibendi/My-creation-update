import http from 'node:http'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
}

/**
 * Injected into every served HTML page.
 *
 * The static server has no build step and therefore no HMR, so the page polls a
 * revision endpoint and reloads when the directory changes on disk. Without
 * this, "actualisation automatique" would require the user to click refresh.
 */
const RELOAD_SNIPPET = `
<script>
(function () {
  var current = null;
  function poll() {
    fetch('/__preview_revision', { cache: 'no-store' })
      .then(function (response) { return response.text() })
      .then(function (value) {
        if (current === null) { current = value; return }
        if (value !== current) { window.location.reload() }
      })
      .catch(function () { /* server stopped; stop reloading */ })
      .then(function () { window.setTimeout(poll, 700) });
  }
  poll();
})();
</script>
`

export interface StaticServerHandle {
  url: string
  port: number
  root: string
  /** Bumps the revision so open pages reload on their next poll. */
  touch(): void
  close(): Promise<void>
}

function contentType(target: string): string {
  return MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolves a URL path inside the served root.
 * Returns null for traversal attempts so the server cannot leak the filesystem.
 */
function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '')
  const candidate = path.resolve(root, normalized)
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return candidate
}

async function statOrNull(target: string): Promise<fsSync.Stats | null> {
  try {
    return await fs.stat(target)
  } catch {
    return null
  }
}

function injectReloadSnippet(html: string): string {
  if (html.includes('__preview_revision')) return html
  const lower = html.toLowerCase()
  const closing = lower.lastIndexOf('</body>')
  if (closing >= 0) return `${html.slice(0, closing)}${RELOAD_SNIPPET}${html.slice(closing)}`
  return `${html}${RELOAD_SNIPPET}`
}

/**
 * Serves a directory over HTTP on the loopback interface.
 *
 * The server is intentionally unauthenticated: it exists to render a local
 * preview inside the app's own webview. It binds to 127.0.0.1 only, so it is
 * not reachable from the network, and it refuses any path outside `root`.
 */
export function startStaticServer(root: string): Promise<StaticServerHandle> {
  let revision = Date.now().toString(36)

  const server = http.createServer((request, response) => {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' })
      response.end('Méthode non autorisée')
      return
    }

    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')

    if (requestUrl.pathname === '/__preview_revision') {
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        // The page runs in a sandboxed iframe, so its origin is `null` and the
        // poll is a cross-origin request. Only this endpoint is opened up, and
        // it returns an opaque counter, never file contents.
        'Access-Control-Allow-Origin': '*',
      })
      response.end(revision)
      return
    }

    void (async () => {
      const resolved = safeJoin(root, requestUrl.pathname)
      if (!resolved) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Chemin refusé')
        return
      }

      let target = resolved
      const stats = await statOrNull(target)
      if (stats?.isDirectory()) {
        const index = path.join(target, 'index.html')
        if (await statOrNull(index)) target = index
      }

      const fileStats = await statOrNull(target)
      if (!fileStats || fileStats.isDirectory()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(`Introuvable: ${requestUrl.pathname}`)
        return
      }

      const type = contentType(target)
      if (type.startsWith('text/html')) {
        const html = injectReloadSnippet(await fs.readFile(target, 'utf8'))
        const body = Buffer.from(html, 'utf8')
        response.writeHead(200, {
          'Content-Type': type,
          'Content-Length': body.byteLength,
          'Cache-Control': 'no-store',
        })
        response.end(method === 'HEAD' ? undefined : body)
        return
      }

      const body = await fs.readFile(target)
      response.writeHead(200, {
        'Content-Type': type,
        'Content-Length': body.byteLength,
        'Cache-Control': 'no-store',
      })
      response.end(method === 'HEAD' ? undefined : body)
    })().catch(() => {
      if (response.headersSent) {
        response.end()
        return
      }
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Erreur du serveur de prévisualisation')
    })
  })

  return new Promise<StaticServerHandle>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Le serveur de prévisualisation n\'a pas fourni de port'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        port: address.port,
        root,
        touch: () => { revision = Date.now().toString(36) },
        close: () => new Promise<void>(done => {
          server.close(() => done())
          server.closeAllConnections()
        }),
      })
    }

    server.once('error', onError)
    server.once('listening', onListening)
    // Port 0 lets the OS pick a free port: a fixed port would clash with the
    // user's own servers.
    server.listen(0, '127.0.0.1')
  })
}
