# 手机端 = DSH Web 客户端 + 文件桥（研究笔记 · 增量）

> 票：#6「手机端 PWA 交互与认证」（map #1「DSH 内网服务器与手机上传 v1」）
> 分支：`research/mobile-dsh-client` · 基线：DSH `0.2.2-rc.5`（tag commit `9c2670d`）
> 与既有笔记的关系：**本文只写增量**。工作区/附件模型见 #8 `dsh-file-model`，HTTPS/令牌/PWA 安装前提见 #2 `intranet-https-auth`，插件装进 profile 的机制见 #9 `plugin-headless`，手机浏览器采集能力见 #3 `mobile-pwa-capture`，交互原型见 `prototype/mobile-upload-flow`。这些笔记已覆盖的事实，本文只引用不再论证。

## TL;DR

1. **DSH Web 现在就是可安装 PWA**：manifest 齐全（`start_url`/`scope` 为 `./`、`display: standalone`），但**没有 service worker**，所以没有离线/断点续传；布局在 768px 有抽屉断点，却**没有安全区适配**，手机 390px 宽下中栏低于布局自己声称要保护的 400px。
2. **客户端插件是官方一等扩展面**：`dsh.client` + `exports["./client"]` + `ctx.slots.register()` 能加按钮/面板/选择器；session 作用域标准 props 直接给 `sessionId`、`useSession`、`useInput`、`inputActions`；`ISession.prompt()` 能发消息；`ctx.connection.fetch.register()` 能注册**已认证**的流式路由；`remote.workspaceFiles.*` 能列/读工作区；`ctx.fileActions.save()` 能触发浏览器下载。
3. **原生上传链路只到附件库**：composer 选文件 → `POST /api/session/uploadFileBinary`（流式）→ 暂存 receipt → prompt 准入时落 `attachments/v1` → 模型看到的是只读 handle 路径。**没有**「选文件直接进工作区」的原生能力，也**没有**「按服务器路径附加附件」的 API。
4. **路径注入有三条官方路**：客户端 `inputActions.insertText/setDraft`（写草稿，用户按发送）、客户端 `ISession.prompt()`（代发一条用户消息）、Host `agent.inject()/followup()`（不唤醒/唤醒驱动器；内置 schedule 插件就是这条路）。要求「上传成功即让 agent 下一轮知道」，最干净的是 **Host 插件把文件写进工作区 + `agent.inject` 一条带路径的上下文**。
5. **下载不是无限制的**：文件树/预览走 `workspaceFiles`（整文件 32 MiB、文本页 2 MiB）；原始文件另有 `GET /api/file?path=`（50 MiB、忽略 Range）；浏览器下载实现是 blob URL，Web 端没有「另存为」。几十 MB 以上的手机下载需要插件自建流式路由。
6. **结论：架构可行，工作量中等**。全部靠官方扩展点，不需要 patch DSH；最大风险是**升级兼容**（契约/槽位随版本演进、不兼容插件会被静默跳过）与**自定义路由的鉴权边界**（`webServer` 原始路由不鉴权，必须走 `connection.fetch`）。

## 0. 方法与证据口径

- 一手来源是 tag `dsh-v0.2.2-rc.5` 的源码与文档：本机 `git clone --depth 1 --branch dsh-v0.2.2-rc.5` 到临时目录后读取。因本机 DLP 对 git 写出的文件做透明加密，正文经 `git show HEAD:<path>` 取原文；**行号对应 tag commit `9c2670d`**，链接统一指到 GitHub 同 tag。
- 标注约定：`[已核实]` = 源码/文档直接可见；`[未证实]` = 未在真机/目标环境验证或源码中未找到证据。**不把「能读源码」当成「手机上好用」**。
- 本文不重复：#8 的附件库布局与去重、#2 的证书/令牌交换、#9 的 pnpm/profile 安装细节。

## 1. DSH Web（apps/web + bundle/web-app）在手机上的可用性

### 1.1 PWA 基线 [已核实]

`apps/web/public/manifest.webmanifest`：

| 字段 | 值 | 行 |
|---|---|---|
| `name` / `short_name` | DeepSeek Harness / DSH | L2-3 |
| `start_url` | `"./"` | L4 |
| `scope` | `"./"` | L5 |
| `display` | `standalone` | L6 |
| `icons` | 192 any、512 any、512 maskable | L9-28 |

