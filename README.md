# dsh-wsl-launcher

**One double-click entry point to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI — for when `dsh` lives inside WSL.**

[中文文档](README.zh.md)

You run `dsh web` inside a WSL distribution, but your mouse is on Windows.
Every time you open the UI you perform the same ritual:

```
open Windows terminal  →  wsl  →  dsh web  →  wait for boot  →  switch to browser  →  type the URL  →  Enter
```

This plugin deletes the ritual. After installing it, your **Windows desktop** hosts an
app-style shortcut (black-whale icon). Double-click it and:

1. `wsl.exe -d <your-distro> --exec /bin/bash <launcher.sh>` boots — no Windows terminal needed;
2. the launcher finds `dsh` (PATH → login shell → recorded install path),
3. if the Web UI port already listens it **just opens the browser** (idempotent — double-click it ten times, nothing breaks),
4. otherwise it starts `dsh web --port 3080` as a detached background daemon, polls the port until ready, then opens your default Windows browser; the console can close without stopping the server.

It also registers a `wsl_launcher` model tool, so any agent in a session can
`install` / `status` / `open` / `uninstall` the launcher itself.

---

## ✅ Compatibility

| | |
|---|---|
| dsh | Verified on `0.1.1-rc.2` (unit tests + scratch-profile composition via `dsh plugin add` / `--dump-config`) |
| Node | `>=20` (as declared in `engines`) |
| Host | WSL1/WSL2 on Windows 10 1607+ / Windows 11 with **interop enabled** (the default) and a Windows drive mounted under `/mnt/<drive>` |
| dsh location | anywhere in the distro: `npm -g`, nvm, local checkout — the launcher resolves it at runtime |
| Last verified | 2026-08-28 (WSL2, Ubuntu 24.04, dsh `0.1.1-rc.2`, Node 24) |

## 📦 Install / Upgrade / Uninstall

Requires a `dsh` profile (e.g. the `web` profile where you run `dsh web`).

**Install**

```sh
# from npm (once published)
dsh plugin --profile web add dsh-wsl-launcher

# or straight from GitHub (monorepo sub-path)
dsh plugin --profile web add github:Small-tailqwq/dsh-deep-whale#path:/wsl-launcher

# or from a local checkout / tarball
dsh plugin --profile web add /path/to/dsh-wsl-launcher
dsh plugin --profile web add /path/to/dsh-wsl-launcher-0.1.0.tgz
```

`dsh plugin` uses the package's `dsh.bundle` manifest to register it as a bundle
layer automatically — **no manual `cordis.patch.yml` edits**.

**Upgrade / Uninstall**

```sh
dsh plugin --profile web update dsh-wsl-launcher
dsh plugin --profile web remove dsh-wsl-launcher
```

Then restart `dsh web`. On activation with `autoInstall: true` (the default) the
plugin (re)creates the launcher files and the desktop shortcut. Uninstalling the
package does not remove your shortcut — use `wsl_launcher` with action
`uninstall` (or the manual steps below) to clean up.

## 🚀 Quick start

1. Install the plugin (see above) and restart `dsh web`.
2. Look at your Windows desktop: **DeepSeek Harness Web** (whale icon).
3. Double-click it → first run boots `dsh web` and opens the browser; later runs
   just open the browser if the server is already up.
4. Reproducible check: ask any agent in a session to call `wsl_launcher` with
   action `status` — expect `isWsl: true`, `distro: "<your distro>"`,
   `running: true` and the URL `http://127.0.0.1:3080`. Use `wsl_launcher` action `stop` to stop only the daemon recorded by this launcher.

> **WSL2 note:** the server listens on `127.0.0.1` inside WSL; WSL's
> localhost forwarding makes it reachable from the Windows browser at the same
> URL — no `--host` flag needed.

## 🤖 wsl_launcher tool

| Action | Effect |
|---|---|
| `install` | (Re)create the launcher script + icon in `~/.dsh/dsh-wsl-launcher` and the whale-icon desktop shortcut (WSL only) |
| `status` | WSL detection, distribution, interop availability, launcher files, and whether the Web UI port is listening (any platform) |
| `stop` | Stop only a live `dsh web` daemon whose PID and command identity match this launcher; never take over another process |
| `open` | Open the Web UI in the default Windows browser (WSL interop) |
| `uninstall` | Remove the desktop shortcut and the whole `~/.dsh/dsh-wsl-launcher` directory (WSL only) | safe to repeat; it only removes launcher-owned files |

## ⚙️ Configuration

Override the plugin row in your profile's `cordis.patch.yml`
(e.g. `~/.dsh/profiles/web/cordis.patch.yml`). A patch replaces the whole row
config, so restate the keys you keep:

