# 文件桥插件：打包、投放与 rc.5 认证路由事实

> 研究票 #14 · `research/file-bridge-packaging` · 2026-11-26 · 基线 DSH `0.2.2-rc.5`（asar 源码 + 插件实物 + pnpm 实测）＋上游 tag `dsh-v0.2.2-rc.5`。
> `APP` = `…\app.asar\dsh\node_modules\@deepseek-ai`；`UP` = `https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/`。只给事实，不替 v1 选型。

## TL;DR

1. **F3.10 裁决：rc.5 没有登录页。** 未认证 `GET /` = `401` + 纯文本（正文见 F3.10）；`research/dsh-web-container.md` 的「登录页/配对入口」不成立，`research/intranet-https-auth.md` 正确。
2. **F1.3：client 半不需要构建。** loader 只认 classic script 里同步的一次 `window.__ModuleLoader__.load({id, factory})`，`id` 必须等于包名；`dsh-laser-report/client.js` 是手写实物。
3. **F4.14：host 半坏了不致命，client 半声明坏了会致命。** `apply` 抛错 → 该 row FAILED + warning；`dsh.client`/`exports["./client"]` 坏了 → required 的 `modules` 失败 → 启动失败。
4. **F2.9：`file:` 是拷贝、`link:` 是 symlink**（实测），`file:` 尊重 `files`；profile 每次启动都被写（`cordis.yml`），`--from-default-profile` = 整目录替换、清掉插件。
5. **F1.4/F4.13/F3.12：`dsh.client.inject` 是包名边**（服务注入另写）；**没有健康端点**（靠未认证 `GET /` → 401）；裸 `ctx.webServer.register` 路由公开且不过 Host/Origin 栅栏。

## F1. 客户端半的加载契约

### F1.1 唯一入口形态与 loader 位置

- loader 在 `@deepseek-ai/dsh-client-modules`：host 半 `APP/dsh-client-modules/src/index.ts`，browser 半 `src/client/manifest.ts` + `src/client/system.ts`，经 `exports["./client"]` 提供（`index.ts:585-589` 列为 parser 预载的 bootstrap bundle）。
- 页面门面由 host 内联注入（`index.ts:602-637`）：队列期只有 `load(reg){pendingQueue.push(reg)}`；`create()` 只能调一次再切 live（`system.ts:153-162`）。无第二个入口，不认 ESM。
- 唯一注册形态 `{ id, chunk?, factory(require) }`（`manifest.ts:362-374`）。传输是 classic script、**无 `type=module`**（`system.ts:15-29`）→ 必须普通脚本、执行期同步 `load` 一次；否则 `loaded without registering "<id>"`（`:376-378`）。
- 解析在 `resolveMeta`（`index.ts:891-918`）：读 `dsh.client`、`platform !== 'web'` 即不是行（`:905`）、声明了却无 `./client` 导出则抛（`:906-909`，导出只接受字符串或一层 `default` 条件对象，`:203-213`）。[已核实]

### F1.2 `require` 能解析什么、返回什么