- manifest 以 `/manifest.webmanifest` 挂在根，`"./"` 因此解析为 `/`，**整个站点都在 PWA scope 内**（插件路由 `/plugins/*`、`/api/*` 同 scope）。
- `apps/web/index.html` 有 viewport（L5）、manifest link（L6）、`apple-touch-icon`（L7）、`mobile-web-app-capable`（L8）、`apple-mobile-web-app-title`（L9）；没有 `apple-mobile-web-app-status-bar-style`。
- **仓库里没有 service worker**：对 `apps/web` 与 `packages/bundle/web-app` 全量 grep `serviceWorker` 无命中 [已核实]。与 #2 的结论一致；后果见 §7。
- manifest 是**静态资产**：要改 `start_url/scope/display` 必须改 DSH Web 资产本身（不 patch 就改不了）。index 注入点（`webserver/index-inject` / `tapIndex`）只能改 HTML，manifest 文件本身由静态 dist 拥有 [已核实；是否有插件级注入点可覆盖 manifest 未证实]。

### 1.2 响应式布局：有断点，但是「桌面缩窄」而不是「手机优先」[已核实]

- 侧栏抽屉断点是一个常量：`SIDEBAR_DRAWER_BREAKPOINT = 768`（`packages/client/ui-layout/src/client/columns.ts:21`）。
- 行为（`packages/client/ui-layout/README.zh.md:30`）：
  - 侧栏 264-420px（默认 280），**≥768px 收起后保留 56px 图标栏**；
  - **<768px 且没有原生 Windows 顶栏时用模态抽屉**，不占列宽，导航后自动关闭；
  - **<1024px 自动收起**侧栏；
  - 右栏首开 45% 视口，为保中栏 400px 会先压右栏到 300px，再让占用方关闭。
- 明确写的限制（同文件 L101）：**极窄窗口下右栏关闭后中栏仍可能 <400px**；<768px 抽屉不占列宽。主流手机竖屏 CSS 宽度 360-430px，正好落在这条限制里。
- 移动端判据只有 UA：`isMobileDevice()`（`packages/client/ui-primitives/src/focus.ts:12`，README.zh.md:30）识别 `Android/iPhone/iPad/iPod` 与 `MacIntel`+多点触控；**与窗口宽度无关**。它影响的是「是否自动聚焦、提交后是否收键盘」（`ui-conversation/README.zh.md:89`），不是布局。

### 1.3 当前 Web GUI 的移动端问题（源码级证据）

| 问题 | 证据 | 影响 |
|---|---|---|
| **没有安全区适配** | `ui-layout/README.zh.md:34`：「布局不添加模拟安全区边距」；全仓 grep `safe-area-inset` **零命中** | iOS standalone 下刘海/底部横条会压住内容；PWA 全屏时更明显 |
| **键盘只按 layout viewport 处理** | 同文件 L34：「框架铺满外壳的布局视口，在键盘抬起时保留原有高度」 | 软键盘弹起时页面不缩，靠浏览器平移；输入框可能被挡 |
| **中栏在手机上偏窄** | L101 的限制；390px 视口 < 400px 保护值 | composer/消息区拥挤，长路径/表格更明显 |
| **草稿字号在触屏上强制 ≥16px** | `ui-conversation/README.zh.md:77`；`ui-conversation/src/client/skeleton/InputBar.module.css:88` 的 `@media (pointer: coarse)` | 防 iOS 聚焦缩放（有意的取舍，不是缺陷） |
| **移动端需点击才聚焦，提交后主动收键盘** | `ui-conversation/README.zh.md:89`；`InputBar.tsx:196,213` | 连续输入体验与桌面不同 |
| **composer 内的 fixed 浮层必须手动 portal 到 body** | `ui-conversation/README.zh.md:119` | 插件往 composer 里塞浮层时容易踩（§2 的按钮也一样） |
| **View 标签行按 768px 才对齐 20px 内边距** | 同文件 L73 | 窄屏是专门调过的，说明手机是被考虑过的场景，但只到「不破版」 |

补充：仓库里已有 **390×844 手机视口**的 e2e 用例（`apps/web/tests/schedule-phone.e2e.ts:89` 用 `390x844 / deviceScaleFactor 3 / isMobile / hasTouch`；`apps/web/tests/client-plugin-live.e2e.ts:134` 同尺寸），说明手机视口在 CI 里被覆盖过 [已核实；具体通过项未逐条核]。