```yaml
- id: wsl-launcher
  config:
    autoInstall: true            # create/refresh launcher + shortcut on activation (default true)
    port: 3080                   # Web UI port (default 3080)
    distro: ""                   # WSL distro name; empty = auto (WSL_DISTRO_NAME)
    wslUser: ""                  # WSL user for the shortcut (wsl --user); empty = distro default
    linkName: "DeepSeek Harness Web.lnk"   # shortcut file name on the desktop
    launcherDir: ""              # launcher folder; empty = ~/.dsh/dsh-wsl-launcher
    scriptName: dsh-web-launcher.sh        # launcher file name
    withIcon: true               # copy the whale icon + apply it to the shortcut
  autostopEnabled: false        # opt-in: stop the daemon after all browser tabs close
  autostopGraceMs: 30000       # idle grace period in milliseconds
  autostopMinUptimeMs: 45000   # startup protection in milliseconds
```

### Launch strategy

`launchMode: installed` is the default. The launcher resolves an already installed `dsh` binary (PATH, login shell, common Node manager paths, then the recorded path) and does not contact npm.

For a disposable or `npx`-only setup, opt in explicitly and pin the exact package version:

```yaml
- id: wsl-launcher
  config:
    launchMode: npx
    npxPackage: "@deepseek-ai/dsh@0.1.1-rc.2"
```

This generates `npx --yes @deepseek-ai/dsh@0.1.1-rc.2 web --port 3080 --no-open`. The package field accepts only one exact npm package/version specifier: no omitted version, `latest`, semver range, whitespace, or shell syntax. `npx` mode is never used as an automatic fallback. Node.js and `npx` must be available to the non-interactive WSL launcher; the first run needs npm-registry network access and may download the pinned package.

No secrets are involved.

## 🔐 Permissions & data

| Area | What the plugin does |
|---|---|
| Files written (WSL side) | `~/.dsh/dsh-wsl-launcher/dsh-web-launcher.sh` and `~/.dsh/dsh-wsl-launcher/icons/whale.ico` |
| Files written (Windows side) | One `.lnk` on your desktop (`DeepSeek Harness Web.lnk`) — created by `powershell.exe` (WScript.Shell), no other Windows files touched |
| Files read | Only its own template and icon inside the package, plus `/proc/version` for WSL detection |
| Processes | Spawns `powershell.exe` (shortcut create/remove, browser fallback) and `explorer.exe` / `cmd.exe` (open browser) through WSL interop; the launcher itself is an ASCII bash script you can read before it runs |
| Network | Loopback only: probes `http://127.0.0.1:<port>` for status; the browser is opened by the OS, not by the plugin |
| Credentials | None — never reads, stores, or sends credentials |

## 🔧 How it works

```
┌──────────────────────────────┐   ┌────────────────────────────────────────────┐
│  DeepSeek Harness Web        │──▶│  wsl.exe -d <distro> --exec /bin/bash      │
│  (Windows desktop .lnk,      │   │      ~/.dsh/dsh-wsl-launcher/              │
│  whale .ico via \\wsl.…)     │   │      dsh-web-launcher.sh --port 3080       │
└──────────────────────────────┘   └────────────────────┬───────────────────────┘
                                                        │ (inside WSL)
                        ┌───────────────────────────────┼─────────────────────────┐
                        ▼                               ▼                         ▼
                  where is dsh?                port 3080 listening?      start `dsh web --port 3080`
        (PATH → login shell →          (open Windows browser,          (console = server window;
         recorded install path)         exit 0 — idempotent)            poll /dev/tcp → explorer.exe)
```

- **`cordis.patch.yml`** — the bundle patch: one loader row (`id: wsl-launcher`,
  `name: dsh-wsl-launcher`); `dsh plugin add` reconciles it into the profile's
  bundle stack from the `dsh.bundle` manifest.
- **`lib/launcher.js`** — WSL detection (kernel banner + `WSL_DISTRO_NAME` /
  `WSL_INTEROP` fallbacks), launcher template rendering (pure ASCII),
  `wsl.exe` argument building with command-line quoting, Windows icon
  candidates (`\\wsl.localhost\<distro>\…` first, `\\wsl$\…` fallback), and the
  PowerShell builders for shortcut create/remove. All PowerShell string values
  are single-quoted with `''` escaping.
- **`lib/index.js`** — the Cordis plugin (`name: 'wsl-launcher'`,
  `inject: ['tools']`, zod `Config` schema) plus the `wsl_launcher` tool via
  `@deepseek-ai/dsh-tools` `defineTool`.
- **`lib/template.sh.txt`** — the generated launcher: resolves `dsh` (PATH →
  `bash -ic` login shell (covers nvm) → recorded absolute path), probes the port
  with bash `/dev/tcp` (no curl/netcat), opens the browser via `explorer.exe`,
  falling back to PowerShell `Start-Process` and then `cmd.exe /c start`
  (needed on some WSL setups, e.g. containerized WSL, where `explorer.exe`
  exits without opening a browser), and ties the console window's lifetime to
  the server (`trap` on EXIT/INT/TERM).
- **`icons/whale.ico`** — multi-size whale icon; at install time it is copied
  into the launcher directory so Windows can reach it through the
  `\\wsl.localhost` mapping for the `.lnk` icon.

## 🩺 Troubleshooting

