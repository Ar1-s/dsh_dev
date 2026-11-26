# 手机文件桥原型 v1

票：[#5 手机文件桥原型（附件托盘 + 工作区下载）](https://github.com/Ar1-s/dsh_dev/issues/5)（map [#1](https://github.com/Ar1-s/dsh_dev/issues/1)）。
依据：#6 手机端 DSH 客户端交互与认证、#10 文件桥架构与工作区语义、#4 v1 范围与验收边界（客户端版）；浏览器能力见 #3，落点语义见 #8。

零依赖单文件静态页：真选文件（`<input type=file>` + `capture`），**上传与下载都是本地模拟**（按字节推进度、不写盘、不发请求）。

## 和 v0 的关系

`prototype/mobile-upload-flow` @ `a1dee18` 是范围修订前的「独立上传页」。范围改为「DSH Web 客户端 + 文件桥」后，只有**托盘、失败文案、上限校验**这一层被搬过来；外壳、入口、结果呈现全部重做。v0 只作历史参考，不再维护。

## 打开

双击 `index.html`；或 `python -m http.server 8765 --directory prototype/mobile-file-bridge`，本机开 http://127.0.0.1:8765/index.html 。
桌面宽屏下是 390×844 的手机壳 + 状态深链；窄屏（≤760px）自动全屏。

## 状态与演示参数

| 状态 | 参数 |
|---|---|
| 正常聊天 | `?demo=chat` |
| + 号面板（网格） | `?demo=sheet` |
| + 号面板（列表） | `?demo=sheet&sheet=list` |
| 上传中（1 传 2 排队，定格） | `?demo=uploading` |
| 弱网 | `?demo=uploading&speed=weak` |
| 自动重试（重试 1/2） | `?demo=retrying` |
| 失败三分支（断网 / 413 / 401） | `?demo=failed` |
| 路径进草稿（chip + 纯文本） | `?demo=chip` |
| 已发送 + agent 回读路径 | `?demo=sent` |
| 只发附件（不写字） | `?demo=sentonly` |
| 撤 chip → 工作区文件静默删除 | `?demo=removed` |
| 工作区文件面板 | `?demo=files` |
| 下载已请求 | `?demo=download` |
| 登录页 | `?demo=login` |
| 截图模式（390×844，无外壳） | 追加 `&shot=1` |
| 旧的「路径写进草稿」对照 | 任意状态加 `&paths=draft` |

`sheet=grid|list`，`paths=inject|draft`，`speed=fast|std|weak`，`fail=none|second|413|415|401`。
手机里点左上「☰」开调试面板：切面板布局 / 速度 / 注入失败 / 跳状态 / 复制当前参数。

## 已按 #6/#10 定稿写进原型的

- composer 右侧 `+` → 四来源 action sheet：拍照（`capture`）、相册（多选）、录像（`capture`）、文件（多选）。
- **选择即上传**（没有确认页）；单批 ≤10、并发 1、不续传；照片 ≤20MB、视频 ≤200MB 且 ≤60s、其他 ≤200MB。
- 输入框上方托盘：缩略图 / 文件名 / 大小 / 进度；**进度按已传字节算**（`已传 1.43 / 3.40 MB · 42%`）；上传中可「取消」，排队中可「移除」，网络失败自动退避重试 2 次后给「重试」，4xx 不给重试。
- 成功后（**2026-11-26 二轮改判**）：chip 绑定上传结果（文件名 + 大小 + 移除），**路径不再进输入框**；**发送那一刻**才把路径注入消息上下文（`agent.inject`），所以撤掉的 chip 不会进上下文。
- **撤 chip = 撤出上下文 + 静默删除工作区里的对应文件**（原型里同步把文件面板里的那一条拿掉）。
- **只发附件也能发**：没有文字时发送键照样可用，消息就是两个附件卡片；agent 按客户端的方式回一句「收到这几个文件，要我做什么」。
- 对照开关：`?paths=draft` 回到第一版做法（`[附件] <path>` 写进草稿、随消息发出），用来比较输入框拥挤的差别。
- 落点 `<workspace>/inbox/YYYY/MM/DD/<device>/`；文件名 UTC 时间-短哈希-slug.ext；HEIC 派生 JPEG、MOV 原样。
- 工作区下载：复用 `fileActions.save`（32/50 MiB 上限），>50MB 明确不给；浏览器只回「已请求」，落到文件 App 还是新标签页由手机决定。
- 认证：`/login/` 粘 token 换 HttpOnly cookie（90 天），token 不写 localStorage。

## 还没定、留给本票拍板的

- `+` 面板用网格 2×2 还是列表 4 行（两个都能在原型里切）。
- **发送时注入的实现前提**：需要能在「用户按发送」这一刻让插件/Host 出手（注入上下文、提交或删除文件）。这一点还没在 rc.5 上核实；若没有提交钩子，就得靠启发式（draft 清空 + 附件清空）或让 DSH 加回调。
- 撤 chip 的删除现在走「已经落最终路径再删」，另一种更干净的是「上传落 pending，发送时才提交到 inbox/，撤 chip 只删 pending」（要同一个提交时机）。
- 取消的语义：现在取消即从托盘移除（提示「没有写入工作区」）；要不要保留一条「已取消」记录。
- 工作区文件面板的入口放顶栏图标够不够（#6 说复用 DSH Web 右栏，原型是独立抽屉近似）。

## 2026-11-26 二轮修订

- **修 bug**：`+` 面板里的文件入口点不动——遮罩层带 `data-act`，全局 `preventDefault()` 把 `<label>` 的默认激活一起拦掉了。现在全局不再 preventDefault，`<input type=file>` 也从 `display:none` 改成隐形但可聚焦，`?probe=1` 可复验 label → input 的点击链路。
- **路径改由上下文注入**：见上「成功后」。这推翻了 #6 Q4 A 的「路径进草稿」一半，需要在 #12 落规格。
- **三、四轮修订**：注入时机改到「发送那一刻」；撤 chip 视为撤出上下文并静默删除工作区文件；只有附件时恢复客户端式响应并放行发送。

## 版本

`v1 · 2026-11-26`。同一版以 commit + 上表参数为准；后续改动落在 `prototype/mobile-file-bridge` 分支的新 commit 上。