### 1.4 文件树 / 文件预览 / 下载 / 会话切换

- **文件树**在右栏 `files` 页与预览旁的导航栏里（`ui-sidebar-files/README.zh.md:12,30,33`）。树根是**会话 header 的 cwd**，逐层 `remote.workspaceFiles.list`（同文件 L59）；隐藏项默认不显示（L82）。
- 导航栏在窄屏下**铺满整行、无分隔条**：`ui-sidebar-files/README.zh.md:48` 写「窄于 400px 的行，或 **窄于 768px 且右侧 Sidebar 以全屏呈现**时，导航栏铺满标题行下方整行…导航到该预览后会隐藏目录树」。即：**手机上有可用但「树/内容」二选一的交互**，不是并排。
- **预览**：文件地址是 `dsh-resource://file/session/<sessionId>/<path>`（`ui-sidebar-files/README.zh.md:64`），由 `ui-sidebar-documentpreview` 打开；文本页 ≤2 MiB、≤5000 行/页（`workspace-files/README.zh.md:74-76`）。
- **下载**：文件和图片菜单的「下载」由 `ctx.fileActions.save(source, 'download')` 实现，浏览器侧用 **blob URL**（`ui-file-actions/src/client/files.ts:42,57`），成功状态只是「已请求下载」；**Web 不提供「另存为」**（`ui-file-actions/README.zh.md:34`）。所以手机上是否落进「文件」App 完全由浏览器/iOS 决定 [未证实]。
- **会话切换**：走左栏会话列表；手机上就是 §1.2 的模态抽屉，抽屉有焦点陷阱、Escape、点击蒙层关闭（`ui-sidebar/README.zh.md:32`）[已核实]。没有独立的「手机底部导航」或手势切换。

**小结**：手机上「能对话、能看文件树、能预览、能下载、能切会话」都有实现，但都是桌面布局的窄屏退让；PWA 独立模式下缺安全区与键盘适配，且没有离线能力。

## 2. DSH 客户端插件（client plugin）能力

### 2.1 是什么、怎么打包与安装

- 一个包同时有 Host 半与浏览器半：package.json 声明 `dsh.client`（`platform: 'web'`），`exports["./client"]` 导出构建好的 bundle，构建用共享 tsdown preset（`docs/cookbook/adding-a-package.zh.md:38`）。
- manifest 形状（`packages/util/package-manifest/README.zh.md:33-43`）：`dsh.client = { platform: 'web' }`、`dsh.bundle.patch = './cordis.patch.yml'`、可选 `engines.dsh`。
- 宿主扫描 Loader entry 里声明 `dsh.client` 的包，组合成 `window.__DSH_BOOT__` entry 图，在 `/plugins/??<pkg>/client.js,...&rev=<rev>` 下提供 combo 脚本，并注入 index（`docs/subsystems/client-modules.zh.md:5,94,104`）。
- 安装：仍然是 profile + `dsh plugin --profile web add <pkg>@<exact>`（细节见 #9 `plugin-headless` F1；`engines.dsh` 预检、`skippedBundles` 静默跳过也在那）。
- 开发期热重载：`pnpm run dev:web`（host + bundle watcher），Host 提供 `/plugins/events` SSE，浏览器半侧替换 bundle 并重挂插件；`pollIntervalMs` 默认 500（`packages/client/hmr/README.zh.md:28-36,62`）。**生产环境没有 HMR**，装/改插件要重启进程（#9 的 R11）。

### 2.2 六个能力逐条核对

