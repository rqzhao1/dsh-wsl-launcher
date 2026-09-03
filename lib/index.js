/**
 * dsh-wsl-launcher — one-click Windows desktop launcher for the DeepSeek
 * Harness Web UI when dsh runs inside WSL, plus a model-facing
 * `wsl_launcher` tool.
 *
 * Host-side behavior:
 *   - detect WSL (kernel banner, WSL_DISTRO_NAME / WSL_INTEROP fallbacks)
 *   - on activation, auto-install (configurable): write the ASCII bash
 *     launcher script + whale icon into ~/.dsh/dsh-wsl-launcher, write the
 *     hidden-console VBScript wrapper into the Windows user home, and
 *     create the desktop .lnk (whale icon) that runs the wrapper so the
 *     server starts in the background with no console window
 *   - register the `wsl_launcher` tool: install / status / open / stop /
 *     uninstall
 *
 * Non-WSL hosts: nothing is installed; the tool stays registered and its
 * `status` / `open` actions still work (open degrades gracefully).
 * @module dsh-wsl-launcher
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  defaultLauncherDir,
  detectWsl,
  validateLaunchMode,
  validateNpxPackage,
  validatePort,
  ensureLauncher,
  ensureShortcut,
  openInWindowsBrowser,
  resolveDshBin,
  resolveWindowsExe,
  serverStatus,
  stopServer,
  uninstallShortcut,
} from './launcher.js'
import { DEFAULT_GRACE_MS, DEFAULT_MIN_UPTIME_MS, installAutostop } from './autostop.js'

/** Stable Cordis plugin name; keep stable after publishing. */
export const name = 'wsl-launcher'

/** Services required before load: the model-facing tool registry. */
export const inject = ['tools']

/** Loader-visible configuration schema and defaults. */
export const Config = z.object({
  autoInstall: z.boolean().default(true),
  port: z.number().default(3080),
  distro: z.string().default(''),
  wslUser: z.string().default(''),
  linkName: z.string().default('DeepSeek Harness Web.lnk'),
  launcherDir: z.string().default(''),
  scriptName: z.string().default('dsh-web-launcher.sh'),
  withIcon: z.boolean().default(true),
  launchMode: z.string().default('installed'),
  npxPackage: z.string().default(''),
  /**
   * Shut the web server down when every browser tab is closed. Driven by
   * `DSH_WEB_AUTOSTOP=1` (exported by the launcher script for its daemon);
   * keep the default false so a plain `dsh web` is never auto-stopped.
   */
  autostopEnabled: z.boolean().default(false),
  /** Idle window (ms) without any tab heartbeat/WebSocket before shutdown. */
  autostopGraceMs: z.number().default(DEFAULT_GRACE_MS),
  /** Never autostop before this much (ms) server uptime. */
  autostopMinUptimeMs: z.number().default(DEFAULT_MIN_UPTIME_MS),
})

/**
 * Resolve defaults for direct callers that bypass the Cordis loader.
 * @param {object} [config] - partial serialized configuration.
 * @returns configuration with all defaults applied.
 */
export function resolveConfig(config = {}) {
  const resolved = {
    autoInstall: config.autoInstall ?? true,
    port: config.port ?? 3080,
    distro: config.distro ?? '',
    wslUser: config.wslUser ?? '',
    linkName: config.linkName ?? 'DeepSeek Harness Web.lnk',
    launcherDir: config.launcherDir ?? '',
    scriptName: config.scriptName ?? 'dsh-web-launcher.sh',
    withIcon: config.withIcon ?? true,
    launchMode: config.launchMode ?? 'installed',
    npxPackage: config.npxPackage ?? '',
    autostopEnabled: config.autostopEnabled ?? false,
    autostopGraceMs: config.autostopGraceMs ?? DEFAULT_GRACE_MS,
    autostopMinUptimeMs: config.autostopMinUptimeMs ?? DEFAULT_MIN_UPTIME_MS,
  }
  validatePort(resolved.port)
  resolved.launchMode = validateLaunchMode(resolved.launchMode)
  if (resolved.launchMode === 'npx') resolved.npxPackage = validateNpxPackage(resolved.npxPackage)
  for (const [name, value] of [['autostopGraceMs', resolved.autostopGraceMs], ['autostopMinUptimeMs', resolved.autostopMinUptimeMs]]) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  }
  return resolved
}

