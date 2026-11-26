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
| 工作区文件面板 | `?demo=files` |
| 下载已请求 | `?demo=download` |
| 登录页 | `?demo=login` |
| 截图模式（390×844，无外壳） | 追加 `&shot=1` |

`sheet=grid|list`，`speed=fast|std|weak`，`fail=none|second|413|415|401`。
手机里点左上「☰」开调试面板：切面板布局 / 速度 / 注入失败 / 跳状态 / 复制当前参数。

## 已按 #6/#10 定稿写进原型的

- composer 右侧 `+` → 四来源 action sheet：拍照（`capture`）、相册（多选）、录像（`capture`）、文件（多选）。
- **选择即上传**（没有确认页）；单批 ≤10、并发 1、不续传；照片 ≤20MB、视频 ≤200MB 且 ≤60s、其他 ≤200MB。
- 输入框上方托盘：缩略图 / 文件名 / 大小 / 进度；**进度按已传字节算**（`已传 1.43 / 3.40 MB · 42%`）；上传中可「取消」，排队中可「移除」，网络失败自动退避重试 2 次后给「重试」，4xx 不给重试。
- 成功后：路径以 chip + 纯文本写进当前草稿（`[附件] inbox/2026/11/26/phone-a1b2/1430-3f2a-img-0421.jpg`），删 chip 同时删那行文本；用户按发送后随下一条消息发出，agent 在同一轮看到路径；不自动触发 agent。
- 落点 `<workspace>/inbox/YYYY/MM/DD/<device>/`；文件名 UTC 时间-短哈希-slug.ext；HEIC 派生 JPEG、MOV 原样。
- 工作区下载：复用 `fileActions.save`（32/50 MiB 上限），>50MB 明确不给；浏览器只回「已请求」，落到文件 App 还是新标签页由手机决定。
- 认证：`/login/` 粘 token 换 HttpOnly cookie（90 天），token 不写 localStorage。

## 还没定、留给本票拍板的

- `+` 面板用网格 2×2 还是列表 4 行（两个都能在原型里切）。
- chip 与草稿纯文本同时显示是否冗余，还是只留一种。
- 取消的语义：现在取消即从托盘移除（提示「没有写入工作区」）；要不要保留一条「已取消」记录。
- 工作区文件面板的入口放顶栏图标够不够（#6 说复用 DSH Web 右栏，原型是独立抽屉近似）。

## 版本

`v1 · 2026-11-26`。同一版以 commit + 上表参数为准；后续改动落在 `prototype/mobile-file-bridge` 分支的新 commit 上。
