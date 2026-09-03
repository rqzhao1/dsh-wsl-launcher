/**
 * dsh-wsl-launcher — WSL-aware launcher generation and Windows-side helpers.
 *
 * Everything that touches the Windows side (creating / removing the desktop
 * .lnk, opening the default browser) goes through Windows interop binaries
 * (`powershell.exe`, `explorer.exe`) found on the PATH or under the /mnt
 * drive mounts. Everything that lives in WSL (the launcher script and the
 * icon it references) is plain files in the launcher directory.
 *
 * The generated bash template is pure ASCII and has no dependencies beyond
 * bash, the WSL interop, and the dsh CLI itself (port probing uses
 * bash /dev/tcp; the browser is opened through explorer.exe).
 * @module dsh-wsl-launcher/launcher
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  lstatSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {{ name: string, version: string }} */
const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
)

/** Path of the ASCII launcher template inside the package. */
const TEMPLATE_PATH = fileURLToPath(new URL('./template.sh.txt', import.meta.url))

/** Path of the whale .ico bundled with the package. */
const ICON_SOURCE = fileURLToPath(new URL('../icons/whale.ico', import.meta.url))


const MAX_PID = 2_147_483_647

export function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`port must be an integer between 1 and 65535, received ${String(port)}`)
  }
  return port
}

function validateWslValue(value, label, { required = false } = {}) {
  const text = String(value ?? '')
  if (!text && !required) return ''
  if (!text || /[\0-\x1f\x7f]/.test(text)) {
    throw new Error(`${label} contains unsupported characters`)
  }
  return text
}

function validateFileName(value, label) {
  const text = String(value ?? '')
  if (!text || text === '.' || text === '..' || /[\0-\x1f\x7f/\\]/.test(text)) {
    throw new Error(`${label} must be a single safe file name`)
  }
  return text
}

const EXACT_NPM_PACKAGE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*@v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/

export function validateLaunchMode(value) {
  if (value === 'installed' || value === 'npx') return value
  throw new Error(`launchMode must be "installed" or "npx", received ${String(value)}`)
}

export function validateNpxPackage(value) {
  const text = String(value ?? '')
  if (!EXACT_NPM_PACKAGE.test(text)) {
    throw new Error('npxPackage must be an exact npm package version, for example @deepseek-ai/dsh@0.1.1-rc.2')
  }
  return text
}

function validateLauncherDir(value) {
  const text = String(value ?? '')
  if (!text) return defaultLauncherDir()
  if (!isAbsolute(text) || /[\0\x00]/.test(text)) {
    throw new Error('launcherDir must be an absolute path')
  }
  return text
}

function atomicWrite(path, body, mode = 0o600) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, body, { encoding: 'utf8', mode })
    try { chmodSync(temporary, mode) } catch { /* 某些挂载文件系统不支持权限修改 */ }
    renameSync(temporary, path)
  } finally {
    try { rmSync(temporary, { force: true }) } catch { /* 临时文件清理失败不影响主结果 */ }
  }
}

function atomicCopy(source, target) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    copyFileSync(source, temporary)
    renameSync(temporary, target)
  } finally {
    try { rmSync(temporary, { force: true }) } catch { /* 临时文件清理失败不影响主结果 */ }
  }
}

function parsePid(value) {
  const text = String(value ?? '').trim()
  if (!/^[1-9][0-9]{0,9}$/.test(text)) return null
  const pid = Number(text)
  return Number.isSafeInteger(pid) && pid <= MAX_PID ? pid : null
}

/**
 * Read a file, returning null instead of throwing when it is absent.
 * @param {string} path
 * @returns {string | null}
 */
function readSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Render the WSL launcher template with concrete values.
 * @param {object} vars - port, url and the recorded dsh install path.
 * @returns the full .sh file content (pure ASCII).
 */
export function renderTemplate(vars) {
  let raw = readSafe(TEMPLATE_PATH)
  if (raw === null) throw new Error('launcher template missing from package: ' + TEMPLATE_PATH)
  validatePort(vars.port)
  const launchMode = validateLaunchMode(vars.launchMode ?? 'installed')
  const npxPackage = launchMode === 'npx' ? validateNpxPackage(vars.npxPackage) : ''
  raw = raw.replaceAll('__PORT__', String(vars.port))
  raw = raw.replaceAll('__URL__', String(vars.url))
  raw = raw.replaceAll('__DSH_BIN__', String(vars.dshBin || '').replaceAll("'", "'\"'\"'"))
  raw = raw.replaceAll('__LAUNCH_MODE__', launchMode)
  raw = raw.replaceAll('__NPX_PACKAGE__', npxPackage)
  raw = raw.replaceAll('__VERSION__', PKG.version)
  return raw
}

