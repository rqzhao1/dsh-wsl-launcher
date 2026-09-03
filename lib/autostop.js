/**
 * dsh-wsl-launcher / autostop -- shut the `dsh web` server down when every
 * browser tab of the Web UI is closed.
 *
 * How it works:
 *   - the browser half (lib/client.js, an `immediately` client module)
 *     sends a per-tab presence heartbeat (a sessionStorage client id) to
 *     POST /api/autostop/presence every 5s while the page is alive, plus a
 *     keepalive "bye" on pagehide
 *   - the server half (this file) tracks the last heartbeat per client id
 *     and, in parallel, counts the web server's live WebSocket downlinks:
 *     a tab with an open session transport keeps a WS alive even when the
 *     tab is backgrounded and its timers are throttled by the browser
 *   - once the server has been up for minUptimeMs and neither a recent
 *     heartbeat nor any WebSocket has been seen for graceMs, it triggers
 *     the same bounded graceful shutdown as SIGTERM (the `appExit`
 *     service), logging a note to the launcher log when one is set
 *
 * Opt-in only: enabled via the row config `autostopEnabled` (set from
 * `DSH_WEB_AUTOSTOP=1` in cordis.patch.yml; the launcher script exports it
 * when it starts the daemon), so a plain `dsh web` is never affected.
 * @module dsh-wsl-launcher/autostop
 */

import { appendFileSync } from 'node:fs'

export const STATUS_PATH = '/api/autostop/status'
export const PRESENCE_PATH = '/api/autostop/presence'
export const BYE_PATH = '/api/autostop/bye'

export const DEFAULT_GRACE_MS = 30_000
export const DEFAULT_MIN_UPTIME_MS = 45_000
const TICK_MS = 5_000
const MAX_BODY_BYTES = 1024
const MAX_CLIENT_ID_LENGTH = 128
const MAX_TRACKED_CLIENTS = 256

/**
 * Pure presence tracker -- unit-testable without a Cordis context.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - clock (ms epoch); injectable in tests.
 */
export function createPresenceTracker({ now = Date.now } = {}) {
  const seen = new Map() // clientId -> last heartbeat (ms epoch)
  const start = now()
  let anyClient = false

  function report(clientId) {
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) return false
    if (!seen.has(clientId) && seen.size >= MAX_TRACKED_CLIENTS) return false
    seen.set(clientId, now())
    anyClient = true
    return true
  }

  function bye(clientId) {
    seen.delete(clientId)
  }

  function prune(graceMs) {
    const cutoff = now() - graceMs * 4
    for (const [id, t] of seen) {
      if (t < cutoff) seen.delete(id)
    }
  }

  /**
   * Decide whether the server should shut down.
   * @param {object} params
   * @param {number} params.graceMs - idle window with no liveness signal.
   * @param {number} params.minUptimeMs - never stop before this after boot.
   * @param {number} [params.wsCount] - live WebSocket downlinks (liveness).
   * @returns true when no tab has been seen recently enough.
   */
  function shouldStop({ graceMs, minUptimeMs, wsCount = 0 }) {
    prune(graceMs)
    if (now() - start < minUptimeMs) return false
    if (wsCount > 0) return false
    for (const t of seen.values()) {
      if (now() - t <= graceMs) return false
    }
    return true
  }

  return {
    report,
    bye,
    shouldStop,
    /** @returns whether at least one client has ever reported. */
    hasSeenClient: () => anyClient,
    /** @returns number of tracked (not yet pruned) clients. */
    size: () => seen.size,
  }
}

/** Minimal same-origin fence (the skin-manager pattern). */
function methodAllowed(req, expected) {
  return String(req.method || '').toUpperCase() === expected
}

function jsonContentType(req) {
  return /^application\/json(?:\s*;|\s*$)/i.test(String(req.headers?.['content-type'] || ''))
}

function sameOrigin(req) {
  const origin = req.headers?.origin
  const host = req.headers?.host
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read a small JSON body; resolves {} on any failure (never throws). */
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const fail = (status, error) => done({ ok: false, status, error })
    req.on('data', (chunk) => {
      if (settled) return
      size += Buffer.byteLength(chunk)
      if (size > maxBytes) {
        try { req.destroy() } catch { /* 请求对象可能不支持 destroy */ }
        fail(413, 'request-body-too-large')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const value = text ? JSON.parse(text) : null
        if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid-json-body')
        else done({ ok: true, value })
      } catch {
        fail(400, 'invalid-json-body')
      }
    })
    req.on('error', () => fail(400, 'request-read-failed'))
  })
}

