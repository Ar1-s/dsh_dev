# 无头容器里的 DSH 插件兼容性

> 研究票：#9 · map #1「DSH 内网服务器与手机上传 v1」
> 分支：`research/plugin-headless` · 日期：2026-11-26 · 基线：DSH `0.2.2-rc.5`（本机桌面安装实测）＋上游 `master@4b399c3`（2026-11-22）
> 覆盖范围：仅 v1 规格——单用户、x86_64 Linux、Docker 部署 `dsh web`、仅内网 + HTTPS + 单令牌。**不写实现。**

---

## TL;DR

1. **插件就是 profile 里的 pnpm 依赖 ＋ YAML 补丁层**。`dsh plugin --profile <name> <pnpm args>` 只是把 pnpm 转调到 `$DSH_HOME/profiles/<name>`，成功后把声明了 `dsh.bundle` 的直接依赖追加进 `package.json` 的 `dsh.profile.bundles`。这条链路在无头 Linux 上完全走得通（社区镜像已在 amd64/arm64 验证）。
2. **`web` 是官方模板，`desktop` 是 Electron 保留名**。两者是同一套 Web UI，差别只在 `dsh-desktop-host`（Electron 外壳）与少量按 `profileContext.name === 'desktop'` 开关的行。CLI 拒绝启动/转储 `desktop`，它的插件只能由桌面安装自带的命令管理。→ **容器里必须用 `web`**。
3. **"依赖桌面 GUI"基本不是插件能不能跑的主因**：客户端插件统一声明 `dsh.client.platform: "web"`；目录选择器在非 loopback 绑定/无 DISPLAY 时自动降级为 in-app 浏览；"在应用中打开"在容器里探测不到应用就不显示。真正卡住 Linux 的是 **原生模块** 与 **`dsh.bundle.platforms` 平台门**（例：`dsh-cua-bundle` 只声明 `darwin`）。
4. **原生模块在 Linux 有解，但有两个例外**：koffi / sharp / node-addon-system 都有官方 Linux（含 musl）平台包；**LibreOffice 只有 darwin/win32 原生引擎，Linux 走 WASM**；**语音输入（sherpa-onnx）的 Linux 对应版本未证实**，不纳入 v1。
5. **凭据不碰系统钥匙串**：全部在 `$DSH_HOME/.credentials.yaml`（0600、加锁、热加载）。但注意 **已保存凭据优先于环境变量**，且 **随附 headless profile 关闭了凭据存储**——同一卷里跑 headless 会读不到 Web 里保存的 Key。
6. **最大风险是"插件跑在宿主进程里、不受沙箱限制"**：插件抛未捕获异常 = 整个 DSH 进程退出（app-boot 失败表里 unhandled rejection / uncaught exception 一律 fatal）。其次是升级后不兼容插件被 **静默跳过**（`skippedBundles`），表现为"插件突然没了"。
7. **官方没有 Docker 镜像/Compose**（官方仓库树里只有一个测试用 sshd Dockerfile）。社区有三个镜像在维护，其中 `runzhliu/deepseek-harness` 文档最完整，已把已知坑写成运维条目。

---

## Findings

### F1. 插件装进 profile 的完整机制

