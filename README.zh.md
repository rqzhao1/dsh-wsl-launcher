# dsh-wsl-launcher

**当 `dsh` 住在 WSL 里时，给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面一个「双击直达」的入口。**

[English](README.md)

你的 `dsh web` 跑在 WSL 里，但鼠标在 Windows 上。每次打开界面都要重复同一套仪式：

```
打开 Windows 终端  →  wsl  →  dsh web  →  等它启动  →  切到浏览器  →  敲网址  →  回车
```

这个插件把这套仪式删掉。安装后，你的 **Windows 桌面**上会出现一个应用风格的
快捷方式（黑鲸图标）。双击它：

1. 由 `wsl.exe -d <你的发行版> --exec /bin/bash <launcher.sh>` 直接拉起——不需要 Windows 终端；
2. 启动脚本会找到 `dsh`（PATH → 登录 shell → 安装时记录的路径）；
3. 如果 Web 端口已经在监听，**直接打开浏览器**（天生幂等——连点十下也不坏，没有端口冲突）；
4. 否则启动 `dsh web --port 3080`，**这个控制台窗口就是服务器窗口**（关窗即停服务），轮询端口就绪后自动打开 Windows 默认浏览器。

同时注册 `wsl_launcher` 模型工具：会话里的 agent 自己就能
`install` / `status` / `open` / `uninstall` 这个启动器。

---

## ✅ 兼容性

| | |
|---|---|
| dsh | 已在 `0.1.1-rc.2` 验证（单元测试 + 草稿 profile 的 `dsh plugin add` / `--dump-config` 组合检查） |
| Node | `>=20`（`engines` 声明） |
| 运行环境 | Windows 10 1607+ / Windows 11 上的 WSL1/WSL2，**interop 开启**（默认开启），且有 Windows 盘挂载在 `/mnt/<盘符>` |
| dsh 位置 | 发行版内的任意位置：`npm -g`、nvm、本地 checkout 均可——启动脚本运行时自行解析 |
| 最后验证 | 2026-08-28（WSL2、Ubuntu 24.04、dsh `0.1.1-rc.2`、Node 24） |

## 📦 安装 / 升级 / 卸载

需要一个 `dsh` profile（例如你跑 `dsh web` 的 `web` profile）。

**安装**

```sh
# 从 npm（发布之后）
dsh plugin --profile web add dsh-wsl-launcher

# 或直接来自 GitHub（monorepo 子路径写法）
dsh plugin --profile web add github:Small-tailqwq/dsh-deep-whale#path:/wsl-launcher

# 或本地 checkout / tarball
dsh plugin --profile web add /path/to/dsh-wsl-launcher
dsh plugin --profile web add /path/to/dsh-wsl-launcher-0.1.0.tgz
```

`dsh plugin` 通过包的 `dsh.bundle` 清单自动把它注册为 bundle 层——
**无需手工编辑任何 `cordis.patch.yml`**。

**升级 / 卸载**

```sh
dsh plugin --profile web update dsh-wsl-launcher
dsh plugin --profile web remove dsh-wsl-launcher
```

然后重启 `dsh web`。激活时若 `autoInstall: true`（默认），插件会自动
（重新）创建启动文件与桌面快捷方式。卸载包不会删你的快捷方式——请用
`wsl_launcher` 的 `uninstall` 动作（或下面的手动步骤）清理。

## 🚀 快速开始

1. 安装插件（见上文）并重启 `dsh web`。
2. 看你的 Windows 桌面：**DeepSeek Harness Web**（鲸鱼图标）。
3. 双击它 → 首次启动 `dsh web` 并打开浏览器；之后如果服务已在运行，双击只开浏览器。
4. 可复现验证：在任意会话里让 agent 调用 `wsl_launcher`，动作 `status`——
   应返回 `isWsl: true`、`distro: "<你的发行版>"`、`running: true` 与 `http://127.0.0.1:3080`。

> **WSL2 说明**：服务器监听 WSL 内的 `127.0.0.1`；WSL 的 localhost 转发
> 让 Windows 浏览器用同一个 URL 就能访问——不需要 `--host` 参数。