| Symptom | Cause & fix |
|---|---|
| No shortcut after restart | Check `dsh web` logs for a `dsh-wsl-launcher: auto install skipped: …` warning. Usually WSL interop is disabled: set `interop = true` under `[boot]` in `C:\Users\<you>\.wslconfig` (or wsl.conf), restart the distro, then retry `wsl_launcher install`. |
| `powershell.exe not found` in tool output | Same as above — interop disabled or no Windows drive mounted under `/mnt`. |
| Shortcut appears but with a generic icon | The `\\wsl.localhost` mapping may be missing (older Windows). The plugin falls back to `\\wsl$`; if that is gone too the shortcut still works, iconless. Update Windows or set `withIcon: false` to silence the probe. |
| Desktop icon lands in the wrong place | OneDrive-managed desktops: the shortcut targets `%USERPROFILE%\Desktop`, `%OneDrive%\Desktop` or `%USERPROFILE%\OneDrive\Desktop` in that order — the first existing one wins, same as Explorer sees it. |
| Launcher says `dsh was not found` | In the default `installed` mode, `dsh` is not reachable from a non-interactive shell. Install it in the distro (`npm install -g @deepseek-ai/dsh`); if you use nvm, the login-shell probe finds it — or set the recorded path by reinstalling the plugin from the same environment. Alternatively configure explicit, version-pinned `launchMode: npx`. |
| Launcher says `npx was not found` | `launchMode: npx` requires Node.js with `npx` available in the non-interactive WSL environment. Install Node.js/npm or set `NPX_BIN` to an executable `npx` path; keep `npxPackage` an exact pinned version. |
| Launcher says `dsh web exited early` | Read the console output above the error (profile/CLI problem, not a launcher bug). |
| `EADDRINUSE` / port already bound | The launcher detects any listening service and opens the browser instead; it never kills or replaces an unrelated service. Use another `port` in the config if needed. |
| Server stops after the launcher window closes | Current versions use a detached daemon. Use `wsl_launcher stop` or the generated script's `stop` action; an autostop-enabled daemon stops after its browser presence grace period. |
| Autostop endpoints reject requests | The browser client sends same-origin JSON POST requests. Requests with another origin, wrong method, missing JSON content type, malformed JSON, or invalid client ids are rejected. |
| Uninstall says the shortcut is absent | This is an idempotent success state. The Windows shortcut and wrapper are removed when present, and the WSL launcher directory is removed. |
| Browser opens but the page shows a transport/403 error | The **browser-trust fence** rejected a cross-origin call to the local API — open DevTools → Network → the failed request → check its `Origin`; it must be `http://127.0.0.1:<port>`. A browser extension or leftover tab is the usual culprit. |
| No browser window appears | The launcher selects one Windows interop opener: `explorer.exe` when available, otherwise PowerShell `Start-Process` or `cmd.exe /c start`; it never chains launchers after an attempt, preventing duplicate tabs. If none is available it prints the URL. If none works in your WSL setup, check WSL interop; the printed URL is always shown in the console as a last resort. |
| Shortcut boots the wrong distro / user | The `.lnk` encodes `wsl.exe -d <distro> [--user <name>]`. Set `distro` / `wslUser` in the config, then `wsl_launcher install`. |
| Closing the console mid-session | The normal launcher starts a detached daemon, so closing the console does not stop it. Use `wsl_launcher stop`; foreground mode remains available for debugging. |

**Rollback**: `dsh plugin --profile web remove dsh-wsl-launcher`, then
`wsl_launcher` with action `uninstall` (removes the `.lnk` and
`~/.dsh/dsh-wsl-launcher`). Nothing else is left behind.

## 🛠️ Development

- **No build step** — plain ESM JavaScript in `lib/`; zero runtime dependencies
  beyond the dsh peer packages.
- **Tests**: `npm test` (node:test — no third-party dependencies).
- **Manual E2E in a real WSL**: `node tools/e2e-wsl.mjs install|verify|uninstall`
  (dev helper, not published).
- **Release**: bump `version` in `package.json` → `pnpm pack` → publish / push.
  The `dsh.bundle` manifest means `dsh plugin update` picks up new versions.

## ❓ FAQ

**Q: Does the shortcut run anything as admin?** No. `wsl.exe` and the launcher
run with your normal user permissions.

**Q: Does it interfere with a running `dsh web`?** No — the port probe finds a
live server and skips straight to the browser.

**Q: Why a bash script and not a .exe / .cmd?** WSL side is Linux: bash +
`/dev/tcp` needs zero extra tools, stays pure ASCII, and is ~100 lines you can
read before it runs. The Windows side is one standard `.lnk`.

**Q: Non-WSL hosts?** The plugin loads fine, installs nothing, and keeps the
`wsl_launcher` tool active (`status` works everywhere; `open` degrades to a
"open manually" message; `install`/`uninstall` report a clear no-op).

**Q: WSL1?** Works — everything used is interop + files, both present in WSL1.

## 📜 License

MIT — see [LICENSE](LICENSE).
