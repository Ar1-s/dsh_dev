# 服务器打包与插件策略：版本钉定、升级与回滚

> 研究票：#7「服务器打包与插件策略」· map #1「DSH 内网服务器与手机上传 v1」
> 分支：`research/pinning-upgrade` · 日期：2026-11-26 · 基线：DSH `0.2.2-rc.5`（tag `dsh-v0.2.2-rc.5`，commit `9c2670d3`）
> 方法：只读一手来源。用 `gh api` 确认 tag 可解析后，把该 tag 浅克隆到临时目录逐行核对 `docs/` 与 `packages/` 源码；npm registry 取包元数据；pnpm 与 Docker 行为取各自官方文档；另只读核对了本机 `~/.dsh/profiles/web` 的模板文件。
> 证据标注：**【证实】**＝源码或官方文档直接支持；**【推断】**＝由已证机制推出、未在目标容器实测；**【未核实】**＝没有一手证据。

---

## TL;DR

1. **豁免是 profile 级、精确到「包版本 × DSH 版本」的白名单**，存在 `$DSH_HOME/profiles/<name>/compatibility.json`。DSH 升级和插件升级都不继承；CLI 也只允许给「当前」DSH 版本授权。旧豁免不会自动删除，回滚到旧 DSH 版本时会静默重新生效。
2. **整卷 DSH_HOME ＋ 镜像内装插件，只在「首次创建卷」时成立**：非空卷会完全遮住镜像里的 profile，新镜像的 `node_modules` / `pnpm-lock.yaml` / `package.json` 都不生效；只有空命名卷会从镜像播种一次，bind mount 从不播种。
3. **DSH 启动从不跑 pnpm、也不会自动修 node_modules**：缺包或不兼容只会把该 bundle 记进 `skippedBundles`，进程继续。检测只有两条 stderr 文案；`--dump-config` 能查 bundle 级，行级（`disabling profile plugin`）只有真正启动才会出现。
4. **回滚镜像 tag 在代码层简单，在数据层没有官方保证**：session format 只向前迁移，旧 build 遇到更高版本会明确拒绝（不是损坏）；credentials 文件只认 `version: 1`；官方没有任何降级/回滚指南。
5. **只读根 ＋ 非 root 可行**，前提是 `$DSH_HOME` 可写（首次启动就会写 `cordis.yml` 与 `.credentials.yaml` 里的签名密钥）、`HOME` 可写、`/tmp` 可写；web profile 运行期不需要 `$DSH_HOME/dsh-runtimes`（那是 desktop 专用），启动也不需要 pnpm。
6. **钉插件版本必须加 `--save-exact`**：`dsh plugin` 把参数原样转给 pnpm，pnpm 默认把 `pkg@1.2.3` 存成 `^1.2.3`；lockfile 才是精确版本，丢失 lock 后范围会漂。
7. **pnpm 固定 11.28.5**（上游桌面端内置的版本，仓库根 `packageManager` 同值）；DSH 不检查 pnpm 版本，换大版本会碰 lockfile 结构、`allowBuilds` 语义、store / virtual-store 元数据三类差异。
8. **「skipped 为空」不等于「全部兼容」**：精确版本豁免会压制不兼容拒绝，使 skipped 保持为空；健康断言必须同时检查 exemptions 清单和一次真实启动。

---

## Findings

### F1 版本豁免：语义、落盘、升级后的行为

#### F1.1 文件位置与格式【证实】

- 文件名固定为 `compatibility.json`，与 `package.json`、`cordis.patch.yml` 并列在 profile 目录（`packages/boot/app-boot/src/profile-compatibility.ts:9-13`）。
- 结构是精确键值对，不是范围：

```json
{
  "dsh-todo-board@0.13.5": ["0.2.2-rc.5"],
  "some-plugin@1.2.3": ["0.2.1-rc.2", "0.2.2-alpha.1"]
}
```

  键必须是「精确包名@精确 SemVer」，值必须是「精确 DSH 版本数组」；范围、前缀、空白、`workspace:` 都不接受（`profile-compatibility.ts:16-40`）。版本字符串包含 prerelease 与 build metadata，按原样比较，不做 semver 归一化。
- 写入是 `writeFileAtomic`，权限 `0600`，外层还有针对同一文件的文件锁；写豁免不触碰 `package.json`、`dsh.profile.bundles` 或任何 patch 层（`profile-compatibility.ts:124-140`）。
- 读取时：文件缺失 = 没有豁免；文件读不了 / JSON 坏了 / 顶层不是对象 = 没有豁免 ＋ 打印 warning，并把文件标记为 `rewritable: false`；单条记录不合法则只跳过该条并打印 warning，其余合法记录仍然生效（`profile-compatibility.ts:62-93`）。只要 `rewritable: false`，后续 `allow-version` / `revoke-version` 会拒绝改写，要求人工修复文件，避免把用户的其它内容覆盖掉。

#### F1.2 生效条件：精确匹配，不继承【证实】

- 判定逻辑是：`key = name@version`；`exempted = exemptions[key]?.includes(runtimeVersion)`（`plugin-compatibility.ts:96-101`）。两个维度都精确：
  - 插件升级（即使 patch 版本）→ 键变了，旧授权不继承；
  - DSH 升级 → runtimeVersion 变了，旧授权不生效；
  - 回滚到列表里出现过的旧 DSH 版本 → 旧授权**重新生效**。
- 授权入口也堵死了「提前批准未来版本」：`allow-version` 要求 `--dsh-version` 等于当前进程报告的版本（`getDshRuntimeVersion()` 读 app-boot 的 `package.json`），否则直接报 `Cannot approve DSH X: this application runs DSH Y`（`profile-compatibility.ts:120-123`）。撤销则允许点名历史版本（`profile-compatibility.ts:106`）。
- 豁免同时作用于两层准入：bundle 层（`loadProfileDirectory` 的 `evaluatePluginCompatibility`，`profile.ts:698-700`）和 row 层（`prepareProfileEntries` 的 `preflight`，`compatibility-preflight.ts:101-112`）。
- 豁免**不能**绕过：`dsh.bundle.platforms` 平台门（先于兼容性检查执行，`profile.ts:697`）、包根本不存在 / manifest 读不了、`dsh.bundle` 声明缺失。它只解除「engines.dsh / DSH peer 不满足」这一种拒绝。