/**
 * Install the autostop feature into a live web profile context.
 *
 * @param {object} ctx - Cordis plugin context (must be a web host).
 * @param {object} options
 * @param {boolean} [options.enabled] - when false, nothing is installed.
 * @param {number} [options.graceMs] - idle window before shutdown.
 * @param {number} [options.minUptimeMs] - startup grace before any shutdown.
 * @param {object} [options.logger] - { warn?, info? } sink.
 * @returns {{ installed: boolean, tracker?: object, reason?: string }}
 */
export function installAutostop(ctx, {
  enabled = false,
  graceMs = DEFAULT_GRACE_MS,
  minUptimeMs = DEFAULT_MIN_UPTIME_MS,
  logger,
  tickMs = TICK_MS,
} = {}) {
  if (!enabled) return { installed: false, reason: 'disabled' }
  // The row declares `inject: [webServer]`, so the scoped ctx exposes the
  // service as a property (the skin-manager pattern); ctx.get is a
  // fallback for direct callers that bypass the loader.
  const webServer =
    ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (!webServer || typeof webServer.register !== 'function') {
    logger?.warn?.('dsh-wsl-launcher: autostop is enabled but the webServer service is unavailable; skipped')
    return { installed: false, reason: 'no-webserver' }
  }

  if (!Number.isInteger(graceMs) || graceMs < 0) throw new Error('autostop graceMs must be a non-negative integer')
  if (!Number.isInteger(minUptimeMs) || minUptimeMs < 0) throw new Error('autostop minUptimeMs must be a non-negative integer')
  if (!Number.isInteger(tickMs) || tickMs <= 0) throw new Error('autostop tickMs must be a positive integer')
  const tracker = createPresenceTracker()
  const routeDisposers = []
  const launcherLog = process.env.DSH_WEB_LAUNCHER_LOG
  const startedAt = Date.now()
  let stopping = false

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (req, res) => {
      if (!sameOrigin(req)) { json(res, 403, { ok: false, error: 'cross-site-request-rejected' }); return }
      if (!methodAllowed(req, 'GET') && !methodAllowed(req, 'HEAD')) { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: 'cross-site-request-rejected' })
        return
      }
      json(res, 200, { ok: true, autostop: true })
    },
  }))
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: PRESENCE_PATH,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: 'cross-site-request-rejected' })
        return
      }
      if (!methodAllowed(req, 'POST')) { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!jsonContentType(req)) { json(res, 415, { ok: false, error: 'content-type-must-be-application-json' }); return }
      const body = await readJsonBody(req)
      if (!body.ok) { json(res, body.status, { ok: false, error: body.error }); return }
      if (!tracker.report(body.value.clientId)) { json(res, 400, { ok: false, error: 'invalid-client-id' }); return }
      json(res, 200, { ok: true })
    },
  }))
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: BYE_PATH,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: 'cross-site-request-rejected' })
        return
      }
      if (!methodAllowed(req, 'POST')) { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!jsonContentType(req)) { json(res, 415, { ok: false, error: 'content-type-must-be-application-json' }); return }
      const body = await readJsonBody(req)
      if (!body.ok) { json(res, body.status, { ok: false, error: body.error }); return }
      if (typeof body.value.clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.value.clientId)) { json(res, 400, { ok: false, error: 'invalid-client-id' }); return }
      tracker.bye(body.value.clientId)
      json(res, 200, { ok: true })
    },
  }))

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (stopping) return
      const wsCount = Number(webServer.upgradedSockets?.size ?? 0)
      if (!tracker.shouldStop({ graceMs, minUptimeMs, wsCount })) return
      stopping = true
      clearInterval(timer)
      logger?.warn?.(
        `dsh-wsl-launcher: no browser tab detected for ${Math.round(graceMs / 1000)}s ` +
        `(server uptime ${Math.round((Date.now() - startedAt) / 1000)}s) -- shutting the server down`,
      )
      if (launcherLog) {
        try {
          appendFileSync(
            launcherLog,
            `[launcher] ${new Date().toISOString()} dsh web: all browser tabs closed -- shutting down (autostop)\n`,
          )
        } catch {
          /* the note is best-effort */
        }
      }
      const exit = typeof ctx.get === 'function' ? ctx.get('appExit') : undefined
      if (typeof exit === 'function') exit(0)
      else logger?.warn?.('dsh-wsl-launcher: appExit service unavailable; autostop will not terminate the host process')
    }, tickMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
    }
  }, 'wsl-launcher: web autostop')

  ctx.effect(() => () => {
    for (const dispose of routeDisposers.reverse()) {
      try { dispose?.() } catch { /* 路由已被宿主清理时忽略重复清理 */ }
    }
  }, 'wsl-launcher: autostop routes')

  return { installed: true, tracker }
}