| 需求 | 结论 | 扩展点 / 证据 |
|---|---|---|
| 在聊天界面加 UI（按钮/面板/附件选择器） | **能** | `ctx.slots.inject(key, cb)` + `ctx.slots.register({name,id,order}, Component)`（`docs/subsystems/slots.zh.md:27,45-51`）。可挂的位置包括 `conversation.composer.bar` 下的 `conversation.input.left` / `conversation.input.right` / `conversation.input.attachments`、`conversation.input.activity`、`conversation.session.header.actions`（同文件 L186-198、L9）。组件可渲染原生 `<input type=file>`；注意 L119 的 fixed 浮层 portal 要求。 |
| 读当前会话 id / 消息 / 输入框草稿 | **能** | session 作用域标准 props：`sessionId`、`useSession`、`useProjection`、`useAccess`、`useConversation`、`useInput`、`inputActions`（slots.zh.md L111-121；`ui-conversation/README.zh.md:109`、`web-client.zh.md:60`）。草稿投影为 `InputState.draft`（`ui-conversation/src/client/contract/input.ts:306-326`），消息走 Session 事件窗口 / `useChat`（slots.zh.md L119）。 |
| 发一条用户消息 / 注入内容 | **能** | `ISession.prompt(content, mode, signal?, requestId?)`（`api/session-controller/src/client/contract/session.ts:98-103`，实现 `.../sessions/session.ts:270-290`）；content 三型：`text` / `image`（内联 base64）/ `file`（receiptId）（`api/session-controller/src/types.ts:80-88`）。Host 侧另有 `agent.inject/followup/steer`（§4）。 |
| 上传文件到服务器**工作区** | **要自己写路由** | 原生通道只到附件库（§3）。插件注册路由有两条：`ctx.connection.fetch.register({path, methods, requestBody:'streaming', fetch})`（`client/file-upload/src/index.ts:80-87`）——在**已认证**的 connection 载体上（connection README L34,41,49；非 owner Peer 直接 403）；或 `ctx.webServer.register({path, kind, handler})`（`host/webserver/README.zh.md:61`）——**载体不提供认证/来源策略**（同文件 L132），裸露即风险。**必须选前者**。 |
| 调用自定义 server 路由 | **能** | 同上；客户端用普通同源 `fetch('/<path>')`，cookie 自动带（#2 的 host-only cookie）。 |
| 读工作区文件列表 / 触发下载 | **能** | `remote.workspaceFiles.list/stat/read/readBytes/search`（`api/workspace-files/README.zh.md:28-37`），client 资源 `useResource<'file'>`（同文件 L92-94）；下载 `ctx.fileActions.save(source, 'download')`（`ui-file-actions/README.zh.md:32-34`）。 |

补充边界 [已核实]：

- **插件 UI 对所有打开页面的设备生效**，没有「只给手机装」的开关；要区分只能靠 UA/媒体查询（§1.2 的 `isMobileDevice` 只在客户端包里）。
- 功能包之间**只能通过 Cordis service 与 Slots 组合**，不能运行时 import 另一个功能包的组件（`web-client.zh.md:91`；slots.zh.md:229）。
- 组件拿不到 `ctx`，只能拿注册项注入的 data/callback（slots.zh.md L103）。

## 3. DSH 原生文件上传链路

### 3.1 协议与实现 [已核实]

- 路由常量：`POST /api/session/uploadFileBinary`，**按 Session 寻址**、`requestBody: 'streaming'`（`packages/client/file-upload/src/protocol.ts:2`；注册处 `file-upload/src/index.ts:80-87`）。
- 浏览器侧：`ctx.fileUpload.upload(sessionId, body, name, signal, onProgress)`（Blob/字节/ReadableStream 三型），图片走 `uploadImage`；Blob 在专用 Worker 里用 XHR 发送以便报进度，stream 只报已消费字节（`file-upload/README.zh.md:28,35`）。**不能断点续传**（同文件 L88-90）。
- Host 侧：`ctx.fileUploads` 把字节 `attachments.saveFileStream` 落盘并登记 **receipt**，receipt 以「接收 Agent 的精确 Session」为键（`file-upload/src/index.ts:57-61,127-140`）。`session/prompt` 准入时解析 receipt，再交给 `ctx.attachments`（session-controller README:38；file-upload README:47）。
- 落点：`<DSH_HOME>/attachments/v1/file-objects/...` + 只读硬链接 `files/<sha>/<name>`，**不是工作区**（布局与权限见 #8 `dsh-file-model` §2.4，本文不复述）。

### 3.2 模型/工具怎么访问

- 通用文件在请求里被投影成一行 handle 文本：`[File "report.pdf" (12345 bytes, sha256:…): verbatim read-only copy saved at "<DSH_HOME>/attachments/v1/files/…". Read that path with your file tools …]`（`packages/llm/llm/src/content.ts:158`）→ 也就是说**附件路径本来就「进」了消息**，只是指向附件库且只读。
- 图片走 provider 请求版本；工作区图片要读得用 `read_image`（#8 §2.4 已列限制）。