## 🤖 wsl_launcher 工具

| 动作 | 效果 |
|---|---|
| `install` | （重新）创建 `~/.dsh/dsh-wsl-launcher` 下的启动脚本 + 图标，以及鲸鱼图标的桌面快捷方式（仅 WSL） |
| `status` | WSL 检测、发行版名、interop 可用性、启动文件、Web 端口是否在监听（全平台） |
| `open` | 用 Windows 默认浏览器打开 Web 界面（经 WSL interop） |
| `uninstall` | 删除桌面快捷方式与整个 `~/.dsh/dsh-wsl-launcher` 目录（仅 WSL） |

## ⚙️ 配置

在 profile 的 `cordis.patch.yml`（如 `~/.dsh/profiles/web/cordis.patch.yml`）
中覆盖插件行。patch 会整体替换该行 config，请保留需要保留的键：

```yaml
- id: wsl-launcher
  config:
    autoInstall: true            # 激活时创建/刷新启动器与快捷方式（默认 true）
    port: 3080                   # Web 端口（默认 3080）
    distro: ""                   # WSL 发行版名；留空 = 自动（WSL_DISTRO_NAME）
    wslUser: ""                  # 快捷方式使用的 WSL 用户（wsl --user）；留空 = 发行版默认
    linkName: "DeepSeek Harness Web.lnk"   # 桌面快捷方式文件名
    launcherDir: ""              # 启动器目录；留空 = ~/.dsh/dsh-wsl-launcher
    scriptName: dsh-web-launcher.sh        # 启动脚本文件名
    withIcon: true               # 复制鲸鱼图标并应用到快捷方式
```

### 启动策略

默认 `launchMode: installed`。启动器会解析已经安装的 `dsh` 二进制文件（PATH、登录 shell、常见 Node 版本管理器目录、安装时记录的路径），不会访问 npm。

如果只通过 `npx` 使用或需要一次性运行，请显式启用，并锁定精确包版本：

```yaml
- id: wsl-launcher
  config:
    launchMode: npx
    npxPackage: "@deepseek-ai/dsh@0.1.1-rc.2"
```

这会生成 `npx --yes @deepseek-ai/dsh@0.1.1-rc.2 web --port 3080 --no-open`。`npxPackage` 只接受一个精确的 npm 包版本：不允许省略版本、`latest`、语义化版本范围、空白字符或 shell 语法。`npx` 模式绝不会作为自动兜底。非交互式 WSL 启动环境中必须有 Node.js 和 `npx`；首次运行需要访问 npm registry，并可能下载该固定版本。

不涉及任何敏感信息。

## 🔐 权限与数据

| 领域 | 插件做了什么 |
|---|---|
| 写入文件（WSL 侧） | `~/.dsh/dsh-wsl-launcher/dsh-web-launcher.sh` 与 `~/.dsh/dsh-wsl-launcher/icons/whale.ico` |
| 写入文件（Windows 侧） | 仅桌面一个 `.lnk`（`DeepSeek Harness Web.lnk`）——由 `powershell.exe`（WScript.Shell）创建，不碰其他 Windows 文件 |
| 读取文件 | 只读包内自带的模板与图标，以及 `/proc/version`（WSL 检测） |
| 进程 | 经 WSL interop 拉起 `powershell.exe`（建/删快捷方式、浏览器兜底）与 `explorer.exe` / `cmd.exe`（开浏览器）；启动器本体是纯 ASCII 的 bash 脚本，运行前可以通读 |
| 网络 | 仅回环：`status` 探测 `http://127.0.0.1:<port>`；浏览器由操作系统打开，不是插件打开 |
| 凭据 | 无——从不读取、存储、发送凭据 |

## 🔧 工作原理