/**
 * Detect whether the current process runs inside WSL.
 * Primary signal is the kernel banner (`microsoft-standard-WSL1/2`); the
 * WSL_DISTRO_NAME / WSL_INTEROP environment variables are fallbacks for
 * launch paths where /proc is not readable.
 * @param {object} [options]
 * @param {string} [options.procVersion] - /proc/version override (tests).
 * @param {Record<string, string | undefined>} [options.env] - env override (tests).
 * @returns {{ isWsl: boolean, distro: string | null }}
 */
export function detectWsl({ procVersion, env = process.env } = {}) {
  const version = procVersion !== undefined ? procVersion : (readSafe('/proc/version') ?? '')
  const kernel = String(version).toLowerCase()
  const distro = validateWslValue(typeof env.WSL_DISTRO_NAME === 'string' ? env.WSL_DISTRO_NAME.trim() : '', 'WSL distribution')
  const interop = typeof env.WSL_INTEROP === 'string' ? env.WSL_INTEROP.trim() : ''
  const isWsl = kernel.includes('microsoft') || kernel.includes('wsl') || distro !== '' || interop !== ''
  return { isWsl, distro: distro || null }
}

/** Windows-side fallback locations for the interop executables we may need. */
const KNOWN_WINDOWS_EXES = {
  'powershell.exe': ['Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'],
  'explorer.exe': ['Windows', 'explorer.exe'],
  'cmd.exe': ['Windows', 'System32', 'cmd.exe'],
}

/**
 * Find a Windows interop executable from WSL: PATH first, then the
 * well-known locations under each /mnt drive mount.
 * @param {'powershell.exe' | 'explorer.exe' | 'cmd.exe'} name
 * @returns the absolute path (WSL side), or null when interop is unavailable.
 */