### 3.3 三个常见误解（源码层否定）

| 想法 | 事实 |
|---|---|
| 「composer 选文件后可让它落工作区」 | 不能。唯一原生落点是附件库；工作区写入要么 agent 自己 `write`，要么插件路由写（§4）。 |
| 「插件可以把服务器路径当附件塞进下一条消息」 | 不能。`inputActions.addAttachments(ids)` 只接受浏览器持有的 `DraftAttachmentId`（`input.ts:285-290`）；消息里的 `file` part 只能是 `{receiptId}`（session-controller types.ts:88）。**没有「按路径附加」的 API**。 |
| 「浏览器里也能像桌面那样把真实路径变成 @chip」 | 只有 Desktop 有 `__DSH_HOST_PATHS__` 桥（`apps/desktop/src/preload-app.ts:110`；`ui-conversation/README.zh.md:133`）。**Web/PWA 没有**，选文件一律上传；`@路径` chip 只能由用户手打 `@` 补全或插件 `insertText` 写入纯文本。 |
## 4. 路径注入的可行机制（「上传成功 → agent 下一轮看到路径」）

先明确目标态：**文件在工作区**（可读、可预览、可被 agent 写）+ **当前会话下一轮能看到路径**。原生上传只能满足「消息里有个附件 handle」，不满足前者。

| # | 方案 | 支持度 | 机制 | 风险 / 代价 | 升级影响 |
|---|---|---|---|---|---|
| A | 客户端插件写草稿 | **官方** | `inputActions.insertText(text, span)` / `setDraft(text)`（`input.ts:280-282`） | 用户还要按一次发送；`@` 语义依赖用户/文本匹配，路径含空格要引号 | 低：公开 prop 契约 |
| B | 客户端插件代发用户消息 | **官方** | `ISession.prompt([{type:'text',text:'已上传：<相对路径>'}], 'queue')`（`contract/session.ts:98-103`） | 会以 **user 角色**出现在 transcript，像是用户说的；需要 resolve session（`ctx.sessions`）；无可见草稿 | 中：prompt 契约与权限模型 |
| C | Host 插件 `agent.inject` | **官方（内置插件同款）** | `ctx.agents.get(sessionId)` → `agent.inject(createUserMessage({content:[{type:'text',…}], source:{kind:'my-plugin'}}))`；**不唤醒驱动器**，落在下一个被接纳的步骤（agent README.zh.md:58,60-68；schedule 实现 `packages/schedule/schedule/src/index.ts:723`） | 需要活着的 Agent（`agents.get` 返回 undefined 时要么 `followup` 要么先恢复）；注入内容对用户不可见（可另发通知） | 低：Agent 句柄的公开方法 |
| D | Host 插件 `agent.followup` | **官方** | 同上但唤醒驱动器，相当于「替用户发一条下轮消息」（agent README.zh.md:58） | 会**主动开一轮**，可能打断用户节奏；成本=一次模型调用 | 低-中 |
| E | 直接写会话文件（`session.vN.jsonl.zstd`） | **不可行** | 持久化层自带格式版本、写锁与校验；无公开 append 接口（#8 §2.2 已给日志布局） | 破坏历史/升级即坏；并发写无锁 | 高：格式随版本迁移 |
| F | `/connect` + mux WebSocket 由旁路进程发 prompt | 可行但重 | #2 已核：`/connect?token=` 换 API cookie + 一条 mux socket；API Peer 默认 `interactions: none`，且要走 remote-access 策略 | 多一个进程/服务、要维护 WS 协议、没有 UI 反馈 | 中：协议在核心包里，版本间可能变 |

**推荐组合**：插件路由把文件写进工作区（§6）→ 在同一请求的 Host 侧（或写完后的一次性回调里）用 **C** 注入一条「文件已上传：`<workspace 相对路径>`（size/mime）」的上下文；若会话没有活 Agent，退化为 **B/A**（客户端在下次打开时写草稿或代发）。C 的语义最贴合「不让用户多点一次、也不伪造一条用户消息」，但它依赖「agent 下一轮会被某件事唤醒」——纯 `inject` 不会自己开轮次。