#### F1.3 CLI 语义【证实】

```text
dsh plugin --profile <name> version-exemptions
dsh plugin --profile <name> allow-version <pkg@exact> --dsh-version <exact> --accept-risk
dsh plugin --profile <name> revoke-version <pkg@exact> --dsh-version <exact>
```

- `version-exemptions` 把 `Record<string,string[]>` 以 2 空格 JSON 打到 stdout，warning 打到 stderr（`apps/cli/src/plugin.ts:49-52`）。没有豁免时输出 `{}`。
- 注意它不是纯只读命令：profile 不存在时会先 `mkdir` 并 `initProfile`，而且全程持有 `package.json` 文件锁（`plugin.ts:44-57`）。在只读 DSH_HOME 上跑会失败。
- `allow-version` 在写入前打印风险警告，措辞是「allowing incompatible plugin versions can break the application or corrupt data. Approval applies only to the exact package and DSH versions.」（`plugin.ts:41-43`）。写入成功打印 `dsh: allowed <pkg@ver> for DSH <ver>`；撤销打印 `revoked`。
- 安装阶段被拒绝时，CLI 会打印可直接复制的补救命令：`dsh: to accept the risk, run: dsh plugin --profile <p> allow-version <name>@<version> --dsh-version <runtime> --accept-risk`（`plugin.ts:99-102`）。
- 插件管理器的服务端 API 同义：`list_version_exemptions` / `set_version_exemption`，授予必须 `acceptRisk: true`（`packages/boot/plugin-manager/README.md:79`）。

#### F1.4 查看、清除与「忘记清除」的后果【证实＋推断】

- 查看：`version-exemptions` 是 CLI 侧唯一的结构化清单；插件管理器的 `list_version_exemptions` API 读的是同一个文件。豁免不会出现在 `dsh plugin list`（那只是 pnpm list）、`--dump-config` 或启动日志里。
- 清除：`revoke-version` 一次删一个「包版本 × DSH 版本」；某个包的版本数组空了会自动删键（`profile-compatibility.ts:134-138`）。删掉整个 `compatibility.json` 等价于清空全部豁免；手工编辑时只要写成非法记录，整份文件会变成只读（不改写），需要人工修复。
- 没有过期、没有 GC、没有「为什么有这条」的元数据；文件只能靠人维护。
- **忘记清除的直接后果**：
  1. 在当前 DSH 上它通常「不生效」，所以看起来无害；
  2. 一旦回滚到授权里列过的旧 DSH 版本，不兼容插件会**无警告加载**；
  3. 它会让本应出现的拒绝消失，于是「`skippedBundles` 为空」「没有 `disabling profile plugin`」的检查通过，但插件实际在跑。健康检查必须把 exemptions 一起纳入断言。
- 备注：豁免不改变插件版本，也不改变 `dsh.profile.bundles`；它只是允许不满足范围的版本继续加载，风险由人承担。

---

### F2 lockfile 与 node_modules：镜像、卷与 pnpm 的三角关系

#### F2.1 profile 的构成与初始化【证实】

- `$DSH_HOME/profiles/<name>` 下是：`package.json`（依赖 ＋ `dsh.profile.bundles` 有序列表）、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`node_modules`、`cordis.yml`、`cordis.patch.yml`，以及可选的 `compatibility.json`。
- 模板由 `initProfile` 写入；**每个文件只在缺失时写**，已存在的一律不碰（`profile.ts:198-217`）：
  - `pnpm-workspace.yaml` 固定写：

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

  - 源码注释解释了为什么是 hoisted：让树外插件有一个扁平 `node_modules`，缺失的 peer（cordis 等）走 DSH 的 runtime resolution，从而共用安装里的同一个 cordis 实例，而不是各装一份（`profile.ts:180-189`）。这意味着**不要手工把 `nodeLinker` 改成 isolated**，也不要假设旧 profile 一定带这份设置——DSH 不会补写已存在的文件。
- 本机只读核对（DSH 0.2.2-rc.5 / Windows）：`~/.dsh/profiles/web/package.json` 是 `dependencies: {}` ＋ bundles `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`；`pnpm-workspace.yaml` 与上面的模板逐字一致；`cordis.yml` 是空数组。没有 `compatibility.json`，没有 `node_modules`。

#### F2.2 谁生效：卷 vs 镜像【证实（Docker 文档）】