```
┌──────────────────────────────┐   ┌────────────────────────────────────────────┐
│  DeepSeek Harness Web        │──▶│  wsl.exe -d <发行版> --exec /bin/bash      │
│  （Windows 桌面 .lnk，        │   │      ~/.dsh/dsh-wsl-launcher/              │
│  鲸鱼图标经 \\wsl.… 映射）     │   │      dsh-web-launcher.sh --port 3080       │
└──────────────────────────────┘   └────────────────────┬───────────────────────┘
                                                        │ （WSL 内部）
                        ┌───────────────────────────────┼─────────────────────────┐
                        ▼                               ▼                         ▼
                  dsh 在哪？                   端口 3080 在监听吗？       启动 `dsh web --port 3080`
        （PATH → 登录 shell →            （打开 Windows 浏览器，      （控制台 = 服务器窗口；
         记录的绝对路径）                  exit 0——幂等）             轮询 /dev/tcp → explorer.exe）
```

- **`cordis.patch.yml`** — bundle patch：一条 loader 行（`id: wsl-launcher`、
  `name: dsh-wsl-launcher`）；`dsh plugin add` 依据 `dsh.bundle` 清单自动把它
  归入 profile 的 bundle 栈。
- **`lib/launcher.js`** — WSL 检测（内核 banner + `WSL_DISTRO_NAME` /
  `WSL_INTEROP` 兜底）、启动模板渲染（纯 ASCII）、`wsl.exe` 参数构造（含命令行
  引号处理）、Windows 图标候选（`\\wsl.localhost\<发行版>\…` 优先、`\\wsl$\…`
  兜底）、以及建/删快捷方式的 PowerShell 构造。所有 PowerShell 字符串值都用
  单引号 + `''` 转义。
- **`lib/index.js`** — Cordis 插件（`name: 'wsl-launcher'`、`inject: ['tools']`、
  zod `Config` schema）+ 基于 `@deepseek-ai/dsh-tools` `defineTool` 的
  `wsl_launcher` 工具。
- **`lib/template.sh.txt`** — 生成的启动脚本：解析 `dsh`（PATH →
  `bash -ic` 登录 shell（覆盖 nvm）→ 记录的绝对路径），用 bash `/dev/tcp`
  探测端口（不依赖 curl/netcat），开浏览器按 `explorer.exe` → PowerShell
  `Start-Process` → `cmd.exe /c start` 的顺序兜底（部分 WSL 环境，如容器化
  WSL，`explorer.exe` 会直接退出、开不了浏览器），并把控制台窗口的生命周期
  绑定到服务器（EXIT/INT/TERM 上挂 `trap`）。
- **`icons/whale.ico`** — 多尺寸鲸鱼图标；安装时复制到启动器目录，Windows 侧
  通过 `\\wsl.localhost` 映射读取它来给 `.lnk` 上图标。

## 🩺 故障排查

| 症状 | 原因与解决 |
|---|---|
| 重启后没出现快捷方式 | 看 `dsh web` 日志里 `dsh-wsl-launcher: auto install skipped: …` 警告。通常是 WSL interop 被关：在 `C:\Users\<你>\.wslconfig` 的 `[boot]` 下设 `interop = true`（或改 wsl.conf），重启发行版，再跑 `wsl_launcher install`。 |
| 工具输出 `powershell.exe not found` | 同上——interop 关闭，或 `/mnt` 下没有挂载的 Windows 盘。 |
| 快捷方式出现了但图标是通用的 | 可能是 `\\wsl.localhost` 映射缺失（较老的 Windows）。插件会回退到 `\\wsl$`；若两者都没有，快捷方式照样能用，只是没图标。升级 Windows，或设 `withIcon: false` 跳过探测。 |
| 快捷方式出现在奇怪的位置 | OneDrive 托管桌面：插件按 `%USERPROFILE%\Desktop` → `%OneDrive%\Desktop` → `%USERPROFILE%\OneDrive\Desktop` 的顺序取第一个存在的目录——与 Explorer 所见一致。 |
| 启动脚本提示 `dsh was not found` | 默认 `installed` 模式下，非交互 shell 里找不到 `dsh`。在发行版里装好（`npm install -g @deepseek-ai/dsh`）；如果用 nvm，登录 shell 探测会找到它——或从同一环境重装插件以刷新记录路径。也可改为显式、固定版本的 `launchMode: npx`。 |
| 启动脚本提示 `npx was not found` | `launchMode: npx` 要求非交互式 WSL 环境中可用 Node.js 和 `npx`。请安装 Node.js/npm，或将 `NPX_BIN` 指向可执行的 `npx`；`npxPackage` 必须保持精确固定版本。 |
| 提示 `dsh web exited early` | 看错误上方控制台的输出（profile/CLI 问题，不是启动脚本的 bug）。 |
| `EADDRINUSE` / 端口被占用 | 启动器检测到端口在监听会直接开浏览器。需要换端口就在 config 里设 `port`。 |
| 浏览器开了但页面报 transport/403 | **浏览器信任围栏**拦截了跨源调用——DevTools → Network → 失败请求 → 看 `Origin`，必须是 `http://127.0.0.1:<port>`。常见元凶是浏览器扩展或残留标签页。 |
| 没有弹出浏览器窗口 | 启动器会选择一种 Windows interop 启动方式：优先 `explorer.exe`，否则使用 PowerShell `Start-Process` 或 `cmd.exe /c start`；一次启动不会再串联其他方式，从而避免重复标签页。若全部不可用，会在控制台打印网址；请检查 WSL interop。 |
| 快捷方式拉起了错误的发行版/用户 | `.lnk` 里编码了 `wsl.exe -d <发行版> [--user <用户>]`。在 config 里设 `distro` / `wslUser` 后重新 `wsl_launcher install`。 |
| 关掉控制台窗口会怎样 | 故意的：控制台窗口就是服务器窗口——关窗会停掉 `dsh web`（脚本转发信号）。 |