> 关键取舍：**C 不产生可见气泡**，用户可能以为「文件没上传」；B 可见但伪造用户发言；A 最诚实但多一步。建议 v1 用 C + 客户端 toast/提示条，把「路径已注入」明确告诉用户。

## 5. 工作区浏览与下载

### 5.1 现有 API 与上限 [已核实]

| 能力 | API | 上限 / 约束 |
|---|---|---|
| 列目录 | `remote.workspaceFiles.list(sessionId, absolutePath)` | 仅会话工作区内；`maxEntries` 2000，超出截断（`workspace-files/README.zh.md:74-79`） |
| 读文本页 | `read(path,{offset,limit})` | 页 ≤2 MiB、≤5000 行、只 UTF-8（非 UTF-8/NUL → `not-text`）（同文件 L45,55） |
| 读字节 | `readBytes(path,{range})` | 不带 range 的整文件 ≤32 MiB，超限 `too-large` 而非截断（L49-51,75） |
| 搜索 | `search({query,…})` | rg 子进程；`maxResults` 512、`maxEntries` 100000，可 `truncated/incomplete`（L60-64,78-79） |
| 跟随变化 | `changes(path)` 流 | 目录只监听直接子项（L68） |
| 原始文件 URL | `GET|HEAD /api/file?path=<绝对路径>` | **完整文件、忽略 Range**、>50 MiB 返回 413、带 `nosniff`+沙箱 CSP、版本化 immutable 缓存（session-controller README:93） |

### 5.2 手机下载到本地：现有机制够不够

- 「下载」= `ctx.fileActions.save()` → `URL.createObjectURL(blob)` + 触发浏览器下载（`ui-file-actions/src/client/files.ts:37,42,57`）；**Web 端只返回 `requested`，不知道保存到哪**，也没有「另存为」（README:34）。iOS Safari/PWA 上 blob 下载落到「文件」App 还是新标签页预览，**未证实**，必须真机验证。
- 数据来源决定大小上限：
  - 走 `readBytes` 的「会话文件」→ **32 MiB 硬顶**；
  - 走 `/api/file?path=` 的原始 URL → **50 MiB 硬顶**，且不支持 Range（不能边下边播/续传）；
  - 两者都不适合视频/大压缩包。
- **大文件/任意大小的可行解**：插件自建 `connection.fetch` 路由做流式下载（`requestBody` 只影响上传；响应可流式），自己实现 Range/分片与限速——这是必须写插件的部分（§6）。
- **二进制**：`readBytes` 返回 `Uint8Array`（multipart 传输，无 base64 膨胀）（workspace-files README:51），对手机内存友好，但要整段拿。
- **中文文件名**：源码里没找到专门处理；`save()` 只做「去平台保留字符 + 255 字节上限 + MIME/后缀纠正」（ui-file-actions README:32）。**中文名在 iOS/Android 下载中的表现未证实**；服务端 `/api/file` 用 `mime-types` 定类型，文件名来自 URL/查询而非 `Content-Disposition`（session-controller README:93）——这对「下载后叫不叫原名」不利，值得实测。

## 6. 推荐架构：手机端 = DSH Web PWA + 文件桥插件

### 6.1 形态

```text
手机（已装 PWA，同源 HTTPS: https://dsh.lan/）
  ├─ 现有 DSH Web GUI：会话/对话/模型/工作区树/预览/下载   ← 纯配置，不改 DSH
  └─ 文件桥插件（新增）
       ├─ 客户端半：composer 按钮 + 上传进度 + 结果提示
       │            （slot: conversation.input.right / conversation.input.activity）
       ├─ Host 半：POST /bridge/upload（connection.fetch 流式路由，已认证）
       │            → 校验大小/类型/文件名 → 写 <workspace>/inbox/YYYY/MM/DD/<device>/
       │            → 原子 rename + manifest 行（复用 #8 的 inbox 契约）
       └─ 注入：agent.inject(...) 一条「已上传 + 相对路径 + 大小/MIME」
                失败退化：下次打开时 inputActions.setDraft('@inbox/…')
```

### 6.2 纯配置 / 必须写插件 / 明确不改