- Docker 的规则是明确的：
  - **非空卷**挂到容器里已有内容的目录：镜像里的文件被卷**遮住**（"the pre-existing files are obscured by the mount"）。
  - **空卷**挂进去：镜像里的内容会被**复制进卷**（"these files or directories are propagated (copied) into the volume by default"）。
  - 可以用 `volume-nocopy` 关掉复制。bind mount 直接映射宿主机目录，不会拿镜像内容填充。
  - 来源：[Docker volumes: Mounting a volume over existing data](https://docs.docker.com/engine/storage/volumes/#mounting-a-volume-over-existing-data)。
- 因此「镜像里装好 profile，再把 DSH_HOME 挂成卷」的实际行为是：
  - **首次部署**（卷不存在或为空）：镜像里的 `$DSH_HOME`（含 profile）被复制进卷，插件、lock、`dsh.profile.bundles` 都在；
  - **第二次以后**（卷非空）：卷里的 profile 全量生效，**新镜像里的同名文件完全不生效**；
  - **bind mount**：宿主目录为空就是空，DSH 会把它当未初始化 profile，按模板重新 init（只剩 base ＋ web-app，没有第三方插件）。
- 结论：**重建镜像不会升级插件**。镜像里的 `node_modules` / `pnpm-lock.yaml` / `package.json` 只对「空卷的第一次」有意义。

#### F2.3 DSH 自己会不会纠正卷里的旧值？【证实】

- 启动路径只做两件「写 manifest」的事：
  1. 删除 `RETIRED_BUNDLES` 里已退役的官方 bundle 名，并从 `dsh.profile.bundles` 里移除（仅当列表里出现过），写回 manifest（`profile.ts:608-619`、`684`）；
  2. 把「安装方拥有的旧 headless 三元组」规范化为新模板——`INSTALLATION_OWNED_PROFILE_TUPLES` 目前只有 `headless` 一项（`packages/util/official-bundles/src/bundles.ts:28-34`）。`web` 没有这种 tuple。
- 除此之外，DSH **不会**把镜像里的 bundle 列表、依赖版本、lock、node_modules 同步进已有 profile。第三方插件的版本完全由卷里的 `package.json` ＋ `pnpm-lock.yaml` 决定。
- 官方 bundle（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 等）的解析顺序是**安装目录优先、profile 次之**（`profile.ts:639-661`；`apps/cli/README.md:46`）。所以 DSH 升级时，官方 bundle 的 patch 一定来自新镜像；第三方插件一定来自旧卷。这就是「新核心 ＋ 旧插件」的兼容面。
- `dsh.profile.bundles` 只会在这些操作里变：`dsh plugin add/remove`、退役清理、headless 规范化。没有「按镜像模板重建」的路径。

#### F2.4 pnpm 是怎么被调用的【证实】

- 所有包操作最终都是 `execa(pnpm, args, { cwd: profileDir, env })`（`packages/boot/plugin-manager/src/operations.ts:386-393`）：
  - `cwd` 固定是 profile 目录；
  - CLI 路径继承完整 `process.env`（保留认证、代理、终端），服务路径用 scrubbed env（`operations.ts:336`）；
  - DSH **不传** `--store-dir`，也**不写** `.npmrc`；store 位置完全由 pnpm 自己的配置解析。
- 每次操作会在 `<profile>/.plugin-manager/logs/operation-*/pnpm.log` 留日志（`operations.ts:311-315`）；失败时恢复 `package.json` 与 `pnpm-lock.yaml`，并尝试用恢复后的 lock 重装 node_modules（`operations.ts:337-342、546-561`）。`pnpm-workspace.yaml` 故意不恢复，因为 pnpm 可能把 `allowBuilds` 待审批项写进去（`plugin-manager/README.md:72`）。
- 启动路径（`loadProfileDirectory`）只读 manifest / patch，**从不调用 pnpm**；缺包只会进 `skippedBundles`（`profile.ts:689-707`）。所以「插件装进卷、运行期不再联网」在机制上成立。

#### F2.5 store 路径与 ERR_PNPM_UNEXPECTED_STORE【证实（pnpm 文档）＋推断】

- pnpm 的默认 store（官方文档，当前 12.x；11.x 同源）：
  - 设了 `$PNPM_HOME` → `$PNPM_HOME/store`；
  - 设了 `$XDG_DATA_HOME` → `$XDG_DATA_HOME/pnpm/store`；
  - Linux 默认 → `~/.local/share/pnpm/store`；
  - store 与安装目录应在同一磁盘，否则 pnpm 用复制而不是硬链接；若没有任何可写祖先，退化为项目内 `node_modules/.pnpm-store`。
  - 共享同一 store 的进程靠 `$XDG_RUNTIME_DIR`（否则 `/tmp`）里的锁协调。
  - 来源：[pnpm Store settings](https://pnpm.io/settings/store)。
- `ERR_PNPM_UNEXPECTED_STORE` 的官方定义：「A modules directory is present and is linked to a different store directory. If you changed the store directory intentionally, run pnpm install and pnpm will reinstall the dependencies using the new store.」（[pnpm errors](https://pnpm.io/errors#err_pnpm_unexpected_store)）。
- 在我们的部署里最典型的触发方式：
  1. 构建阶段以 `root`、`HOME=/root` 跑 `dsh plugin add`，store 落在 `/root/.local/share/pnpm/store`，node_modules 的 `.modules.yaml` 记录了该路径；
  2. 运行阶段是非 root、`HOME=/home/dsh`，任何 `pnpm add/install` 解析到 `/home/dsh/.local/share/pnpm/store`；
  3. 两者不一致 → 报错。
- 修复：按 pnpm 文档在目标环境跑一次 `pnpm install`（会用新 store 重装）；或**从一开始就把 storeDir 固定**。DSH 的 profile 自带 `pnpm-workspace.yaml`，pnpm ≥10 从它读 layout 与 store 相关设置；上游测试就是这样把 `storeDir` 与 `offline` 写进 profile 的 `pnpm-workspace.yaml` 的（`packages/boot/plugin-manager/tests/manager.spec.ts:838-841`）。
- **建议**：v1 走「镜像内装好、运行期禁止插件变更」，让这条错误处于休眠状态；若必须保留运行期修复能力，构建与运行用同一个 `storeDir`（例如都指向卷内 `/data/dsh/.pnpm-store`），并明确修复需要外网。

#### F2.6 pnpm 大版本：不要单独升【证实＋未核实】

- DSH **不检查** pnpm 版本：它只执行 `options.command ?? 'pnpm'`，找不到时 CLI 提示 `pnpm was not found`（`operations.ts:386`；`apps/cli/src/plugin.ts:99`）。
- 上游钉住的组合是 **pnpm 11.28.5**：仓库根 `packageManager` 是 `pnpm@11.28.5`（`package.json:7`），桌面端把 `pnpm: "11.28.5"` 作为依赖打进运行时（`apps/desktop/package.json:76`）。
- 跨大版本会碰三类差异：
  1. **lockfile**：当前 profile lock 由 pnpm 11 生成，`lockfileVersion: '9.0'`（仓库 `pnpm-lock.yaml:1`）。pnpm 官方文档（12.x）显示 lockfile 已引入 boot document / `packageManagerDependencies` 等新结构，并会在 frozen install 时校验配置摘要（`ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE`、`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`）。11 → 12 的实际行为未在本环境验证【未核实】。
  2. **设置位置**：pnpm ≥10 把 `nodeLinker` 等 layout 设置放进 `pnpm-workspace.yaml`，而不是 `.npmrc`（DSH 源码注释明确写了这一点，`profile.ts:182-183`）；旧版 pnpm 可能不读或读法不同。
  3. **构建审批**：DSH 的待审批解析与 `allowBuilds` 写入是按 **pnpm 11** 实现的（`plugin-manager/README.md:72`）；换大版本后 `ERR_PNPM_IGNORED_BUILDS` / `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 的文案与落盘键都可能变。
- 另外还有 store 元数据差异：`.modules.yaml` 记录 `storeDir`、`nodeLinker`、hoist 相关设置；大版本升级后可能出现 `ERR_PNPM_HOIST_PATTERN_DIFF` 或 `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`（同一份 errors 页）。
- **结论**：pnpm 与 DSH 同版本升级；升级时在 profile 里重跑一次 `pnpm install` 重建 lock / node_modules，不要只换二进制。

#### F2.7 钉版本的两个细节【证实】

- **`--save-exact` 不能省**：`dsh plugin` 的实参是「原样转发给 pnpm」（`docs/cli-help.md:66-74`；`operations.ts:597-610`），DSH 不会替你加 `--save-exact`。pnpm 的默认行为是保存**范围**而不是精确版本：`--save-exact` 的说明是 "exact version rather than using pnpm's default semver range operator"，`--tilde` 的说明是 "instead of the default caret range (^1.2.3)"（[pnpm add](https://pnpm.io/cli/add)）。所以：
  - `dsh plugin --profile web add dsh-todo-board@0.13.5` → package.json 里很可能是 `^0.13.5`；
  - 真正的精确版本在 `pnpm-lock.yaml`；
  - lock 丢失 / 被重新生成时，`^0.13.5` 会解析到该范围内的最新版。要「钉死」，写成 `add pkg@0.13.5 --save-exact`，并保留 lock。
- 服务端路径支持 `saveExact`：`installBundle` 在 `saveExact: true` 时向 pnpm 传 `--save-exact`（`plugin-manager/src/index.ts:1038-1040`）；更新路径固定传 true（`index.ts:866`）。CLI 路径没有这个默认值。
- **Node ABI**：换基础镜像的 Node 大版本时，卷里用旧 Node 编译的 native 模块（node-pty、koffi 等）可能加载失败；DSH 不会重装。此时必须重建 profile（或至少重跑 `pnpm install`）。【推断，未在目标机实测】

#### F2.8 两种部署形态的取舍（写进规格的建议）

| 形态 | profile 归属 | 升级时插件行为 | 适用 |
|---|---|---|---|
| **A. 镜像所有 ＋ 启动播种（推荐）** | 镜像 `/opt/dsh-seed`；启动时把 profile 复制到可写的 `$DSH_HOME/profiles`（或 tmpfs） | 随镜像 tag 原子切换；旧 profile 可先备份 | 版本可复现优先；运行期不允许装插件 |
| B. 卷所有 | 整个 `$DSH_HOME` 一个卷 | 卷赢，镜像里的插件不生效；要升级必须手工改卷或运行期 `dsh plugin add` | 允许运维在容器内改插件；需要外网 |

- 形态 A 的关键是：**不要**把 `$DSH_HOME/profiles` 做成只读挂载——DSH 每次启动都会重写 `cordis.yml`。用一个可写层（卷或 tmpfs）承接镜像 seed，并在镜像版本变化时刷新、旧 profile 备份。
- 形态 B 的关键是：第一次以外的镜像升级**不会**改变插件；把「升级插件」显式写成一次 `dsh plugin add/remove`（需要 pnpm ＋ 网络 ＋ 可写 HOME），或者接受「插件随卷冻结」。

---

### F3 静默跳过的检测：文案、入口、可脚本化断言

#### F3.1 两条准确文案【证实】

| 场景 | 文案（stderr） | 来源 |
|---|---|---|
| 整个 bundle 被跳过 | `dsh: skipping profile bundle "<packageName>": <reason>` | `profile.ts:114-118` |
| 单行插件被禁用 | `dsh: disabling profile plugin row "<id>": <pluginCompatibilityWarning>` 或 `dsh: disabling profile plugin <name>: ...` | `compatibility-preflight.ts:79-83` |
| 兼容性文件本身有问题 | `<绝对路径>/compatibility.json <原因>; treating the profile as having no exemptions`（启动时原样打印，**没有** `dsh:` 前缀） | `compatibility-preflight.ts:96-98` |

- `<reason>` 对不兼容 bundle 就是完整的 `pluginCompatibilityWarning`，包含 package@version、dsh 版本、未满足的 requirements、风险提示，以及 `Exact-version exemption: active/not active`（`plugin-compatibility.ts:110-117`）。所以 grep 前缀比 grep 全文稳。
- 每次加载/组合各写一次：bundle 级由启动器在加载 profile 后调用 `reportSkippedBundles`；row 级在组合/挂载时由 preflight 调用；HMR 重新组合时会再打印。跳过**不会**中断启动（除非缺了 required 服务导致 boot 失败）。

#### F3.2 各入口能查到什么

| 入口 | bundle 级跳过 | row 级禁用 | 备注 |
|---|---|---|---|
| 启动日志（docker logs） | ✅ `skipping profile bundle` | ✅ `disabling profile plugin` | 最完整；需要在 `dsh web:` 行之前抓 |
| `dsh --profile web --dump-config` | ✅（打到 **stderr**） | ❌ 不评估 | dump 只组合 patch；denied row 仍按配置出现在 YAML 里 |
| `dsh --profile web --dump-default-config` | ✅ | ❌ | 跳过用户 layer，避免坏 `cordis.patch.yml` 让 dump 失败 |
| `dsh plugin --profile web list` | ❌ | ❌ | 只是 pnpm list，看依赖清单 |
| Web 插件页 | ✅ 每个 bundle 带 load `error` | 部分 | `BundleInfo.error` 见 `plugin-manager/src/types.ts:88-94` |
| `$DSH_HOME/logs/startup-*.log` | 仅 fatal 启动失败时 | 仅 fatal | 路径见 `apps/cli/src/startup-diagnostics.ts:58-67` |

- 关键源码事实：`--dump-config` 走 `prepareProfile` → `loadProfile` → `loadProfileDirectory`，所以 **`reportSkippedBundles` 会在 dump 时也打印**（`apps/cli/src/profile-boot.ts:194-200`）；但 dump 不调用 `prepareProfileEntries/` `prepareProfilePatches`，所以行级禁用不会出现。官方 README 也写明「denied plugin row still appears there while a denied bundle contributes no rows」（`app-boot/README.md:56`）。
- `--dump-config` 不是只读：`prepareProfile` 每次都会写 `<profile>/cordis.yml`（`profile-boot.ts:198`）。所以它要求 profile 目录可写；在只读挂载上会失败。

#### F3.3 可脚本化的「为空」断言

静态（不用起服务，能查 bundle 级）：

```bash
set -o pipefail
tmp=$(mktemp)
dsh --profile web --dump-config >/dev/null 2>"$tmp" || { echo "dump failed"; cat "$tmp"; exit 1; }
if grep -E '^dsh: skipping profile bundle ' "$tmp"; then echo "SKIPPED BUNDLE"; exit 1; fi
if grep -Fq 'compatibility.json' "$tmp"; then echo "COMPATIBILITY FILE WARNING"; exit 1; fi
echo OK
```

动态（查行级；用一个临时端口，拿到 `dsh web:` 行后停掉）：

```bash
log=$(mktemp)
timeout 60 dsh --profile web --no-open --host 127.0.0.1 --port 0 >"$log" 2>&1 || true
if grep -E '^dsh: (skipping profile bundle|disabling profile plugin)' "$log"; then
  echo "PLUGIN DENIED/SKIPPED"; exit 1
fi
if ! grep -q 'dsh web:' "$log"; then echo "WEB DID NOT START"; exit 1; fi
echo OK
```

> 说明：`--port 0` 让 OS 分配端口，避免和正式实例冲突；`timeout` 只是为了让一次性探针退出，不是生产启动方式。

**必须同时断言 exemptions**，否则豁免会把拒绝吞掉：

```bash
dsh plugin --profile web version-exemptions 2>/dev/null | tee /tmp/exemptions.json
# 期望：{} 或与版本清单里明确批准的集合逐字一致
```

- 推荐验收口径：
  1. `compatibility.json` 为空，或内容等于「本版本明确批准」的清单；
  2. 静态 dump stderr 无 `skipping profile bundle` / `compatibility.json`；
  3. 动态启动日志无 `skipping` / `disabling`，且出现 `dsh web:`；
  4. 再做一次功能性冒烟（插件页面/工具列表），因为 `engines.dsh` 是开放范围时，兼容性门根本不拦运行时 API 变化。

---

### F4 回滚：镜像 tag、数据格式与插件的一致性

#### F4.1 官方对降级/回滚怎么说【证实：没有】

- 在 `dsh-v0.2.2-rc.5` 的 `docs/upgrade-guide/` 下只有按版本组织的「变更指南」（v0.1.7-rc.2 … v0.2.2-rc.4），没有通用的升级手册，也没有降级 / 回滚 / 备份恢复文档；`docs/user/guide/` 里同样没有。升级指南只描述「新版本改了什么、怎么迁移」，不承诺旧版本能读新数据。
- 所以下面的回滚结论都是从持久化格式的源码与升级指南推出来的【推断】，不是官方支持承诺。

#### F4.2 sessions：只向前迁移，旧 build 明确拒绝更高格式【证实】

- 当前 writer 是 **Session format v4**，最终化基线 v4、已发布版本 v4（证据 tag `dsh-v0.2.0-rc.2`）（`docs/session-format-status.md:31-49`）。
- 旧 build 遇到更高 stored version 的行为是**明确拒绝**，而不是尝试兼容：
  - `readHeader` 返回 `status: 'unsupported'`，reason 为 `stored Session uses newer format v5; this build writes v4`（`session-format/src/catalog.ts:45-58`）；
  - 迁移链的 `plan()` 直接抛 `SessionFormatUnsupportedMigrationError`，同样的文案（`session-format/src/chain.ts:79-87`）。
- 选择代际时「uses the numerically highest generation」，并且「A newer or invalid selected generation must not cause fallback to a predecessor」——旧 build 不会退回去读旧的 v4 文件（`docs/cookbook/adding-a-session-format-version.md:80`）。
- 读取旧 session **不会**就地发布迁移：`Historical read open may return the migrated in-memory artifact without writing; write open must verify and publish only the final current successor before append`（同上）。结论：
  - 升级后只是「读过」的旧 session，回滚后仍可读；
  - 在新版本里**继续写入**过的 session，如果新版本 bump 了格式，旧 build 会拒绝整条 session（文件还在，读不了，不是损坏）；
  - 同一个 v4 内也不是自动向后兼容：官方允许「older readers may reject the new payload version」（`docs/persistence-changes/README.md:67`）。
- 回滚到 v4 之前的版本没有意义（当前数据已经是 v4）；跨 v4 的小版本回滚，风险取决于新版本有没有引入旧 build 拒绝的 required 特性，需要读对应版本的 upgrade guide。

#### F4.3 credentials：version:1 不符就报错【证实】

- `.credentials.yaml` 是带 `version: 1` 的 YAML，每次写入盖版本戳；只有「预发布扁平布局」会在启动时被就地升级，其它无版本形态按名字拒绝（`credentials-local/README.md:157-159`）。
- 解析器对 `version !== 1` 直接抛错：`credentials-local: <file> declares version 2; this build reads version 1`（`credentials-local/src/index.ts:212-224`）。
- 后果：如果未来版本把 credentials 升到 v2，旧 build 会在读取时失败。凭据是 web 认证（cookie 签名密钥）的依赖，所以【推断】这很可能导致启动失败或至少认证不可用；具体失败面未在目标容器验证【未核实】。
- 对 v1 的回滚：`version: 1` 稳定，未发现 v1 内的结构演进会导致旧 build 拒绝。

#### F4.4 profiles / bundles / 插件版本【证实＋推断】

- 回滚镜像 tag 不会改卷里的 `package.json`、`pnpm-lock.yaml`、`dsh.profile.bundles`、`compatibility.json`；DSH 启动只重写 `cordis.yml`、清理退役 bundle 名。
- 插件回退要保持「三件套」一致：
  1. `package.json` 里的依赖写回旧精确版本；
  2. `pnpm-lock.yaml` 同步回到能解析该版本的 lock；
  3. `dsh.profile.bundles` 的一致性：只换版本（同名包）时 bundle 列表不变；如果是**删/加插件**，bundle 列表也要一起回退，否则会得到「依赖不存在但 bundle 仍被选中」→ 该 bundle 被 skip。
- `compatibility.json` 的键含插件精确版本：回退插件版本后，为旧版本写的豁免才会生效；为新版本写的豁免不再适用。
- `cordis.patch.yml` 是用户数据：新版本下写/改过的 patch 在旧版本可能不被理解或行为不同；升级指南里存在这类行级/配置语义变更（如 `v0.2.1-alpha.1/plugin-option-placement`、`v0.2.2-alpha.2/cordis-loader-entry-trees`）。具体到某个 patch 是否单向，未逐版本核对【未核实】。

#### F4.5 attachments / storages【部分未核实】

- 附件是内容寻址的不可变对象，落在 `<DSH_HOME>/attachments/v1/objects/...`；读时校验完整摘要、字节数、格式与尺寸（`attachment-local/README.md:84-86`）。同版本/小版本回滚通常安全；如果未来引入新的 media type 或 ref 字段，旧 build 是否接受未验证【未核实】。
- `storages/`（workspace registry 等）没有像 session / credentials 那样的显式版本拒绝逻辑；旧 build 读到新字段是忽略还是误读未核对【未核实】。

#### F4.6 可执行的回滚策略（建议，非官方）

1. **升级前**：停容器，备份整个 DSH_HOME 卷（或文件系统快照）；记录当前镜像 tag、DSH 版本、pnpm 版本、插件精确版本、`compatibility.json`。
2. **升级**：新 tag ＋ 新 profile seed；启动后先跑 F3 的静态/动态断言。
3. **回滚代码**：切换回上一个镜像 tag；profile seed 随镜像回到旧版；数据卷不动。
4. **回滚数据**：如果新版本已经 bump 了 session/credentials 格式，或已经写入过新格式，**只回退镜像不够**——必须恢复升级前的卷快照，否则会得到「旧 build 拒绝新 session」或「credentials 解析失败」。
5. **不要**指望 DSH 自带 down-migration：源码里只有 N→N+1 的向上迁移，没有反向转换。

---

### F5 只读根 ＋ 非 root：运行期到底要写哪里

#### F5.1 必须可写的路径【证实】

| 路径 | 什么时候写 | 依据 |
|---|---|---|
| `$DSH_HOME/profiles/<name>/cordis.yml` | **每次启动**都重写 | `apps/cli/src/profile-boot.ts:198`、`:326` |
| `$DSH_HOME/profiles/<name>/.plugin-manager/logs/` | 每次插件包操作 | `plugin-manager/src/operations.ts:311-315` |
| `$DSH_HOME/.credentials.yaml` | 首次 web 启动写 cookie 签名密钥；保存 Key 时 | `client/connection/src/browser-auth.ts:182-198` |
| `$DSH_HOME/sessions/` | 会话事件 | `session-persistence-jsonl/README.md:55-57` |
| `$DSH_HOME/attachments/v1/` | 上传/读图时写对象与 tmp | `attachment-local/README.md:84` |
| `$DSH_HOME/storages/` | workspace registry 等 | `packages/bundle/base/cordis.patch.yml:185` |
| `$DSH_HOME/logs/` | fatal 启动失败时写诊断 | `apps/cli/src/startup-diagnostics.ts:58-67` |
| `$DSH_HOME/cache/` | 请求图片缓存（可重建） | `home-paths/README.md:41`（`dshCachePath`） |
| `$DSH_HOME/office-kit/outputs/` | 使用 office 转换时 | `packages/bundle/web-app/cordis.patch.yml:291-294` |
| `$HOME` | pnpm store/cache、gh/git 配置、agent shell | pnpm 文档；插件运行时 |
| `/tmp` | 沙箱、临时文件、部分工具 | `sandbox-local/src/profiles.ts:16-22` |
| workspace 卷 | agent 的 cwd 与产物 | 部署约定 |

- `DSH_HOME` 的解析优先级是「显式配置 > `$DSH_HOME` > `~/.dsh`」，空值按未设置处理（`home-paths/README.md:34-39`）。容器里必须显式设，别依赖默认。
- **profile 目录不能只读**：即使插件已经构建进镜像，`cordis.yml` 每次启动都要写。想「只读挂载 profile」必须改成「可写层 ＋ 启动时从镜像 seed 复制」。

#### F5.2 可以 tmpfs / 可以不要的【证实＋推断】

- `$DSH_HOME/cache` 可以 tmpfs 或定期清空（请求图片缓存可重建）；`sessions`、`attachments`、`.credentials.yaml` 不行。
- `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` **web profile 不需要**：对应行 `workspace-dependencies` 的 disabled 条件是 `profileContext.name !== 'desktop' || !process.env.DSH_PRIMARY_RUNTIME`（`web-app/cordis.patch.yml:301-306`），web 永远禁用。它是 desktop 的 Python 运行时，不是 web 的。
- **pnpm 启动不需要**：`loadProfileDirectory` 只读 manifest/patch；pnpm 只在 `dsh plugin`（`operations.ts:597-610`）和插件管理器的安装/更新/版本查询里被调用。没有 pnpm 时：
  - `dsh web` 正常启动；
  - Web 插件页仍能列出已装 bundle（读文件系统）；
  - 安装/更新/版本列表会失败（CLI 在 127 时打印 `dsh: pnpm was not found; install pnpm and make it available on PATH.`）。
- **构建工具链不需要**：只要镜像里的 native 模块（node-pty / koffi / sharp 等）在构建阶段已经编译好，运行阶段不需要 python3/make/g++。
- **tmpfs 的 exec**：如果 tmpfs 承载 `node_modules`（里面有 `.node` 原生模块），挂载选项要显式 `exec`；`noexec` 会让 dlopen 失败。`/tmp` 若要执行临时二进制/原生件，同理。Docker 的 `--tmpfs` 支持 `exec` 选项（[Docker tmpfs](https://docs.docker.com/engine/storage/tmpfs/)）【推断：dlopen 需要 exec mmap；社区镜像也报告过 noexec 导致原生件加载失败】。

#### F5.3 只读根检查清单

- [ ] `$DSH_HOME` 是卷或 tmpfs，且 UID 可写（DSH 的用户数据多为 0700 目录 / 0600 文件）。
- [ ] `HOME` 可写（至少一个卷或 tmpfs）；否则设置 `HOME` 到可写路径，避免 pnpm/gh/git 写失败。
- [ ] `/tmp` 可写；若 tmpfs，加 `exec`。
- [ ] profile 目录可写（`cordis.yml` 每次写）；不要只读挂载。
- [ ] 运行用户固定 UID/GID，卷属主一致；避免 root 创建的文件让非 root 读不了。
- [ ] 端口 >1024（默认 3080），不需要 root 绑定。
- [ ] 如果依赖 HMR/文件树 watch，确认存储驱动支持 inotify（tmpfs/ext4 可以；NFS/9p 未验证）。
- [ ] 运行期不调用 pnpm 时，镜像可以不装 pnpm；装了也不会自动跑。

---

## 风险与未解问题

1. **【高】镜像升级不会升级插件**（形态 B）。这是「镜像内装插件 ＋ 整卷 DSH_HOME」的默认结果，不是 bug；必须用启动 seed/版本标记，或显式运行 `dsh plugin`。否则会出现「镜像 tag 变了，插件版本没变」的静默漂移。
2. **【高】回滚没有官方数据层保证**。session / credentials 都有「旧 build 明确拒绝新格式」的代码路径；升级后一旦写入过新格式，回滚镜像 tag 不够，必须回滚卷快照。官方没有降级指南，验收里要写「回滚 = 恢复升级前快照」。
3. **【高】豁免会掩盖不兼容**。`skippedBundles` 为空 / 无 `disabling profile plugin` 不能证明插件兼容；必须同时检查 `compatibility.json` 与功能冒烟。当前 P0 插件的 `engines.dsh` 多为开放范围（例如 `dsh-todo-board@0.13.5: >=0.1.7-rc.2`、`dsh-mattpocock-skills-deck@1.9.0-beta.33: >=0.2.0-rc.2`，来自 npm registry），兼容性门不会拦未来的大版本 API 变化。
4. **【中】`ERR_PNPM_UNEXPECTED_STORE` 只在运行期跑 pnpm 时爆发**。如果 v1 禁止运行期装插件，它是休眠的；一旦允许修复/安装，必须固定 `storeDir` 或先 `pnpm install` 重建。构建/运行 HOME 不一致是最常见的触发源。
5. **【中】pnpm 大版本是独立风险面**。DSH 不做版本检查；lockfile、`allowBuilds` 文案、store/hoist 元数据都可能变。上游钉住 11.28.5（desktop 依赖与仓库 `packageManager`），不要把 pnpm 当独立组件升级。
6. **【中】`--save-exact` 容易漏**。漏了之后 package.json 是 `^x.y.z`；只要 lock 在，行为仍精确；lock 丢失/重建就会浮。规格里应把它写成硬性检查（grep `package.json` 不应有 `^`/`~` 前缀）。
7. **【中】Node 大版本升级会破坏卷里的 native 模块**。node-pty / koffi / sharp 的产物与 Node ABI 相关；换 base image 的 Node major 时，旧 node_modules 可能加载失败，DSH 不会重装【推断】。
8. **【中】profile 目录只读不可行**。`cordis.yml` 每次启动重写；任何「只读挂载 profile」的设计都会在启动时失败。
9. **【低/未核实】`--dump-config` 的副作用**：它会写 `cordis.yml`；在共享/只读卷上做健康检查要注意。`--dump-default-config` 可避开坏用户层，但同样写 `cordis.yml`。
10. **【低/未核实】compatibility.json 的读取警告没有 `dsh:` 前缀**，grep 时容易漏；建议同时 grep 文件名。
11. **【低/未核实】`dsh plugin list` 的输出格式随 pnpm 版本变化**；不要把它当机器可读接口，脚本里用 `package.json` / `compatibility.json` 直接读。
12. **【未核实】Docker 空卷播种时的属主/权限**：Docker 会把镜像内容复制进卷，但 UID/GID 映射、目录 mode 是否完全保持，未在目标 rootless/非 root 环境验证；首次启动后应 `stat` 关键目录。
13. **【未核实】`tmpfs` 承载 node_modules 的可行性**：除了 `exec`，还要考虑内存占用（一个插件 profile 可能几百 MB）与重启丢文件；除非 profile 很小，否则建议用卷而不是 tmpfs。
14. **【未核实】未来 session format v5 / credentials v2 的具体发布时间与迁移路径**；本结论只覆盖 0.2.2-rc.5 的代码与文档。

---

## 一手来源列表

以下链接都固定在 `dsh-v0.2.2-rc.5` tag（commit `9c2670d3`）；行号对应该 tag 的文件内容。

### 官方仓库：插件与兼容性

- [apps/cli/src/plugin.ts（豁免 CLI 全流程）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/src/plugin.ts)
- [packages/boot/app-boot/src/profile-compatibility.ts（compatibility.json 读写）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/app-boot/src/profile-compatibility.ts)
- [packages/boot/app-boot/src/plugin-compatibility.ts（精确匹配与 warn 文案）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/app-boot/src/plugin-compatibility.ts)
- [packages/boot/app-boot/src/profile.ts（profile 初始化、bundle 解析、skippedBundles）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/app-boot/src/profile.ts)
- [packages/boot/app-boot/src/compatibility-preflight.ts（row 级禁用与兼容性 warning）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/app-boot/src/compatibility-preflight.ts)
- [packages/boot/plugin-manager/README.md（豁免语义、安装/更新、pnpm 11 构建审批）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/plugin-manager/README.md)
- [packages/boot/app-boot/README.md（profile 启动、dump 与 denied row 的关系）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/app-boot/README.md)
- [packages/boot/plugin-manager/src/operations.ts（pnpm 调用、cwd/env、日志、恢复）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/plugin-manager/src/operations.ts)
- [packages/boot/plugin-manager/src/index.ts（--save-exact、更新路径）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/plugin-manager/src/index.ts)
- [packages/boot/plugin-manager/tests/manager.spec.ts（storeDir 写进 profile 的 pnpm-workspace.yaml）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/plugin-manager/tests/manager.spec.ts)
- [packages/util/official-bundles/src/bundles.ts（模板、headless tuple、退役列表）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/util/official-bundles/src/bundles.ts)
- [docs/cli-help.md（`dsh plugin` 原样转发 pnpm）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/cli-help.md)
- [docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.md（engines.dsh 规则）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.md)
- [apps/cli/src/profile-boot.ts（每次启动写 cordis.yml、reportSkippedBundles）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/src/profile-boot.ts)
- [apps/cli/src/dump-config.ts（dump 的入口）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/src/dump-config.ts)
- [apps/cli/src/startup-diagnostics.ts（fatal 日志落盘）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/src/startup-diagnostics.ts)
- [apps/cli/README.md（bundle 解析安装优先）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/README.md)

### 官方仓库：持久化与运行时路径

- [packages/session/session-format/src/chain.ts（更高格式拒绝）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/session-format/src/chain.ts)
- [packages/session/session-format/src/catalog.ts（readHeader unsupported）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/session-format/src/catalog.ts)
- [docs/session-format-status.md（当前 v4、发布 evidence tag）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/session-format-status.md)
- [docs/cookbook/adding-a-session-format-version.md（读不写、写发后继、无回退）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/cookbook/adding-a-session-format-version.md)
- [docs/persistence-changes/README.md（同版本也可能被旧读端拒绝）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/persistence-changes/README.md)
- [packages/credentials/credentials-local/src/index.ts（version !== 1 报错）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/credentials/credentials-local/src/index.ts)
- [packages/credentials/credentials-local/README.md（文档版本与迁移）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/credentials/credentials-local/README.md)
- [packages/client/connection/src/browser-auth.ts（首次 web 启动写签名密钥）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/browser-auth.ts)
- [packages/util/home-paths/README.md（DSH_HOME 解析优先级）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/util/home-paths/README.md)
- [packages/attachment/attachment-local/README.md（附件对象路径与校验）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/README.md)
- [packages/session/session-persistence-jsonl/README.md（会话落盘布局）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/session-persistence-jsonl/README.md)
- [packages/bundle/web-app/cordis.patch.yml（office 输出路径、dsh-runtimes 仅 desktop）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/web-app/cordis.patch.yml)
- [packages/bundle/base/cordis.patch.yml（plugin-manager 行）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/base/cordis.patch.yml)
- [packages/sandbox/sandbox-local/src/profiles.ts（bwrap 的 /tmp tmpfs）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/sandbox/sandbox-local/src/profiles.ts)
- [package.json（packageManager pnpm@11.28.5、engines.node）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/package.json)
- [apps/desktop/package.json（桌面内置 pnpm 11.28.5）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/desktop/package.json)
- [pnpm-lock.yaml（lockfileVersion 9.0）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/pnpm-lock.yaml)

### npm registry

- [`@deepseek-ai/dsh@0.2.2-rc.5` 元数据](https://registry.npmjs.org/@deepseek-ai/dsh/0.2.2-rc.5)：`engines.node >= 24.9.0`、91 个依赖、bin `dsh`、无 `deprecated`。
- [`@deepseek-ai/dsh` dist-tags](https://registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags)：`latest = next = 0.2.2-rc.5`，`alpha = 0.2.3-alpha.2`；不要用 `latest` 钉版本。
- P0 插件元数据（用于核对 `engines.dsh` 开放范围）：
  - [dsh-todo-board@0.13.5](https://registry.npmjs.org/dsh-todo-board/0.13.5)：`engines.dsh >= 0.1.7-rc.2`、`engines.node >= 22.19.0`
  - [dsh-mattpocock-skills-deck@1.9.0-beta.33](https://registry.npmjs.org/dsh-mattpocock-skills-deck/1.9.0-beta.33)：`engines.dsh >= 0.2.0-rc.2`
  - [dsh-image-gen@0.12.3](https://registry.npmjs.org/dsh-image-gen/0.12.3)：无 `engines.dsh`、无 DSH peer
  - [dsh-skill-mcp-manager@1.3.0](https://registry.npmjs.org/dsh-skill-mcp-manager/1.3.0)：无 `engines`、无 DSH peer

### 第三方官方文档（行为归属到各自项目）

- [Docker volumes: mounting over existing data](https://docs.docker.com/engine/storage/volumes/#mounting-a-volume-over-existing-data)：非空卷遮住镜像、空卷复制镜像内容、`volume-nocopy`。
- [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)：bind mount 直接覆盖目标目录，不会从镜像播种。
- [Docker tmpfs](https://docs.docker.com/engine/storage/tmpfs/)：`exec`/`noexec` 等挂载选项。
- [pnpm Store settings](https://pnpm.io/settings/store)：store 默认路径、同盘硬链接、`XDG_RUNTIME_DIR` 锁、只读 HOME 的退化行为。
- [pnpm Node modules settings](https://pnpm.io/settings/node-modules)：`nodeLinker` 默认 `isolated`，可选 `hoisted`。
- [pnpm errors](https://pnpm.io/errors)：`ERR_PNPM_UNEXPECTED_STORE`、lockfile/config 不匹配、hoist 差异等。
- [pnpm add](https://pnpm.io/cli/add)：`--save-exact` 与默认 caret 范围。
- [pnpm lockfile](https://pnpm.io/lockfile)：`lockfileVersion` 的含义与新版本 boot document（当前文档为 12.x，目标 11.x，跨版本需复核）。

---

## 附：可直接写进规格的约束（摘自 Findings）

| # | 约束 | 依据 |
|---|---|---|
| 1 | DSH 版本写死为 `@deepseek-ai/dsh@0.2.2-rc.5`（不用 `latest`），基础镜像钉 digest；升级只换 tag 并重建。 | npm dist-tags；F2.2 |
| 2 | pnpm 写死 `11.28.5`（与上游桌面/仓库一致）；DSH 版本变化时按上游 `packageManager` 同步，不单独升大版本。 | package.json；F2.6 |
| 3 | 插件安装命令必须 `add <pkg>@<exact> --save-exact`；CI 断言 `package.json` 依赖无 `^`/`~`。 | pnpm add；F2.7 |
| 4 | profile 由镜像 seed 提供，启动时复制到可写层；`$DSH_HOME/profiles` 不得只读挂载（每次启动写 `cordis.yml`）。 | profile-boot.ts；F5.1 |
| 5 | 数据卷（sessions/attachments/storages/credentials/logs）与 profile seed 分离；升级前对数据卷做快照。 | F4.6、F5.1 |
| 6 | 运行期禁止插件安装/更新（无 pnpm 也可以）；需要修复时走「重建镜像」或显式维护窗口。 | operations.ts；F2.5/F5.2 |
| 7 | 健康断言 = 静态 dump 无 `skipping profile bundle` ＋ 动态启动无 `disabling profile plugin` ＋ `compatibility.json` 为空/已知 ＋ 功能冒烟。 | F3.3 |
| 8 | `compatibility.json` 里的每条豁免必须写进版本清单（谁、为什么、到期版本）；升级 DSH 后必须重新评估，回滚前检查旧版本是否会重新激活。 | F1.4 |
| 9 | 非 root、只读根：`$DSH_HOME` / `HOME` / `/tmp` 可写；若用 tmpfs，`exec`；UID/GID 固定。 | F5.1/F5.2 |
| 10 | 回滚 = 上一个镜像 tag ＋ 升级前数据卷快照；不依赖 DSH 的反向迁移（不存在）。 | F4.1/F4.6 |