**回滚**：`dsh plugin --profile web remove dsh-wsl-launcher`，再调用
`wsl_launcher` 的 `uninstall`（删除 `.lnk` 与 `~/.dsh/dsh-wsl-launcher`）。
不会留下其他任何东西。

## 🛠️ 开发

- **无构建步骤** — `lib/` 是纯 ESM JavaScript；除 dsh 的 peer 依赖外零运行时依赖。
- **测试**：`npm test`（node:test——无需任何第三方依赖）。
- **真实 WSL 里手动 E2E**：`node tools/e2e-wsl.mjs install|verify|uninstall`
  （开发辅助，不随包发布）。
- **发布**：bump `package.json` 的 `version` → `pnpm pack` → 发布 / 推仓库。
  `dsh.bundle` 清单意味着 `dsh plugin update` 会自动激活新版本。

## ❓ 常见问题

**Q: 快捷方式会以管理员权限运行吗？** 不会。`wsl.exe` 与启动脚本都以你的普通用户权限运行。

**Q: 会干扰正在运行的 `dsh web` 吗？** 不会——端口探测发现服务在运行就直接进浏览器。

**Q: 为什么是 bash 脚本而不是 exe / cmd？** WSL 侧是 Linux：bash + `/dev/tcp` 零额外依赖、纯 ASCII、约 100 行，运行前可以通读。Windows 侧只有一个标准的 `.lnk`。

**Q: 非 WSL 环境？** 插件正常加载、不安装任何东西，`wsl_launcher` 工具保持可用（`status` 全平台可用；`open` 退化为「请手动打开」提示；`install`/`uninstall` 返回明确的 no-op 消息）。

**Q: WSL1 能用吗？** 能——用到的只有 interop 与文件，WSL1 两者都有。

## 📜 许可

MIT —— 见 [LICENSE](LICENSE)。


## 稳定性与容错

- 启动、停止按端口使用原子锁，避免双击产生重复 `dsh web` 进程。
- PID 文件必须是完整数字，停止前还会校验进程命令和进程组；陈旧或不匹配的 PID 只会被清理，不会误杀其他进程。
- `status`、`install`、`stop`、`uninstall` 的外部文件和 Windows 互操作错误会返回可读结果。
- 自动停止默认关闭。启用 `autostopEnabled` 后，只有同源 JSON 请求中的合法浏览器 client id 才会计入在线状态；错误请求会被拒绝。
- `uninstall` 可重复执行；它只删除插件创建的快捷方式、Windows wrapper 和 launcher 目录，不会停止外部启动的服务。