| 分层 | 内容 | 证据 |
|---|---|---|
| **纯配置（0 代码）** | HTTPS + `--public-url`/`--trusted-host` + 单令牌换 cookie；手机装 PWA；现有对话、工作区树、预览、≤32/50 MiB 下载、composer 上传（落附件库，模型拿 handle 路径） | #2；§1.1、§3.1、§5.1 |
| **必须写插件（客户端）** | composer 里的上传按钮/进度/结果提示；失败回退写草稿；移动端浮层 portal；按 UA 只对手机显示（可选） | §2.2；slots.zh.md L119 |
| **必须写插件（Host）** | `/bridge/upload` 流式路由（**必须** `connection.fetch`，不要裸 `webServer`）；写 inbox + manifest；`agent.inject` 注入；可选 `/bridge/download` 大文件流式下载 | §2.2、§4、§5.2 |
| **必须改 DSH** | **无**。所有点都是公开扩展点 | — |
| **不做** | 改 manifest/scope（不 patch 改不了）；写会话文件；桌面 `__DSH_HOST_PATHS__` 路径 chip（Web 没有） | §1.1、§3.3、§4-E |

### 6.3 工作量级：**中**

拆成三块，各自都有明确的验收面：

1. **Host 上传路由 + inbox 契约（中）**：流式接收、大小/类型策略、原子写 + manifest、错误码（413/415/401），以及和 #8 的 inbox 布局对齐。风险点是「上传失败留半截文件」和并发重名。
2. **客户端 UI（中）**：slot 注册、`<input type=file>` 拍照/相册、进度、取消、失败重试提示、`fixed` 浮层 portal、手机窄屏布局。这块的**真机调试成本**远大于代码量（iOS 相册/HEIC、键盘、安全区）。
3. **注入与回执（小-中）**：`agent.inject` 一行，加「没有活 Agent」的退化路径；要做对必须想清楚「用户怎么知道注入成功」。
4. **打包/升级（小）**：`dsh.client` + patch + `dsh plugin --profile web add`（#9 已给流程），CI 里跑 `--dump-config` 验证。

### 6.4 如果该架构不可行：替代方案与代价

| 替代 | 做法 | 代价 |
|---|---|---|
| 独立 PWA 重建聊天 | 自建页面 + `/connect` + mux WS 自己实现流式/历史 | **大**：重写会话 UI、流式渲染、附件；工作区树/预览全丢；DSH 升级时协议要跟 |
| API peer 旁路桥 | 旁路服务持 API cookie，收文件写工作区，再经 mux 发 prompt | **大**：多一个常驻服务 + WS 协议维护；无 UI 反馈；#2 已指出 `/connect` 的 Peer 生命周期坑 |
| 只做附件库上传（不写工作区） | 用户用现有 composer 上传，agent 从 handle 路径读 | **小**，但不满足「文件在工作区」：只读、无 GC、不能预览、不能改名/移动（#8 §2.4） |
| Share Target / 系统分享 | Android Chrome 可注册，iOS 不支持 | 见 #3：v1 不做 |

## 7. 风险与未解问题

### 风险（按影响排序）

1. **升级兼容**：插件契约（Slots/Remote/`dsh.client`）随版本演进；不兼容 bundle 会被**静默跳过**（`skippedBundles`，见 #9 F6），表现是「功能突然没了」。缓解：钉精确版本 + `engines.dsh` + 升级后跑 `--dump-config` diff。
2. **自定义路由的鉴权**：`webServer.register` 的路由**不经过 DSH 认证/来源栅栏**（webserver README:132），一旦用它做上传就是「内网任何人可写工作区」。必须用 `connection.fetch.register`（connection README:34,49），并在 handler 里再做大小/类型/文件名白名单。
3. **指令注入**：上传内容若以 `AGENTS.md`/`CLAUDE.md`/`.git` 原名落进 workspace，会被 agent-instructions 当指令加载（#8 §2.6）。文件名必须前缀化，原名只进 manifest。
4. **PWA 无 SW 的后果**：无离线、无断点续传；iOS 切后台页面被挂起（#3 TL;DR 6），大文件必须前台传完。
5. **移动端体验缺口**：无安全区、键盘只按 layout viewport、中栏 <400px（§1.3）。这些是 DSH 本体问题，插件只能在自己的 UI 里补，改不了整体。
6. **`inject` 的时机语义**：不唤醒驱动器——如果用户传完就锁屏、下一轮迟迟不来，路径「进了上下文但没人用」。要有可见反馈或退化到 `followup`。
7. **凭据/令牌**：同 #2；新增路由不要自带第二套认证（会变成两层登录）。