- 入口只有两个：`dsh --profile <name>`（启动）与 `dsh plugin --profile <name> <pnpm args>`（包管理）。CLI 帮助原文："profiles are ordered stacks of plugin-bundle patch layers under the user's own overrides"。来源：[apps/cli/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/apps/cli/README.zh.md)。
- profile 目录结构（本机 `~/.dsh/profiles/web` 实测）：`package.json`（含 `dsh.profile.bundles` 有序列表）、`cordis.yml`（空根）、`cordis.patch.yml`（用户补丁层）、`pnpm-workspace.yaml`（`nodeLinker: hoisted`）、`pnpm-lock.yaml`、`node_modules`。
- 组合顺序（固定）：**每个 bundle 的 patch（按 bundles 顺序）→ profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 每次启动的 `--patch` 覆盖**。来源：[packages/boot/plugin-manager/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/boot/plugin-manager/README.zh.md)。
- **首次对未初始化的 profile 执行 `dsh plugin` 会先用官方模板初始化**（输出 `dsh: initialized profile web at …`），所以 Dockerfile 可以"先装插件、后首启"。（实现：`runPluginCommand` 在缺 `package.json` 时调用 `initProfile(dir, PROFILE_TEMPLATES[profile].bundles)`，并加 `package.json` 文件锁。）
- **装完自动入栈**：CLI 读取 profile 的直接依赖，把声明了 `dsh.bundle` 的包追加进 `dsh.profile.bundles`（先加载它的 patch 文件做校验，坏的跳过并报错），已不在依赖里的条目被移除。
- **安装前有强制兼容性预检**：对每个具名 spec 先 `pnpm view` 读 manifest，`engines.dsh`（优先）或 `@deepseek-ai/dsh*` peer 不满足就 **拒绝安装、什么都不落盘**，并提示 `dsh plugin allow-version <pkg@ver> --dsh-version <exact> --accept-risk`。规则来源：[升级指南 plugin-engines-dsh](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md)。
- **依赖 pnpm 在 PATH**：找不到 pnpm 时 exit 127，提示 `dsh: pnpm was not found; install pnpm and make it available on PATH.`；桌面安装自带 pnpm `11.28.5`，npm CLI 用系统 pnpm 或配置的 `pnpmCommand`。
- **git 直装要过 pnpm 构建审批**：`prepare` 脚本默认被拦，需按提示把键写进 profile 的 `pnpm-workspace.yaml → allowBuilds`。插件作者文档记录了同一坑（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），见 [dsh-image-gen README](https://github.com/shanliuling/dsh-image-gen)。
- **补丁层是 YAML"插入行"**：插件包在自己的 `cordis.patch.yml` 里写 `- insert:` 行，DSH 不需要改任何全局文件（本机 6 个社区插件都是同一形态）。

> 本机核对：`web` profile 目前是**空的**（只有 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`dependencies: {}`）；`desktop` profile 装了 6 个社区插件 + 1 个 `link:` 本地插件。→ **桌面在用的插件搬到容器必须显式重装，不会自动跟过去。**

### F2. `web` profile 与 `desktop` profile 的差异

| 维度 | web（`dsh web`） | desktop |
|---|---|---|
| 来源 | 官方模板，首用自动初始化 `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]` | Electron 应用私有，桌面端首次启动创建 |
| CLI 能否启动/转储 | 能 | **不能**，`desktop` 是保留名，CLI 直接拒绝 |
| 插件管理 | `dsh plugin --profile web …` 任意改 | npm CLI 拒绝；只有**桌面安装自带的 dsh 命令**用其运行时才能管 |
| UI | `dsh-web-app` 浏览器界面 | 同一套 `dsh-web-app`，外套 Electron 壳（`dsh-desktop-host`） |
| 桌面专属行 | 关闭（`disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`） | 打开（产品埋点等） |
| 客户端插件平台 | 浏览器，`dsh.client.platform: "web"` | 同一份 web 客户端 bundle |

官方模板只有 `acp / web / headless / sdk / sdk-minimal` 五个（`PROFILE_TEMPLATES`），**desktop 不在其中**；web 模板 = `dsh-base` + `dsh-web-app`。

客户端插件平台声明：本机扫描 338 个随附包，91 个声明了 `dsh.client`，**平台值全部是 `web`**（包括 `ui-directory-picker-native`、`ui-open-in-app`）。也就是说 "desktop" 不是客户端平台，桌面端用的仍是 web 客户端 bundle。Schema 见 [packages/util/package-manifest/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/util/package-manifest/README.zh.md)（`dsh.client.platform`："the Web consumer selects web"）。

**部署形态**（v1 需写进规格）：`dsh --profile web --no-open --host <pod ip> --public-url https://dsh.intra/ --trusted-host dsh.intra`，或 loopback + Caddy 剥离前缀。`--host` 只接受**具体本机 IP，拒绝通配地址**；非 loopback 且无 TLS 会明文并告警；Host/Origin 栅栏 + 启动 token 换签名 cookie。见 [packages/bundle/web-app/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/bundle/web-app/README.zh.md) 与 [public-deployments.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/user/guide/public-deployments.zh.md)。

### F3. 哪些东西"依赖桌面 GUI"，无 GUI 时怎么退化

- **目录选择器（自动档）**：`directory-picker-auto` 启动时采样一次——`native` 需要 **loopback-only 绑定 + 无远端 authority 信任 + 非 SSH 启动 + 可服务的显示会话**（darwin/win32 默认有；Linux 要求 `DISPLAY`/`WAYLAND_DISPLAY` **且** PATH 里有 zenity 或 kdialog）。其余一律落到 `browse`（容器内文件树浏览），"works everywhere"。→ **我们的部署（非 loopback 或 trusted-host + 无 DISPLAY）必然走 browse，不需要 GUI。**（本机包 `@deepseek-ai/dsh-host-directory-picker-auto` 的 README；见 [packages/host](https://github.com/deepseek-ai/deepseek-harness/tree/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/host)。）
- **"在应用中打开"**：`dsh-host-open-in-app` 只列出宿主上**探测到**的编辑器/Git GUI/终端/文件管理器；容器里一个都没有 → 该按钮不出现，不报错、不阻塞。
- **社区插件里的 Electron**：`dsh-mattpocock-skills-deck` 的 `pickerShell.js` 是 `try { require("electron") } catch {}` 的可选增强，拿不到就回退；`dsh-whale-widget` 用 UA 里的 `Electron/` 区分桌面端与 web 端；`dsh-image-gen` 里的 Electron 只是**伪装上游 API 的 User-Agent 字符串**。→ 三者都不需要 Electron 运行时。
- **真正需要特定系统的**：`@deepseek-ai/dsh-cua-bundle` 声明 `dsh.bundle.platforms: ["darwin"]`（本机 338 个包中唯一声明平台门的），依赖 `@deepseek-ai/dsh-experimental-cua-macos`；Linux 上根本不会加载。
- **PTY/终端**：`dsh-subprocess-local` 依赖 koffi + node-pty，属 base 层，web/headless 都会用到；社区镜像已验证 Linux 上"原生 PTY 实际启动"。

### F4. 原生模块在 Linux 的支持情况

| 模块 | 用途 | Linux 支持 | 证据 |
|---|---|---|---|
| koffi（FFI） | fs-local、subprocess-local、session-persistence-jsonl、directory-picker-native、libreoffice-kit… | 有：`@koromix/koffi-linux-x64` / `-linux-arm` / `-linux-riscv64` | 官方仓库 `docs/dependency-catalog.json` 命中（[repo 搜索](https://github.com/deepseek-ai/deepseek-harness/search?q=%40koromix%2Fkoffi-linux-x64)）；npm [@koromix/koffi-linux-x64](https://www.npmjs.com/package/@koromix/koffi-linux-x64) |
| sharp | 附件/图片（`dsh-attachment-local`） | 有：glibc + musl | 官方 catalog 同时命中 `@img/sharp-linux-x64` 与 `@img/sharp-linuxmusl-x64`；[npm](https://www.npmjs.com/package/@img/sharp-linux-x64) |
| node-addon-system | Landlock 启动器 + flock | 有：Linux 分 `bin/glibc/system.node` 与 `bin/musl/system.node` | [native/system/packages/linux-x64/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/native/system/packages/linux-x64/README.zh.md)；Landlock 在不受支持内核上探测为不可用（fail-closed） |
| libreoffice-kit | Office 预览/转换/重算 | **无 Linux 原生引擎**：只有 darwin-arm64/x64、win32-arm64/x64 ＋ wasm | [THIRD_PARTY_NOTICES.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/THIRD_PARTY_NOTICES.md) 的原生包清单；[packages/document/office-kit/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/document/office-kit/README.zh.md)："Targets with a declared native LibreOffice engine use it; other targets use Node WASM" |
| sherpa-onnx | 语音输入（`dsh-experimental-speech-to-text-sensevoice`） | **未证实**：Windows 安装带 `sherpa-onnx-win-x64`；npm 有 `sherpa-onnx-linux-x64@2.0.3`，但 DSH 钉的是 `sherpa-onnx-node@1.13.8`，对应关系未核验 | 本机 `app.asar.unpacked` 清单 + npm 包存在性 |

结论：**base 层在 Linux 上没问题**（koffi/sharp/PTY 都有 Linux 构建）；需要提前告知的能力差异只有 **Office 走 WASM**（慢、依赖服务器字体、无 native preview）与 **语音输入不承诺**。

### F5. 插件数据与凭据存放位置

- **单根 `$DSH_HOME`**：优先 `$DSH_HOME`，否则 `~/.dsh`；另有 `$DSH_AGENTS_HOME` → `~/.agents`。所有用户数据都在这一个根下（`@deepseek-ai/dsh-home-paths` 源码）。
- 本机实测目录：`profiles/`（每 profile 一套 package.json + lock + node_modules）、`sessions/`、`storages/`、`attachments/v1/`、`office-kit/outputs/`、`dsh-runtimes/`、`.credentials.yaml`、`.anonymous-user-id`，以及**各插件自取的子目录**：`image-gen/`、`mattskillsdeck/`、`todo-board/`、`skill-mcp-manager/`、`dsh-market/`、`whale-audio/` 等。
- 官方只有 `sessions`、`storages` 两个根是 base 层显式配置的（`dshHomePath('sessions')` / `dshHomePath('storages')`，见 [packages/bundle/base/cordis.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/bundle/base/cordis.patch.yml)）；**插件自己的数据目录是社区惯例，不是 DSH API 保证**——备份要整卷备份，不能只备份 sessions。
- **凭据：`$DSH_HOME/.credentials.yaml`，0600、跨进程写锁、热加载**；优先级 **托管文件 > 进程环境 > `$cwd/.env` > `$DSH_HOME/.env`**。来源：[升级指南 stored-credentials-precedence](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/upgrade-guide/v0.2.1-alpha.2/stored-credentials-precedence/guide.zh.md)。**没有 keytar、没有系统钥匙串、没有 safeStorage** → 容器里不需要 gnome-keyring/libsecret。
- 两条容易踩的：
  1. **存储值优先于 env**：容器 `-e DEEPSEEK_API_KEY` 在 `.credentials.yaml` 里已有同名 `refs` 时**不生效**。想用 env 作权威来源，就别让 Web UI 保存同名 Key。
  2. **随附 headless profile 关闭了凭据存储/authorization**：只读启动环境与 `.env`，已保存的 Key 与登录凭据默认不参与 headless 任务（Web/SDK/ACP 保留）。同卷里"Web 配好 Key、再用 headless 跑批"会失败。
- 订阅类渠道（image-gen 的 ChatGPT/Grok/Google 订阅登录）也落在这个 `records` 里（本机看到 `records: [{kind, payload, secret/token, issuer}] + refs`），**不会**散落到各插件目录。

### F6. 升级 DSH 时插件如何迁移

- **profile 是用户数据，不随安装包升级**：`$DSH_HOME/profiles/**` 里的第三方依赖与 lock 保持不变；6 个内置 bundle 跟随安装包。→ 升级 DSH 不会自动升级插件，也不会自动卸载。
- **启动时会做"静默清理"**：`loadProfileDirectory` 先把已退役的安装自带 bundle 从 `dsh.profile.bundles` 里删掉（`RETIRED_BUNDLES`，写回清单只改这个字段）；然后逐个 bundle 解析，**读不到 / 没声明 `dsh.bundle` / 平台不支持 / `engines.dsh` 不兼容 → 该 bundle 被跳过并记录在 `skippedBundles`，启动继续**。见 [packages/boot/app-boot/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/boot/app-boot/README.zh.md)。行级不兼容同理：该行 `disabled`，stderr 打 `dsh: disabling profile plugin …`。
- 这意味着升级后插件**多数情况下不是崩，而是"消失了"**：插件页可能还在，但功能行不再加载，只有看日志/诊断目录才能发现。
- **精确版本豁免**：profile 下 `compatibility.json` 存 `{"pkg@exact": ["0.2.2-rc.5"]}` 这样的白名单，写入必须 `--accept-risk`；文件坏了只当"无豁免"处理，不会让 profile 不可用。
- **致命的反面**：`--from-default-profile <template>` 会用模板**替换**整个 profile（插件与设置一起丢）。升级现有实例时不要用它。
- **Node 版本是硬门槛**：`0.2.1-rc.2` 起要求 **Node.js ≥ 24.9**（npm `engines` 也是 `>=24.9.0`），打包桌面应用与 Python SDK 自带运行时。见 [node-24 升级指南](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/upgrade-guide/v0.2.1-rc.2/node-24/guide.zh.md) 与 [npm @deepseek-ai/dsh/0.2.2-rc.5](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.2-rc.5)。

### F7. 社区镜像怎么做插件管理 ＋ 已知失败案例

- **官方没有容器交付物**：`deepseek-ai/deepseek-harness` 整树里只有 `packages/ssh/ssh-helper-runtime/tests/fixtures/sshd/Dockerfile`（测试夹具），**没有 Dockerfile / compose / Helm**。官方唯一相关文档是"反向代理之后发布 Web UI"（`--public-url` / `--trusted-host` / `--tls-cert`），见 [public-deployments.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/user/guide/public-deployments.zh.md)。
- 社区镜像（Docker Hub API 实测，2026-11-26）：

| 镜像 | 说明 | 最近更新 | 拉取量 |
|---|---|---|---|
| [runzhliu/deepseek-harness](https://hub.docker.com/r/runzhliu/deepseek-harness) | Docker/Compose/Helm，amd64+arm64，Node 24 非 root，可选 market/LAN/Chromium | 2026-11-23 | ~113k |
| [micrograils/deepseek-harness](https://hub.docker.com/r/micrograils/deepseek-harness) | "coding agent development environment" | 2026-11-19 | ~14k |
| [m11s/deepseek-harness](https://hub.docker.com/r/m11s/deepseek-harness) | Node 26 Bookworm、上游 pnpm 11.28.5 钉版、独立 Chromium + CDP | 2026-11-05 | ~6.5k |

- **runzhliu 的镜像文档把插件管理的坑写成了条目**（一手：镜像作者自己的 README）：
  - 插件市场**默认不装**；需要时用单独的 `-market` 标签，市场与 pnpm store 都写进 `dsh-home` 卷；**市场里的一键重启被禁用**，变更靠 `docker compose restart` / rollout 生效。
  - `ERR_PNPM_UNEXPECTED_STORE`：`dsh-home` 卷被"另一个 pnpm 主版本"处理过就会报；需要停服后跑一次 `dsh-market-repair-store`（按现有 package.json 重链、`--ignore-scripts`、固定 store 在卷内），旧 node_modules 备份到 `backups/`。
  - `profiles/web/cordis.patch.yml` 被旧 UID 拥有而不可写 → 插件开关失效；入口脚本用"内容相同、归当前用户"的副本替换（只对普通文件，符号链接只告警）。
  - 第三方包构建脚本仍需单独授权；装插件需要容器能访问 npm/GitHub。
  - Headless 默认不读已保存凭据（与官方 headless profile 行为一致）。
  - m11s 侧补充：**原生 Landlock 启动器 + system addon，沙箱可用性取决于宿主内核**。
- 两者都证明：**Linux 上 `dsh web` + 插件是可行且已被多人验证的**，代价是要处理 pnpm store、文件属主、外网访问、重启语义。

### F8. 代表插件在 web profile 下的可用性

| 插件 | 版本（本机 / npm latest） | 在 web profile 下 | 前置条件 / 依据 |
|---|---|---|---|
| `dsh-todo-board` | 0.13.5 / 0.13.5 | ✅ 纯 Node，无原生依赖 | 作者 patch 注释明确支持 `dsh plugin --profile web add` |
| `dsh-mattpocock-skills-deck` | 1.9.0-beta.33 / 同 | ✅（宿主侧） | 需要 gh + git 二进制与 gh 登录；README 明写 web 安装命令与仓库权限要求（push/triage），只读权限会降级 |
| `dsh-image-gen` | 0.12.0 / 0.12.3 | ✅ | `engines.node ^22.19 || >=24`；**图库/收藏存在浏览器 localStorage**，图落 `<workspace>/dsh-image-gen/`；订阅登录写 `.credentials.yaml` |
| `dsh-skill-mcp-manager` | 1.2.2 / 1.3.0 | ✅ | 用 `child_process` 起 stdio MCP 服务（容器需 node/npx 与外网） |
| MCP（内置 `dsh-mcp-client`） | 0.2.2-rc.5（随安装） | ✅ | `stdio` 或 `streamable-http`；启动失败默认**不阻止** harness（`failOnStartupError: false`），支持重连与 credential 引用 |
| `dshmarket` | 1.73.20 / 1.84.1 | ⚠️ 能装能用，但**自动更新/一键重启**在容器里不成立 | 会 spawn `dsh` CLI / 重启进程；社区镜像直接禁用其重启 |
| `dsh-whale-widget` | 0.4.2 / 同 | ⚠️ 可用，但做桌面/浏览器 UA 判别与 `webserver/index-inject` 注入 | 依赖宿主 connection admission，属"锦上添花" |
| `dsh-cua-bundle` | 随安装 | ❌ Linux 不加载 | `dsh.bundle.platforms: ["darwin"]` |
| 语音输入（sensevoice） | 随安装（可选 bundle） | ❓ 未证实 | 依赖 sherpa-onnx 的 Linux 平台包，未核验 |

---

## 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 官方 npm ＋ 官方 web profile ＋ `dsh plugin`** | 镜像内 `npm i -g @deepseek-ai/dsh@<pin> pnpm@11`，构建期 `dsh plugin --profile web add <pkg>@<exact>`，运行期只启动 | 唯一官方支持的插件机制；可复现（lock 文件）；升级路径清晰；不改源码 | 需要 Node 24.9+、pnpm、构建期外网；插件崩溃会带崩进程 | ✅ **推荐** |
| B. 复用桌面 desktop profile | 把 `~/.dsh/profiles/desktop` 搬进容器 | 插件现成 | `desktop` 是 Electron 保留名，CLI 拒绝启动/转储；npm CLI 拒绝管它的插件；混着 `link:` 本地路径与 Windows 假设 | ❌ |
| C. 直接用社区镜像 | `docker run runzhliu/deepseek-harness` | 立刻可用、文档全 | 版本/供应链由第三方控制；默认镜像不含市场；与单令牌、inbox、PWA 需求无交集 | ⚠️ **只用于对照验证**，不作交付物 |
| D. 手改 `cordis.yml` / node_modules | 直接把插件塞进组合 | 绕过 pnpm | 违反"patch 层＋bundles"模型，升级即丢；没有兼容性预检 | ❌ |

---

## 推荐：v1 可承诺的插件范围

### 平台基线（写进 Dockerfile/Compose）
- `node:24-bookworm-slim`（glibc，≥ 24.9）；`npm i -g @deepseek-ai/dsh@0.2.2-rc.5 pnpm@11.28.5`
- `DSH_HOME=/home/dsh/.dsh`，**整个 `$DSH_HOME` 一个卷**；运行用户固定 UID/GID（不要随镜像漂移）
- 启动：`dsh --profile web --no-open --host <ip> --public-url https://<name>/ --trusted-host <name>`（或 loopback + Caddy）
- 构建期装插件（有网），运行期禁止装（除非显式运维窗口）

### 插件分层
- **P0（v1 承诺，构建期固定版本装进镜像）**
  - `dsh-todo-board@0.13.5`
  - `dsh-mattpocock-skills-deck@1.9.0-beta.33`（容器需 gh + git，并注入 `GH_TOKEN`）
  - `dsh-image-gen@0.12.3`（渠道 Key 走 `.credentials.yaml` 或 env，二选一并写清优先级）
  - `dsh-skill-mcp-manager@1.3.0`（MCP 服务需 node/npx 与外网；默认不阻断启动）
  - 内置：`dsh-mcp-client`、office（WASM 模式）
- **P1（可选，先不承诺）**：`dshmarket`（只读浏览可以，自更新/重启不承诺）、`dsh-whale-widget`
- **v1 明确不做**：cua（darwin）、语音输入、任何 `dsh.bundle.platforms` 不含 linux 的包、任何需要 Electron 原生对话框的功能

### 安装命令（构建期，逐条固定版本）
```sh
dsh plugin --profile web add dsh-todo-board@0.13.5
dsh plugin --profile web add dsh-mattpocock-skills-deck@1.9.0-beta.33
dsh plugin --profile web add dsh-image-gen@0.12.3
dsh plugin --profile web add dsh-skill-mcp-manager@1.3.0
```

> 每次 `add` 都会自动写入 `dsh.profile.bundles`；不要手工编辑 `cordis.patch.yml` 来"挂载"插件。

---

## 风险清单（按影响排序）

| # | 风险 | 证据 | 缓解 |
|---|---|---|---|
| R1 | **插件在宿主进程内运行，不受工作区沙箱限制**；未捕获异常/未处理 rejection 会让整个 DSH 进程退出（会话可能中断） | plugin-manager README："已安装的 Host 代码在宿主进程内运行，不受工作区沙箱限制"；app-boot 失败表：unhandled rejection / uncaught exception → fatal | 只装白名单＋固定版本；`restart: unless-stopped`；升级先在 staging 跑；重要操作前备份卷 |
| R2 | **升级后插件静默消失**：不兼容/平台不符的 bundle 被跳过（`skippedBundles`），行级不兼容被 disabled，UI 上可能只是"功能没了" | `loadProfileDirectory` 逐 bundle try/catch；app-boot 失败表 | 每次升级跑 `dsh --profile web --dump-config` 做插件行 diff；把 `disabling profile plugin` / skipped 纳入验收 |
| R3 | **pnpm store / 文件属主**：卷被不同 pnpm 大版本处理过 → `ERR_PNPM_UNEXPECTED_STORE`；`cordis.patch.yml` 属主不对 → 插件开关写不进去 | 社区镜像 README 的修复脚本与入口脚本 | 固定 pnpm 11.x 与 UID；store 放卷内；首启 chown；升级 pnpm 前先迁移 |
| R4 | **凭据集中且可被 Web UI 改写**：`.credentials.yaml` 明文 0600，保存值优先于 env；拿到 token 的浏览器可以改 Key | credentials 实现 + 升级指南 | 单用户/单令牌前提下接受；`chmod 600`＋卷权限；不把该卷挂给其他容器；或"只用 env、不在 UI 保存" |
| R5 | **安装依赖外网**：`pnpm add` 要访问 npm，git 直装还要 GitHub 与构建审批 | CLI 预检 / allowBuilds 逻辑 | 构建期安装＋镜像固化；内网则准备 registry 镜像（`--registry` 可用） |
| R6 | **image-gen 的非官方通道**：靠订阅登录与 Antigravity UA 伪装访问上游，上游一改就断 | 插件 README ＋ 本机代码 | 不写进"核心可用性"承诺；配置备用 API Key 渠道 |
| R7 | **Office 在 Linux 只能 WASM**：慢、依赖服务器字体、无 native preview | office-kit README / 发布清单 | 规格写明"Office 预处理为尽力而为"；重要场景外挂 LibreOffice 容器另议 |
| R8 | **pnpm 的 minimumReleaseAge 冷却**：刚发布的版本可能装不上（桌面 profile 里就出现过 `minimumReleaseAgeExclude` 条目） | 本机 `pnpm-workspace.yaml` 实测 | 一律用**已验证过的精确版本**，不用 `@latest` |
| R9 | **Landlock 沙箱依赖宿主内核**；不可用时降级 | node-addon-system README；m11s 说明 | 验收里检查沙箱状态；不要把"强沙箱"写进 v1 承诺 |

---

## 验收建议（可执行清单）

1. **版本闸门**：`node -v` ≥ 24.9；`pnpm -v` 为 11.x；`dsh --version` 等于镜像里钉的版本。
2. **静态装配校验（不用起服务）**：`dsh --profile web --dump-config | grep -E "todo-board|mattpocock|image-gen|skill-mcp-manager"` 每个插件至少一行；缺行即装配失败。
3. **启动日志**：不得出现 `disabling profile plugin`；诊断里 `skippedBundles` 为空；`dsh web:` 行打印且带 token。
4. **运行期安装演练**（有网时）：`dsh plugin --profile web add <pkg>@<exact>` 退出码 0、`package.json` 的 `dsh.profile.bundles` 出现该包、重启后 `--dump-config` 可见。
5. **断网降级**：切断出网后重启 → 已装插件仍加载（证明不依赖运行期拉包）。
6. **单插件故障演练**：把某个插件的 node_modules 目录改名 → 启动不阻塞（该 bundle 被 skip，日志可查），其余功能可用。
7. **凭据**：`stat -c %a $DSH_HOME/.credentials.yaml` = 600；只注入 env 且文件无同名 ref 时能出词；两者冲突时以文件为准（符合文档）。
8. **持久化**：`docker rm -f` 重建 → 插件、设置、会话、附件仍在。
9. **升级演练**：改 pin 重建 → `--dump-config` 与上一版做 diff；出现不兼容则记录豁免（`dsh plugin --profile web version-exemptions` 可读）。
10. **重启语义**：插件变更后必须重启容器才生效（无 HMR 时）；写进运维手册，避免"装了没反应"。

---

## 风险与未解问题

1. **koffi 3.1.1 的 Linux 平台包**：只能证明当前 master 的 dependency catalog 解析到 `@koromix/koffi-linux-x64`（npm 上该包存在），**3.1.1 这一具体条目未在本次环境核验**（registry 按版本查询被限流）。首次构建后应直接验证 `node -e "require('koffi')"` 与 PTY 启动。
2. **sherpa-onnx 与语音输入**：`sherpa-onnx-node@1.13.8` 是否提供可用的 Linux 平台包未证实；v1 不承诺语音输入。
3. **deck 在容器里的 gh 认证方式**：README 只说用"本机 gh 已登录账号"，容器里是用 `GH_TOKEN`、`gh auth login --with-token` 还是挂载 `~/.config/gh`，未实测；需在下游实施票里定。
4. **image-gen 订阅登录的无头完成度**：订阅登录依赖浏览器授权流程，在容器（尤其只有手机浏览器）内能否完成未验证；v1 建议以 API Key 渠道为默认。
5. **`dshmarket` 在容器里的具体失败面**：社区镜像直接禁用其"一键重启"，但"更新包后是否留下半装状态"未实测。
6. **musl 镜像**：sharp/koffi/node-addon-system 都提供 musl 包，但 DSH 只在 Debian 上被大量验证；v1 建议 bookworm-slim，不选 Alpine。
7. **多设备下图库状态**：image-gen 的图库元数据与收藏在**浏览器 localStorage**，换手机/清缓存即丢；若 v1 需要"一致性图库"，这是产品缺口（不是兼容性问题）。