/**
 * Apply the plugin to its Cordis context.
 * @param {object} ctx - scoped plugin context (logger, tools).
 * @param {object} [config] - configuration resolved by Cordis.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const logger = ctx.logger
  const wsl = detectWsl()
  const url = `http://127.0.0.1:${resolved.port}`

  /** (Re)create the launcher script/icon and the desktop shortcut. */
  function install() {
    const launcher = ensureLauncher({
      port: resolved.port,
      dshBin: resolveDshBin(),
      launcherDir: resolved.launcherDir,
      scriptName: resolved.scriptName,
      withIcon: resolved.withIcon,
      launchMode: resolved.launchMode,
      npxPackage: resolved.npxPackage,
    })
    const shortcut = ensureShortcut({
      port: resolved.port,
      distro: resolved.distro || wsl.distro,
      wslUser: resolved.wslUser,
      linkName: resolved.linkName,
      launcherDir: resolved.launcherDir,
      scriptName: resolved.scriptName,
      withIcon: resolved.withIcon,
    })
    return { launcher, shortcut }
  }

  if (wsl.isWsl && resolved.autoInstall) {
    try {
      const { launcher, shortcut } = install()
      logger.info(
        `dsh-wsl-launcher: launcher ${launcher.created ? 'created' : 'refreshed'} at ${launcher.scriptPath}`,
      )
      logger.info(
        `dsh-wsl-launcher: shortcut ${shortcut.created ? 'created' : 'refreshed'} at ${shortcut.path}`,
      )
    } catch (error) {
      logger.warn(`dsh-wsl-launcher: auto install skipped: ${String(error)}`)
    }
  } else if (!wsl.isWsl) {
    logger.info(
      'dsh-wsl-launcher: not running under WSL; Windows desktop shortcut skipped (wsl_launcher tool stays active)',
    )
  }

  ctx.tools.register(
    defineTool({
      name: 'wsl_launcher',
      description:
        'Manage the Windows desktop launcher for the DeepSeek Harness Web UI in WSL. ' +
        'Actions: "install" (re)creates the WSL launcher script, the hidden-console wrapper, and the ' +
        'whale-icon desktop shortcut that starts `dsh web` in the background inside this WSL distribution ' +
        'and opens the browser without any console window (requires WSL interop); ' +
        '"status" reports WSL detection, distribution, interop availability, launcher files, the background ' +
        'daemon pid (when present), and whether the Web UI port is listening; ' +
        '"open" opens the Web UI in the default Windows browser; ' +
        '"stop" stops the background `dsh web` server started by the launcher (safe: servers started ' +
        'outside the launcher are never touched); ' +
        '"uninstall" removes the desktop shortcut, the Windows wrapper, and the launcher directory. ' +
        'Outside WSL, install/uninstall/stop report a clear no-op message.',
      parameters: {
        action: {
          type: 'string',
          enum: ['install', 'status', 'open', 'stop', 'uninstall'],
          default: 'status',
          description: 'What to do with the WSL desktop launcher.',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'The executed action.' },
            isWsl: { type: 'boolean', description: 'Whether dsh runs under WSL.' },
            distro: { type: 'string', description: 'WSL distribution name (empty when unknown).' },
            running: { type: 'boolean', description: 'Whether the Web UI port is listening.' },
            url: { type: 'string', description: 'The Web UI URL.' },
            scriptPath: { type: 'string', description: 'WSL launcher script path (install action).' },
            shortcutPath: { type: 'string', description: 'Windows desktop shortcut path (install action).' },
            message: { type: 'string', description: 'Human-readable outcome.' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: `[wsl_launcher] ${value.message}` }],
      },
      timeoutMs: 60_000,
      async execute(args) {
        const action = args?.action ?? 'status'
        const wslInfo = detectWsl()
        const distro = resolved.distro || wslInfo.distro || ''
        const base = { isWsl: wslInfo.isWsl, distro, url }
        try {
          if (action === 'install') {
          if (!wslInfo.isWsl) {
            return {
              ...base,
              running: false,
              scriptPath: '',
              shortcutPath: '',
              message: 'install is WSL-only: run dsh inside a WSL distribution',
            }
          }
          if (!distro) {
            return {
              ...base,
              running: false,
              scriptPath: '',
              shortcutPath: '',
              message:
                'WSL distribution name unknown; set `distro` in the wsl-launcher plugin config and retry',
            }
          }
          const { launcher, shortcut } = install()
          const status = await serverStatus(resolved.port)
          return {
            ...base,
            running: status.running,
            scriptPath: launcher.scriptPath,
            shortcutPath: shortcut.path,
            message: `launcher ${launcher.created ? 'created' : 'refreshed'} at ${launcher.scriptPath}; ` +
              `shortcut ${shortcut.created ? 'created' : 'refreshed'} at ${shortcut.path}`,
          }
        }
        if (action === 'open') {
          const status = await serverStatus(resolved.port)
          const opened = openInWindowsBrowser(url)
          if (opened.opened) {
            return {
              ...base,
              running: status.running,
              scriptPath: '',
              shortcutPath: '',
              message: status.running
                ? `opened ${url} in the default Windows browser`
                : `opened ${url} in the default Windows browser (note: the Web UI is not currently running)`,
            }
          }
          return {
            ...base,
            running: status.running,
            scriptPath: '',
            shortcutPath: '',
            message: `could not open a Windows browser (WSL interop disabled?); open ${url} manually`,
          }
        }
        if (action === 'stop') {
          if (!wslInfo.isWsl) {
            return {
              ...base,
              running: false,
              scriptPath: '',
              shortcutPath: '',
              message: 'stop is WSL-only: the launcher daemon only exists inside a WSL distribution',
            }
          }
          const result = await stopServer({ port: resolved.port, launcherDir: resolved.launcherDir })
          return {
            ...base,
            running: result.running,
            scriptPath: '',
            shortcutPath: '',
            message: result.stopped
              ? `stopped the background dsh web server (pid ${result.pid}); the WSL distribution powers down when it has no more processes`
              : result.running
                ? `a web server is still listening on port ${resolved.port}, but it was not started by the launcher (no live launcher pid file); stop it where it was started`
                : 'dsh web is not running (nothing to stop)',
          }
        }
        if (action === 'uninstall') {
          if (!wslInfo.isWsl) {
            return {
              ...base,
              running: false,
              scriptPath: '',
              shortcutPath: '',
              message: 'uninstall is WSL-only: run dsh inside a WSL distribution',
            }
          }
          const result = uninstallShortcut({
            linkName: resolved.linkName,
            launcherDir: resolved.launcherDir,
          })
          return {
            ...base,
            running: false,
            scriptPath: '',
            shortcutPath: result.removed ? 'removed' : 'absent',
            message: result.removed
              ? `removed desktop shortcut and launcher directory ${result.dir}`
              : `no desktop shortcut found; removed launcher directory ${result.dir}`,
          }
        }
        const status = await serverStatus(resolved.port)
        const dir = resolved.launcherDir || defaultLauncherDir()
        const scriptPath = join(dir, resolved.scriptName)
        const hasScript = existsSync(scriptPath)
        const interop = resolveWindowsExe('powershell.exe') !== null
        let daemonPid = null
        let daemonAlive = false
        try {
          const pidText = readFileSync(join(dir, `web-${resolved.port}.pid`), 'utf8').trim()
          if (/^[1-9]\d{0,9}$/.test(pidText)) {
            const pid = Number(pidText)
            try { process.kill(pid, 0); daemonPid = pid; daemonAlive = true } catch { /* stale pid file */ }
          }
        } catch { /* no pid file */ }
        return {
          ...base,
          running: status.running,
          scriptPath: hasScript ? scriptPath : '',
          shortcutPath: '',
          message:
            `${status.running ? 'dsh web is running' : 'dsh web is not running'} ` +
            `on port ${resolved.port}` +
            (daemonAlive ? ` (background daemon pid ${daemonPid})` : '') +
            `; launcher script ${hasScript ? `present at ${scriptPath}` : 'not installed'}; ` +
            `windows interop ${interop ? 'available' : 'NOT available'}` +
            `; launch mode ${resolved.launchMode}${resolved.launchMode === 'npx' ? ` (${resolved.npxPackage})` : ''}` +
            (resolved.autostopEnabled ? '; autostop ON (server stops when all browser tabs close)' : ''),
        }
          } catch (error) {
          return { ...base, running: false, scriptPath: '', shortcutPath: '', message: `wsl_launcher ${action} failed: ${String(error)}` }
        }
      },
    }),
  )

  // Web-only feature: shut the server down when every browser tab is
  // closed (opt-in via DSH_WEB_AUTOSTOP=1; see lib/autostop.js). A
  // non-web host simply skips it.
  const autostop = installAutostop(ctx, {
    enabled: resolved.autostopEnabled,
    graceMs: resolved.autostopGraceMs,
    minUptimeMs: resolved.autostopMinUptimeMs,
    logger,
  })
  if (autostop.installed) {
    logger.info(
      `dsh-wsl-launcher: web autostop enabled (grace ${resolved.autostopGraceMs}ms, ` +
      `min uptime ${resolved.autostopMinUptimeMs}ms) -- the server stops when all browser tabs close`,
    )
  }
}