### 未证实（必须真机/目标环境验证）

- **未证实**：iOS Safari / 已安装 PWA 里 `blob:` 下载的实际落点与是否保留原文件名（中文名尤其）。
- **未证实**：`agent.inject` 注入的一条上下文，在「下一个被接纳的步骤」里以什么角色/顺序出现在模型请求中（源码说落在下一步，未见请求装配细节）。
- **未证实**：Web 端是否存在任何受支持的 manifest 覆盖/注入点（`tapIndex` 能否安全替换 `<link rel=manifest>` 未验证）。
- **未证实**：`isMobileDevice()` 在 iPadOS 桌面模式 / 微信内置浏览器里的判定，进而影响「是否显示上传按钮」。
- **未证实**：`workspaceFiles.readBytes` 32 MiB 与 `/api/file` 50 MiB 上限在手机内存压力下是否实际可用（未在真机测大文件）。
- **未证实**：插件 UI 在 PWA standalone 模式与浏览器模式的差异（安全区、下载、文件选择器行为）。

## 8. 一手来源索引（tag `dsh-v0.2.2-rc.5`）

- PWA：`apps/web/public/manifest.webmanifest`、`apps/web/index.html`（L5-L9）
- 布局：[ui-layout README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-layout/README.zh.md)（L30、L34、L101）、[columns.ts:21](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-layout/src/client/columns.ts#L21)
- 移动判据：[ui-primitives/focus.ts:12](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-primitives/src/focus.ts#L12)、[ui-primitives README.zh.md:30](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-primitives/README.zh.md#L30)
- 输入/composer：[ui-conversation README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-conversation/README.zh.md)（L77、L89、L97、L103、L119、L133）、[contract/input.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-conversation/src/client/contract/input.ts)（L264-293、L306-326）
- Slots：[docs/subsystems/slots.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/slots.zh.md)（L27、L45-51、L111-121、L186-198）
- Client 架构：[docs/subsystems/web-client.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/web-client.zh.md)（L32、L44-48、L60）、[client-modules.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/client-modules.zh.md)（L5、L94、L104）
- 打包/安装：[adding-a-package.zh.md:38](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/cookbook/adding-a-package.zh.md#L38)、[package-manifest README.zh.md:33-43](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/util/package-manifest/README.zh.md#L33-L43)、[hmr README.zh.md:28-36](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/hmr/README.zh.md#L28-L36)
- 上传链路：[file-upload/src/protocol.ts:2](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/src/protocol.ts#L2)、[file-upload/src/index.ts:80-87](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/src/index.ts#L80-L87)、[file-upload README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/README.zh.md)（L28、L47、L88-91）、[llm/content.ts:158](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/llm/llm/src/content.ts#L158)
- 认证路由/载体：[connection README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md)（L34、L41、L43、L49）、[webserver README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/host/webserver/README.zh.md)（L61、L63、L132）
- 发消息/代理注入：[contract/session.ts:98-103](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/session-controller/src/client/contract/session.ts#L98-L103)、[sessions/session.ts:270-290](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/session-controller/src/client/sessions/session.ts#L270-L290)、[session-controller types.ts:80-88](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/session-controller/src/types.ts#L80-L88)、[agent README.zh.md:58-68](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/agent/README.zh.md#L58-L68)、[schedule/src/index.ts:723](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/schedule/schedule/src/index.ts#L723)
- 工作区/下载：[workspace-files README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-files/README.zh.md)（L28-37、L45、L49-51、L74-79、L92-94）、[ui-sidebar-files README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-sidebar-files/README.zh.md)（L48、L59、L64、L119）、[ui-file-actions README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-file-actions/README.zh.md)（L32-34）、[ui-file-actions/src/client/files.ts:37-57](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-file-actions/src/client/files.ts#L37-L57)、[session-controller README:93](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/session-controller/README.zh.md#L93)
- 桌面路径桥：[apps/desktop/src/preload-app.ts:110](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/desktop/src/preload-app.ts#L110)
- 手机视口 e2e：[schedule-phone.e2e.ts:89](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/web/tests/schedule-phone.e2e.ts#L89)、[client-plugin-live.e2e.ts:134](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/web/tests/client-plugin-live.e2e.ts#L134)