- **基线 11 个**（`UP packages/client/web/src/platform.ts:9-16`；本机 dist 同表 `qJ()`）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`，加 `@deepseek-ai/` 的 `dsh-client-store`、`ui-slots`、`ui-primitives`、`ui-dockkit`。
- 其余：已注册 factory 的图行（包名或 `<pkg>/client` 归一，`manifest.ts:209-220`）＋ `require.async('./client.<name>.js')` 的包内 chunk；序 seed → 已物化 → factory → 抛错（`system.ts:326-350`）。**宿主服务不能 require**，只能 `apply(ctx)` + `inject`。
- 返回即 Cordis 插件：官方 bundle 只导出 `apply`/`inject`、无 `name`（`APP/dsh-client-ui-theme/lib/client.js` 尾）；laser 返回 `{ inject: ["slots","remote","remote.commands"], apply(ctx){…} }`。[已核实]

### F1.3 仓外包能否不构建

- **能。** 唯一硬要求：`exports["./client"]` 的文件是 classic script、执行时同步 `load` 且 `id` 等于包名（`system.ts:15-29` 无构建/来源检查）。实证 `dsh-laser-report/client.js:1-3`。
- 上游 cookbook 只约束**仓内**包（`UP docs/cookbook/adding-a-package.zh.md`：`packages/client/*` 用共享 tsdown preset），不适用于仓外。
- 官方发布文档：git 安装「没有任何环节运行你的 `build` 脚本」，推荐预构建发 npm 或交 tarball（`UP docs/user/develop/basic/publish.zh.md`）。[已核实]

### F1.4 `dsh.client` 字段语义

| 字段 | 语义 | 不填 / 填错 |
|---|---|---|
| `platform` | Web 只选 `web`（`dsh-package-manifest/src/types.ts:80-82`） | 缺 → 抛（`manifest.ts:179-181`）→ 启动失败；别的值 → 不是行（`index.ts:905`） |
| `inject` | 「informational package-name dependencies, not Cordis service injection」（`types.ts:88-90`） | 空；本行照常，但 `require('对方包')` 可能 factory 未到而抛 |
| `external` | 基线之外的精确模块请求，含 `<pkg>/client`（`types.ts:92-95`） | 只用基线；非基线包模块同样可能「未到」 |
| `immediately` | 第一阶段预取（`types.ts:91`） | 等 import 才拉，首屏 UI 晚一拍 |

- 整段缺失 = 无 client 行（静默，`index.ts:900-905`）；勿与插件的服务 `inject` 混淆。[已核实]

### F1.5 id 与包名 / 行 id

- **行 id == 包名**（`manifest.ts:52-54`；`graphRow(packageName, …)`，`index.ts:1101`），注册 id 必须等于它；patch 的 row id 是另一回事（F2.8）。
- 重复：① 同一包名来自两个 active Loader source → 组合期抛（`index.ts:1090-1094`）；② 同一 bundle 执行两次 → `duplicate factory registration`（`system.ts:167-175`）；③ 注册成别人的 id → 本行「没注册」。实物 todo-board/deck/laser 的 id 均等于包名。[已核实]

## F2. 最小打包清单与安装形态

### F2.6 `package.json` 字段与缺失后果

| 字段 | 缺了会怎样 |
|---|---|
| `name`/`version`/`type: "module"`/`exports["."]` | host 入口缺失或对不上 patch 的 specifier（`cordis-plugin-loader/src/config/entry.ts:13-14`）→ `failed to import`（非致命） |
| `exports["./client"]` | 有 `dsh.client` 却无 → 抛（`index.ts:906-909`）；文件不存在 → `MissingClientBundleError` → `modules` 失败 → **启动失败**（`:1017-1022`、`103-140`） |
| `files` | 只影响发布与 `file:` 安装；实测按它打包，漏 `client.js`/patch 就装不进去 |
| `dsh.bundle.patch` | 无 → `dsh: warning: … declares no dsh.bundle — installed as a plain dependency, not a profile layer`（`dsh-plugin-manager/src/operations.ts:109-111`），**行不出现** |
| `engines.dsh` | 可选；有则单独决定兼容性、peer 被忽略（`dsh-app-boot/src/plugin-compatibility.ts:55-61`）；不满足 → bundle skip / 行 disable |

- 最小集合：`name`/`version`/`type: "module"`/`exports["."]`/`dsh.bundle.patch` + patch 文件；有 client 半再加 `exports["./client"]` 与 `dsh.client`。laser 实物仅此（无 engines/peers）。[已核实]

### F2.7 host 半与 `@deepseek-ai/*` 边界

- 不是「禁止 import」，而是「别装第二份」：profile 用 `nodeLinker: hoisted` + `autoInstallPeers: false`（`profile.ts:180-189`），启动时把**安装侧依赖闭包**（依赖+peer 递归）映射给 profile 插件（`profile.ts:311-368`、`392-418`）→ `import '@deepseek-ai/cordis'` 拿到宿主同一实例。
- 注释写明目的：「single cordis instance instead of a duplicate」（`profile.ts:180-182`）；写进 `dependencies` 会装第二份 → [推断] 服务对不上。闭包递归展开（npm CLI 91 个直接依赖、桌面 336 个），闭包外 import 报 `MODULE_NOT_FOUND`。
- 官方写法：共享实例的 dsh 包同时写 `peerDependencies` 与 `devDependencies`（同范围）（`publish.zh.md`）；`@deepseek-ai/dsh*` peer 还会被当兼容性范围，写死 `0.2.2-rc.5` 会在升级时自我拒绝。最省事是 host 半只 import `node:`（laser 如此）。[已核实]

### F2.8 `cordis.patch.yml` 的 insert 行

```yaml
- insert:
    - id: file-bridge
      name: '@local/dsh-file-bridge'
      config: {}
```

- 无 `id` 的 patch 把行 append 到根；带 `id` 表示往该 group 里插（`cordis-plugin-include/src/patch.ts:66-91`）。`id` 缺省会被随机补（`:27-38`）但运行期改动靠它回写，别省；任意字符串、唯一性只在同一棵树内（`entry.ts:10-12`、`:67-73`），不要求等于包名。`name` = Loader 导入的 specifier（`entry.ts:13-14`）。[已核实]

### F2.9 `dsh plugin add` 落盘、只读与刷新

- `dsh plugin` 是 pnpm 转调：`execa(pnpm, args, { cwd: profile })`（`operations.ts:386-387`），相对路径参数按**调用目录**绝对化、保留 `file:`/`link:` 前缀（`:69-73`）。
- pnpm 11.28.5 实测：`add file:../plugin` → 记 `"file:../plugin"`、`node_modules` 里是**真目录副本**（store 硬链）；`add link:<abs>` → 记 `"link:<abs>"`、是 **symlink**；源目录改名后 `pnpm install` → `ENOENT`、exit 1。官方文档里 `add ./hello-plugin` 落盘 `"link:/path/to/hello-plugin"`（`publish.zh.md`），本机 laser 也是 `link:C:/…`。[已核实]
- **只读**：`file:` 安装期可读即可、运行期不需源目录；`link:` 运行期需源目录在该绝对路径（只读可以）。[已核实／推断]
- **profile 必须可写**：每次启动写 `<profile>/cordis.yml`（`dsh/src/profile-boot.ts:194-199`），首次解析写 `<profile>/.cordis/resolve.mjs`（`resolve.ts:47-57`，只读时回退 native import）。
- **DSH 不刷新 profile**：仅 `package.json` 缺失时按模板 init（`profile.ts:733-741`）；`normalizeShippedProfile` 只替换精确匹配的 installation-owned tuple（web 不在其中，`:592-606`）；`--from-default-profile` 才整目录替换（`profile-boot.ts:90-107`）= 清空插件与 node_modules。指纹刷新是否破坏取决于 seed 实现。[推断]

## F3. rc.5 未认证浏览器体验

### F3.10 裁决：401 纯文本，无登录页

- 行为（`APP/dsh-client-connection/src/browser-auth.ts:385-393`）：`401` + `no-store` + `text/plain; charset=utf-8`，body 恰为 `dsh web authentication required; reopen the URL printed by dsh web.` + 换行；`HEAD` 同头无 body。
- 只有 index 走认证：`frontend-static` 的 fallback 只对 `/` 与 distIndex 调 `authorizeIndex`，其余资源公开（注释「Non-index assets stay public」，`APP/dsh-host-frontend-static/src/index.ts:7-12`、`:139-166`）→ SPA 的 HTML 根本没返回。
- **裁决**：rc.5 = 401 纯文本；`dsh-web-container.md` 的「登录页/配对入口」不成立，`intranet-https-auth.md` 正确。[已核实]

### F3.11 `/login`、token→cookie、配对

- rc.5 的 HTTP 路由只有 `/api`（认证）、`/connect`（token→API Peer）、`/plugins`＋`/plugins/events`（公开）、`/open-in-app/*`、`/oauth/callback`。**无 `/login`**、无 pairing/扫码文案。
- token→cookie（`browser-auth.ts:263-307`）：`GET /?token=<launchToken>`（pathname 恰 `/`、恰 1 个 token）→ `303`、`location: ./`、`set-cookie: dsh-auth-<b64url(sha256(authority))>=v1.<payload>.<hmac>; Max-Age=…; Path=/; Expires=…; HttpOnly; SameSite=Strict`（TLS 加 `Secure`）。已带 cookie 再带 token 也只 303 不重发；token 错 → 401。
- 令牌每进程随机 32 字节，只有 `dsh web: <url>?token=…` 打印（`dsh-web-app/src/index.ts:228-232`；`dsh-client-connection/README.zh.md:41`）→ **重启即换**；cookie 默认 30 天、密钥在 `$DSH_HOME/.credentials.yaml`（README:43）→ 跨重启有效（Host authority 不变）。
- `/connect?token=…&interactions=answer|none` → `302` → `./api/remote.mux`（`:309-352`）；无 logout，删凭据 + 重启才全撤（README:83）。「配对入口」只以该 URL 存在，无 UI。[已核实]

### F3.12 裸路由顺序、栅栏、能否当登录页

- `dsh-host-webserver` 是纯分发：`handle()` 按 exact → 最长 prefix → fallback 直接调 handler，**不查 cookie/Host/Origin**（`APP/dsh-host-webserver/src/index.ts:527-560`、`:485-490`）。
- 认证在路由自己身上：`/api` 先 `connection.admit`（401 `unauthorized`／403 `forbidden`，`dsh-client-connection/src/index.ts:150-165`）；`/` 由 frontend-static 调 `authorizeIndex`。栅栏在 `admit`/`requestRejection`：Host 须 loopback／绑定 IP／`trustedHosts`，`Sec-Fetch-Site: cross-site` 拒（`api-request-trust.ts`、`rpc-host.ts:122-137`）。
- 裸路由 = 公开且不过栅栏；要栅栏自己调 `ctx.connection.requestRejection(req)`——`dsh-host-open-in-app/src/index.ts:185-204` 是范例。
- GET-only 静态页可行但**无法完成登录**（服务端只认进程令牌）。要改 `/` 只能抢 fallback（`registerFallback` 无重复检查，`webserver/src/index.ts:477-483`），代价是 `authorizeIndex` 不再执行、`/` 变公开——插件能做，不算 patch DSH。[已核实／推断]

## F4. 失败隔离、健康检查、启动断言

### F4.13 健康端点与 healthcheck

- **没有**：全 asar 无 `/healthz`、`/readyz`、`/health` 路由（唯一 `/health` 属 liveshare 客户端）。可用信号：`GET /` → **401** 证明 webserver 在听 + fallback 已挂 + connection 已加载；`404` 说明 fallback 未挂（`webserver/src/index.ts:534-538`）；`GET /plugins/events` → 200 + SSE `: connected` 证明 client-modules/hmr 已起（`dsh-client-hmr/src/index.ts:174-194`）。
- 建议：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/` 期望 `401`；不要 `-f`（401 判失败），也别带 cookie。更强信号是 `dsh web:` 行——Loader 结算 **且** required 审计通过后才打印（`dsh-web-app/src/index.ts:241-252`）。[已核实＋推断]

### F4.14 加载期异常的隔离粒度

| 触发 | 结果 | 证据 |
|---|---|---|
| host 入口 import 失败 | 记 error、无 fiber，其余行继续 | `cordis-plugin-loader/src/config/entry.ts:225-238` |
| `apply` 同步抛 / 返回 promise reject | fiber `FAILED` + 审计 warning | `cordis/src/fiber.ts:362-406`、`681-710` |
| 失败行 ∈ 10 个 required | `StartupError` → exit 1 | `dsh-app-boot/src/index.ts:966-977`、`1181-1184` |
| 进程级 unhandledRejection / uncaughtException | fail-loud → exit 1 | `:899-947` |
| client 半声明畸形 / `./client` 读不到 | `modules`(required) FAILED → **启动失败** | `dsh-client-modules/src/index.ts:697-701`、`101-140` |

- required：`agent-loop`、`tool-executor-native`、`tool-executor-ptc`、`webserver`、`web-runtime`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`。
- 一句话：**host 半坏了 = 功能缺失 + warning；client 半声明/打包坏了 = 整机起不来**；`apply` 里 detached promise 的 reject 走 `unhandledRejection` → 整机退出。[已核实]

### F4.15 可 grep 的断言

- 装配：`dsh --profile web --dump-config | grep -n -A3 '# == @local/dsh-file-bridge'` → 期望 `- id: file-bridge`、`name: '@local/dsh-file-bridge'`（`renderConfigDump` 的 `# == <bundle 包名>` + YAML，`dsh-app-boot/src/index.ts:715-744`）；`grep -c '@local/dsh-file-bridge' $DSH_HOME/profiles/web/package.json` 期望 2（dependencies + bundles）。[推断：dump 会写 profile，未本机执行]
- 正面：`dsh web: http://…?token=…` 出现 = 结算 + required 审计通过；单插件「确实加载」最稳的是 `apply` 里 `console.log` 或加可探测路由。
- 负面：`dsh: warning: N entries did not activate` + `<row-id> (<包名>): failed to import: …`（`:1111-1131`）、`dsh: startup failed: …`（`:1134-1155`）、`dsh: disabling profile plugin row "…"`（`compatibility-preflight.ts:79-83`）。
- **不要** grep `apply plugin`：info 级、CLI 无 console exporter，只进内存缓冲（`cordis/src/logger.ts:141-161`；boot exporter 只收 warn/error，`app-boot:1232-1237`）。[已核实]

### F4.16 运行期依赖与 client bundle 形态

- 不需要 pnpm（唯一调用是 `dsh plugin`，`dsh/src/plugin.ts:96-99`）、构建工具（bundle 启动时读进内存，`client-modules/src/index.ts:1100-1112`）或外网。
- client bundle 由 host 提供但**不是原始静态文件**：行 URL 是组合形式 `/plugins/??<pkg>/client.js&rev=<rev>`（`index.ts:271-295`、`529-539`），首次 GET 拼接，`text/javascript` + immutable（`:1267-1293`）。缺文件不是 404，是启动失败。[已核实]