export function resolveWindowsExe(name) {
  if (process.platform !== 'linux') return null
  const rel = KNOWN_WINDOWS_EXES[name]
  if (!rel) return null
  const pathDirs = String(process.env.PATH || '').split(':').filter(Boolean)
  for (const dir of pathDirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  let mounts = []
  try {
    mounts = readdirSync('/mnt')
  } catch {
    return null
  }
  for (const mount of mounts) {
    const candidate = join('/mnt', mount, ...rel)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Build the argument string for wsl.exe that boots the launcher script.
 * Tokens containing whitespace or quotes are double-quoted (the .lnk
 * Arguments field is a Windows command line that wsl.exe parses itself).
 * @param {object} options
 * @param {string} options.distro - WSL distribution name (`wsl -l -v` name).
 * @param {string} [options.user] - WSL user to run as (wsl --user); '' = default.
 * @param {string} options.scriptPath - WSL absolute path of the launcher .sh.
 * @param {number} options.port - Web UI port.
 * @returns the Arguments string for the .lnk.
 */
export function buildWslArguments({ distro, user, scriptPath, port }) {
  validatePort(port)
  const safeDistro = validateWslValue(distro, 'WSL distribution', { required: true })
  const safeUser = validateWslValue(user, 'WSL user')
  const safeScriptPath = String(scriptPath ?? '')
  if (!safeScriptPath.startsWith('/') || /[\0-\x1f\x7f]/.test(safeScriptPath)) throw new Error('scriptPath must be a WSL absolute path')
  const tokens = ['-d', safeDistro]
  if (safeUser) tokens.push('--user', safeUser)
  tokens.push('--exec', '/bin/bash', safeScriptPath, '--port', String(port))
  return tokens.map((t) => (/[\s"']/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t)).join(' ')
}

/**
 * Build the hidden-console VBScript wrapper the desktop shortcut runs.
 * `wscript.exe` never allocates a visible console, so double-clicking the
 * shortcut behaves like a normal program: the Web UI page opens and no
 * terminal window appears. The wsl.exe child (hidden console, window
 * style 0) boots the bash launcher, which starts the server detached.
 * @param {object} options
 * @param {string} options.distro - WSL distribution name (`wsl -l -v` name).
 * @param {string} [options.wslUser] - WSL user to run as (wsl --user); '' = default.
 * @param {string} options.scriptPath - WSL absolute path of the launcher .sh.
 * @param {number} options.port - Web UI port.
 * @returns the .vbs content lines (pure ASCII).
 */
export function buildVbsContent({ distro, wslUser, scriptPath, port }) {
  const wslArgs = buildWslArguments({ distro, user: wslUser || '', scriptPath, port })
  // VBScript string-literal escaping: double any embedded quote.
  const run = `wsl.exe ${wslArgs}`.replace(/"/g, '""')
  return [
    "' DeepSeek Harness Web launcher (hidden console wrapper)",
    `' Generated by dsh-wsl-launcher v${PKG.version} -- do not edit by hand.`,
    "' Double-clicking the desktop shortcut runs the WSL launcher script in a",
    "' hidden console, so no terminal window appears: the Web UI page just opens.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "${run}", 0, False`,
  ]
}

/**
 * Build Windows icon-location candidates (UNC paths into the WSL file
 * system) for a WSL-side icon file. wsl.localhost is the modern mapping;
 * wsl$ is the legacy fallback.
 * @param {object} options
 * @param {string} options.distro - WSL distribution name.
 * @param {string | null} options.iconWslPath - WSL absolute icon path.
 * @returns {string[]} icon candidates (no `,index` suffix).
 */
export function buildIconCandidates({ distro, iconWslPath }) {
  if (!distro || !iconWslPath) return []
  const win = String(iconWslPath).replace(/\//g, '\\')
  return [`\\\\wsl.localhost\\${distro}${win}`, `\\\\wsl$\\${distro}${win}`]
}

/**
 * Quote a value as a PowerShell single-quoted string.
 * @param {string} s
 * @returns the quoted PowerShell literal.
 */
export function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/**
 * PowerShell statements that resolve the candidate desktop directories.
 *
 * IMPORTANT (regression guard): the candidates are pre-assigned to variables
 * and the array literal references the variables only. Some Windows
 * PowerShell 5.1 builds mis-parse inline string-concatenation expressions
 * inside @(...) array literals: the comma between expressions is dropped and
 * the elements collapse into a single string. Verified on Windows 11 build
 * 26100 / PS 5.1.26100 (zh-CN), both via -Command and -File, 2026-08. Plain
 * variable references (and plain string literals) inside the array literal
 * parse reliably.
 * @returns the candidate-list statements.
 */
export function desktopCandidateStatements() {
  return [
    "$c1=$env:USERPROFILE+'\\Desktop'",
    "$c2=$env:OneDrive+'\\Desktop'",
    "$c3=$env:USERPROFILE+'\\OneDrive\\Desktop'",
    '$cands=@($c1, $c2, $c3)',
  ]
}

/**
 * Build the PowerShell command that (re)creates the desktop .lnk. The
 * command first writes the hidden-console VBScript wrapper into the
 * Windows user home (`$env:USERPROFILE\.dsh-wsl-launcher\dsh-web-launcher.vbs`),
 * then points the .lnk at `wscript.exe //B <vbs>` so no console window
 * ever appears. The desktop directory is resolved on the Windows side
 * (OneDrive-managed desktops included). Icon strategy: the .ico is first
 * COPIED to a local Windows path (`$wdir\whale.ico`) and the .lnk points
 * there -- a local icon always resolves, even while the WSL distro is
 * stopped (UNC icon references break, and Explorer caches the broken
 * state). Only when the copy fails does it fall back to the UNC
 * candidate that actually resolves. The final line prints
 * `CREATED <path>` or `REFRESHED <path>` for the caller to parse.
 * @param {object} options
 * @param {string} options.linkName - shortcut file name on the desktop.
 * @param {string[]} options.vbsLines - hidden-console wrapper content (see {@link buildVbsContent}).
 * @param {string[]} options.iconCandidates - UNC icon candidates (may be empty).
 * @param {string} options.description - shortcut tooltip text.
 * @returns the PowerShell command line.
 */
export function buildPowerShellCommand({ linkName, vbsLines, iconCandidates, description }) {
  // Local-first icon: copy the .ico into the Windows wrapper directory so
  // the shortcut keeps its icon even when the distro is stopped.
  const iconLines =
    iconCandidates && iconCandidates.length
      ? [
          "$iconLocal=Join-Path $wdir 'whale.ico'",
          `$iconSources=@(${iconCandidates.map(psQuote).join(', ')})`,
          '$iconSet=$false',
          "foreach ($i in $iconSources) { if (Test-Path -LiteralPath $i) { try { Copy-Item -LiteralPath $i -Destination $iconLocal -Force; $s.IconLocation=$iconLocal+',0'; $iconSet=$true; break } catch { } } }",
          "if (-not $iconSet) { foreach ($i in $iconSources) { if (Test-Path -LiteralPath $i) { $s.IconLocation=$i+',0'; break } } }",
        ]
      : []
  return [
    "$ErrorActionPreference='Stop'",
    ...desktopCandidateStatements(),
    "$desktop=$null",
    'foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { $desktop=$c; break } }',
    "if (-not $desktop) { $desktop=$c1; New-Item -ItemType Directory -Path $desktop -Force | Out-Null }",
    // Hidden-console wrapper (Windows side, off the WSL filesystem so it
    // survives the distro being stopped).
    "$wdir=$env:USERPROFILE+'\\.dsh-wsl-launcher'",
    'if (-not (Test-Path -LiteralPath $wdir)) { New-Item -ItemType Directory -Path $wdir -Force | Out-Null }',
    "$vbs=Join-Path $wdir 'dsh-web-launcher.vbs'",
    `$vbsLines=@(${vbsLines.map(psQuote).join(', ')})`,
    'Set-Content -LiteralPath $vbs -Value ($vbsLines -join "`r`n") -Encoding ASCII',
    `$link=Join-Path $desktop ${psQuote(linkName)}`,
    '$existed=Test-Path -LiteralPath $link',
    '$w=New-Object -ComObject WScript.Shell',
    '$s=$w.CreateShortcut($link)',
    // wscript.exe (never a visible console) runs the hidden wrapper.
    "$s.TargetPath=(Join-Path $env:WINDIR 'System32\\wscript.exe')",
    "$s.Arguments='//B ' + $vbs",
    `$s.Description=${psQuote(description)}`,
    '$s.WorkingDirectory=$desktop',
    ...iconLines,
    '$s.Save()',
    "if ($existed) { Write-Output ('REFRESHED ' + $link) } else { Write-Output ('CREATED ' + $link) }",
  ]
    .filter(Boolean)
    .join('; ')
}

/**
 * Build the PowerShell command that removes the desktop .lnk if present
 * and the Windows-side hidden-console wrapper directory.
 * @param {object} options
 * @param {string} options.linkName - shortcut file name on the desktop.
 * @returns the PowerShell command line.
 */
export function buildPowerShellRemoveCommand({ linkName }) {
  return [
    "$ErrorActionPreference='Stop'",
    ...desktopCandidateStatements(),
    "$desktop=$null",
    'foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { $desktop=$c; break } }',
    `if ($desktop) { $link=Join-Path $desktop ${psQuote(linkName)}; if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link; Write-Output ('REMOVED ' + $link) } else { Write-Output 'ABSENT' } } else { Write-Output 'NO-DESKTOP' }`,
    "$wdir=$env:USERPROFILE+'\\.dsh-wsl-launcher'",
    'if (Test-Path -LiteralPath $wdir) { Remove-Item -LiteralPath $wdir -Recurse -Force }',
  ].join('; ')
}

/**
 * Run a PowerShell command through WSL interop.
 * @param {string} command - the -Command payload.
 * @param {object} [options]
 * @param {string} [options.powershellPath] - resolved powershell.exe path.
 * @param {number} [options.timeoutMs] - hard timeout (default 30s).
 * @returns {{ ok: boolean, status: number | null, stdout: string, stderr: string }}
 */
export function runPowerShell(command, { powershellPath, timeoutMs = 30_000 } = {}) {
  const ps = powershellPath || resolveWindowsExe('powershell.exe')
  if (!ps) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: 'powershell.exe not found (WSL interop disabled or no Windows drive mounted)',
    }
  }
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    return { ok: false, status: null, stdout: '', stderr: String(result.error.message || result.error) }
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

/**
 * Default launcher directory (kept inside DSH's home, off the desktop).
 * @returns the default launcher directory.
 */
export function defaultLauncherDir() {
  return join(homedir(), '.dsh', 'dsh-wsl-launcher')
}

/**
 * Write (or refresh) the WSL launcher script and the bundled icon into the
 * launcher directory.
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.dshBin] - recorded dsh install path (fallback).
 * @param {string} [options.launcherDir] - target dir (default: ~/.dsh/dsh-wsl-launcher).
 * @param {string} [options.scriptName] - launcher file name.
 * @param {boolean} [options.withIcon] - copy the whale icon (default true).
 * @returns {{ created: boolean, dir: string, scriptPath: string, iconPath: string | null }}
 */
export function ensureLauncher({ port, dshBin, launcherDir, scriptName, withIcon, launchMode = 'installed', npxPackage }) {
  validatePort(port)
  const dir = validateLauncherDir(launcherDir)
  const safeScriptName = validateFileName(scriptName || 'dsh-web-launcher.sh', 'scriptName')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { if (lstatSync(dir).isSymbolicLink()) throw new Error(`launcherDir must not be a symbolic link: ${dir}`) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const scriptPath = join(dir, safeScriptName)
  const existing = existsSync(scriptPath) ? lstatSync(scriptPath) : null
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`launcher script is not a regular file: ${scriptPath}`)
  const created = existing === null
  atomicWrite(scriptPath, renderTemplate({ port, url: `http://127.0.0.1:${port}`, dshBin, launchMode, npxPackage }), 0o600)
  try {
    chmodSync(scriptPath, 0o755)
    if ((statSync(scriptPath).mode & 0o777) !== 0o755) throw new Error(`unable to set launcher permissions: ${scriptPath}`)
  } catch {
    /* non-writable mount or exotic fs: the script is run via `bash <file>` anyway */
  }
  let iconPath = null
  if (withIcon !== false) {
    const iconsDir = join(dir, 'icons')
    mkdirSync(iconsDir, { recursive: true, mode: 0o700 })
    iconPath = join(iconsDir, 'whale.ico')
    if (existsSync(ICON_SOURCE)) atomicCopy(ICON_SOURCE, iconPath)
  }
  return { created, dir, scriptPath, iconPath }
}

/**
 * Resolve a usable absolute path to the dsh CLI for the recorded fallback.
 * Order: the running dsh's own entry, the PATH, common global locations,
 * then nvm installs (newest first). Returns '' when nothing is found.
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [argv1] - process.argv[1] override (tests).
 * @returns {string} the resolved path, or '' when not found.
 */
export function resolveDshBin(env = process.env, argv1 = process.argv[1]) {
  const candidates = []
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0) candidates.push(p)
  }
  try {
    if (argv1) push(realpathSync(argv1))
  } catch {
    /* argv1 not resolvable */
  }
  for (const dir of String(env.PATH || '').split(':').filter(Boolean)) push(join(dir, 'dsh'))
  for (const dir of [env.PNPM_HOME, env.XDG_BIN_HOME, env.VOLTA_HOME && join(env.VOLTA_HOME, 'bin'), join(env.HOME || homedir(), '.volta', 'bin')].filter(Boolean)) push(join(dir, 'dsh'))
  const home = env.HOME || homedir()
  push(join(home, '.npm-global', 'bin', 'dsh'))
  push(join(home, '.local', 'bin', 'dsh'))
  push(join(home, '.local', 'share', 'pnpm', 'dsh'))
  push(join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'dsh'))
  push(join(home, '.local', 'share', 'mise', 'shims', 'dsh'))
  push('/usr/local/bin/dsh')
  push('/usr/bin/dsh')
  const versionRoots = [
    [join(home, '.nvm', 'versions', 'node'), ['bin']],
    [join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin']],
    [join(home, '.local', 'share', 'mise', 'installs', 'node'), ['bin']],
  ]
  for (const [root, suffix] of versionRoots) {
    let versions = []
    try { versions = readdirSync(root) } catch { continue }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) push(join(root, version, ...suffix, 'dsh'))
  }
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) {
        const mode = statSync(c).mode
        if (process.platform !== 'linux' || (mode & 0o111) !== 0) return realpathSync(c)
      }
    } catch {
      /* keep looking */
    }
  }
  return ''
}

/**
 * Create (or refresh) the Windows desktop shortcut through WSL interop.
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.distro - WSL distribution name (required).
 * @param {string} [options.wslUser] - WSL user for the shortcut (wsl --user).
 * @param {string} [options.linkName] - shortcut file name.
 * @param {string} [options.launcherDir]
 * @param {string} [options.scriptName]
 * @param {boolean} [options.withIcon]
 * @param {string} [options.powershellPath]
 * @returns {{ created: boolean, path: string }}
 * @throws when the launcher script is missing, the distro is unknown, or
 *   PowerShell reports a failure.
 */
export function ensureShortcut({
  port,
  distro,
  wslUser,
  linkName,
  launcherDir,
  scriptName,
  withIcon,
  powershellPath,
}) {
  const dir = launcherDir || defaultLauncherDir()
  const scriptPath = join(dir, scriptName)
  if (!existsSync(scriptPath)) {
    throw new Error(`launcher script missing: ${scriptPath} (run install first)`)
  }
  if (!distro) {
    throw new Error('WSL distribution name unknown (set `distro` in the plugin config)')
  }
  const iconPath = join(dir, 'icons', 'whale.ico')
  const iconCandidates =
    withIcon === false ? [] : buildIconCandidates({ distro, iconWslPath: existsSync(iconPath) ? iconPath : null })
  const command = buildPowerShellCommand({
    linkName,
    vbsLines: buildVbsContent({ distro, wslUser, scriptPath, port }),
    iconCandidates,
    description: 'Start DeepSeek Harness Web in WSL (background, no console window)',
  })
  const result = runPowerShell(command, { powershellPath })
  if (!result.ok) {
    throw new Error(
      `shortcut creation failed: ${result.stderr.trim() || `powershell exit ${result.status}`}`,
    )
  }
  const createdMatch = result.stdout.match(/CREATED[ \t]+(.+)/)
  const refreshedMatch = result.stdout.match(/REFRESHED[ \t]+(.+)/)
  const marker = createdMatch || refreshedMatch
  if (!marker) {
    throw new Error(`shortcut creation: unexpected PowerShell output: ${result.stdout.trim()}`)
  }
  return { created: Boolean(createdMatch), path: marker[1].trim() }
}

/**
 * Remove the desktop shortcut (Windows side) and the whole launcher
 * directory (WSL side).
 * @param {object} options
 * @param {string} [options.linkName]
 * @param {string} [options.launcherDir]
 * @param {string} [options.powershellPath]
 * @returns {{ removed: boolean, dir: string }}
 * @throws when PowerShell cannot run or reports an error.
 */
export function uninstallShortcut({ linkName, launcherDir, powershellPath }) {
  const result = runPowerShell(buildPowerShellRemoveCommand({ linkName }), { powershellPath })
  if (!result.ok) {
    throw new Error(
      `shortcut removal failed: ${result.stderr.trim() || `powershell exit ${result.status}`}`,
    )
  }
  const removed = /^REMOVED[ \t]/m.test(result.stdout)
  const absent = /^(?:ABSENT|NO-DESKTOP)(?:[ \t]|\r?$)/m.test(result.stdout)
  if (!removed && !absent) {
    throw new Error(`shortcut removal: unexpected PowerShell output: ${result.stdout.trim()}`)
  }
  const dir = launcherDir || defaultLauncherDir()
  rmSync(dir, { recursive: true, force: true })
  return { removed, dir }
}

/**
 * Whether a pid (Linux) looks like the dsh web daemon, to avoid killing an
 * unrelated process that happens to reuse a stale pid file number.
 * @param {number} pid
 * @returns true when /proc/<pid>/cmdline mentions dsh + web.
 */
function processGroup(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').match(/^\d+ \(.*\) \S+ (\d+) (\d+) (\d+)/)
    return fields === null ? null : { pgrp: Number(fields[2]), session: Number(fields[3]) }
  } catch {
    return null
  }
}

function looksLikeDshWeb(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
    return /dsh(?:[\s/-]|$)/.test(cmdline) && /web(?:[\s/-]|$)/.test(cmdline)
  } catch {
    return false
  }
}

function isControlledDshWeb(pid) {
  const group = processGroup(pid)
  return group !== null && group.pgrp === pid && group.session === pid && looksLikeDshWeb(pid)
}

/**
 * Stop the background `dsh web` daemon started by the launcher script.
 * The daemon's pid lives in `<launcherDir>/web-<port>.pid`; it is killed
 * as a whole process group first (the daemon is a setsid session leader),
 * then the process itself, and the port is polled until it closes. A pid
 * file whose process is gone (or is not a dsh web process) is treated as
 * stale and removed; servers started outside the launcher are never
 * touched.
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.launcherDir]
 * @param {number} [options.timeoutMs] - how long to wait for the port to close (default 15s).
 * @returns {Promise<{ stopped: boolean, pid: number | null, running: boolean }>}
 */
export async function stopServer({ port, launcherDir, timeoutMs = 15_000 }) {
  validatePort(port)
  const dir = validateLauncherDir(launcherDir)
  const pidFile = join(dir, `web-${port}.pid`)
  let pid = null
  try {
    pid = parsePid(readFileSync(pidFile, 'utf8'))
  } catch {
    /* no pid file */
  }
  let stopped = false
  if (pid !== null) {
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const dropPidFile = () => {
      try {
        rmSync(pidFile, { force: true })
      } catch {
        /* best effort */
      }
    }
    if (!alive()) {
      // Daemon already gone: just clean up its pid file.
      dropPidFile()
    } else if (!looksLikeDshWeb(pid)) {
      dropPidFile()
      pid = null
    } else {
      const group = processGroup(pid)
      try {
        if (group?.pgrp === pid && group.session === pid) process.kill(-pid, 'SIGTERM')
        else process.kill(pid, 'SIGTERM')
      } catch {
        dropPidFile()
        pid = null
      }
      const deadline = Date.now() + timeoutMs
      while (alive() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (pid !== null && alive() && looksLikeDshWeb(pid)) {
        try {
          const group = processGroup(pid)
          if (group?.pgrp === pid && group.session === pid) process.kill(-pid, 'SIGKILL')
          else process.kill(pid, 'SIGKILL')
        } catch { /* 进程可能已结束。 */ }
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      dropPidFile()
      stopped = true
    }
  }
  const status = await serverStatus(port)
  return { stopped, pid, running: status.running }
}

/**
 * Probe whether a Web server responds on the given local port.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<{ running: boolean, httpStatus: number | null }>}
 */
export async function serverStatus(port, timeoutMs = 1500) {
  validatePort(port)
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { running: true, httpStatus: res.status }
  } catch {
    return { running: false, httpStatus: null }
  }
}

/**
 * Open a URL in the Windows default browser through WSL interop.
 * Tries, in order: `explorer.exe <url>`, PowerShell `Start-Process`
 * (works where explorer.exe does not, e.g. containerized WSL), then
 * `cmd.exe /c start <url>`.
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.explorerPath]
 * @param {string} [options.powershellPath]
 * @returns {{ opened: boolean, via: string | null }}
 */
export function openInWindowsBrowser(url, { explorerPath, powershellPath } = {}) {
  // 1) explorer.exe <url> — the usual WSL interop path.
  const exe = explorerPath || resolveWindowsExe('explorer.exe')
  if (exe) {
    const child = spawnSync(exe, [url], { stdio: 'ignore', timeout: 20_000 })
    if (!child.error && child.status === 0) return { opened: true, via: 'explorer.exe' }
  }
  // 2) PowerShell Start-Process — works where explorer.exe does not (e.g.
  //    containerized WSL, where explorer.exe exits 1).
  const ps = powershellPath || resolveWindowsExe('powershell.exe')
  if (ps) {
    const r = runPowerShell(
      `try { Start-Process ${psQuote(url)}; 'BROWSER_OK' } catch { 'BROWSER_FAIL: ' + $_.Exception.Message }`,
      { powershellPath: ps },
    )
    if (r.ok && r.stdout.includes('BROWSER_OK')) return { opened: true, via: 'powershell.exe' }
  }
  // 3) cmd.exe /c start — classic fallback.
  const cmd = resolveWindowsExe('cmd.exe')
  if (cmd) {
    const child = spawnSync(cmd, ['/c', 'start', '', url], { stdio: 'ignore', timeout: 20_000 })
    if (!child.error && child.status === 0) return { opened: true, via: 'cmd.exe' }
  }
  return { opened: false, via: null }
}
