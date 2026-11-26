# DSH 文件、附件与工作区模型

- 票：#8「DSH 文件、附件与工作区模型」（map #1「DSH 内网服务器与手机上传 v1」）
- 版本基准：本机 DSH 0.2.2-rc.5，对应官方 tag `dsh-v0.2.2-rc.5`
- 分支：`research/dsh-file-model`
- 结论适用范围：单用户多设备；x86_64 Linux 内网主机 + Docker 部署 DSH Web；手机 PWA 上传到服务器 inbox；仅内网 + HTTPS + 单令牌。本文是研究结论与可实施契约，不写实现。

> 方法：只读一手来源——本机安装包内的 `@deepseek-ai/*` 源码/README（0.2.2-rc.5），官方 GitHub 仓同 tag 的文件，以及官方文档。二手文章未用于结论。无法直接验证的项明确标「未证实」。

## TL;DR

1. **工作区不是挂载点，也不是文件索引**：它只是「一个 canonical 目录 + 一个稳定 id + 一组会话」的注册表，模型完全看不见这个注册表；会话真正拿到的是创建时写入 header 的不可变 `cwd`。模型上下文里只有当前目录，没有工作区文件清单。
2. **附件库与工作区是两套存储**：`<DSH_HOME>/attachments/v1` 是内容寻址、只读、按会话消息中的 `FileAttachmentRef/ImageAttachmentRef` 绑定的附件库；工作区文件是普通宿主文件。附件会被复制进附件库，不会反过来出现在工作区；手工往附件库里丢文件不会产生任何消息引用。
3. **agent 的文件读是宿主级、写是沙箱级**：`read`/`glob`/`grep` 能读工作区外的路径（本机实测），而 `write/edit/delete/move` 在默认 `workspace-write` 下被限制在会话 header `cwd`（加临时目录/额外可写根）。需要 read-before-write 的 `fs-observation-policy` 在默认 Web 组合里是关闭的。
4. **sidecar 写进工作区后，agent 下一次工具调用即可见，不需要索引**；Web 文件树只在根目录/已展开目录的 direct-entry watch 上自动刷新，否则要手动 reload；DSH 不会主动通知会话「有新文件」。`@` 补全索引是 advisory，可能滞后，但直接给绝对路径不受影响。
5. **推荐的 inbox 落点**：把 inbox 做成独立 workspace（bind mount 的宿主机目录），按 `YYYY/MM/DD/<device>/` 分片，文件名用「UTC 时间 + 内容短哈希 + 净化 slug」，原始文件名/MIME/大小/SHA-256 写入按日 JSONL manifest。**不要**写 `attachments/v1`，也不要让上传文件以 `AGENTS.md`/`CLAUDE.md` 原名落到会话 cwd（会被指令发现机制读取）。

## 1. 范围与证据口径

本文回答票面五组问题：工作区挂载/选择与会话关系；附件库与工作区文件的关系、附件绑定；大小/类型/权限/删除/去重；sidecar 写入后的可见性；手机上传的目录布局与元数据。

证据分三类，正文逐条给链接：

- **官方文档/包 README（0.2.2-rc.5）**：如 `docs/subsystems/workspace.md`、`docs/subsystems/attachment.md`。
- **官方源码（0.2.2-rc.5）**：如 `packages/attachment/attachment-local/src/*.ts`、`packages/llm/llm/src/content.ts`。
- **本机实测**：Windows 上的 DSH 0.2.2-rc.5 安装；见第 6 节。目标 Linux/Docker 的行为由源码与文档推断，未在 Linux 容器内实测的会标注。

## 2. Findings

### 2.1 工作区是一个目录注册表，不是挂载点或索引

- `Workspace` 的身份是「稳定 UUID + canonical `realpath` 路径 + 标题 + 有序会话 id 列表」。它是 host 侧可选能力（`ctx.workspaceRegistry`），**对模型不可见：没有工具、没有 prompt 文本、没有 session 事件**（[workspace.md:5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/workspace.md#L5)）。
- 注册路径会被 `fs.realpath` 规范化；唯一性按 canonical 路径字符串判定，因此 symlink 指向已注册目录会命中同一条记录；`create` 要求路径已存在且是目录，不存在直接报 `ENOENT`（[workspace.md:19](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/workspace.md#L19)、[workspace.md:124](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/workspace.md#L124)）。
- 删除 workspace **只删除注册、顺序和会话归属**，不删目录、用户文件、活动会话或已落盘日志；这些会话变为 Ungrouped（[workspace.md:124](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/workspace.md#L124)）。
- 默认 workspace 由 controller 在 `<Documents>/deepseek-harness/default-workspace` 初始化；Linux 需要 `xdg-user-dir` 且 Documents 已启用，否则必须配置 `documentsDirectory` 或手工选目录。**精简容器里不要假设默认 workspace 会自动可用**（[workspace-controller README:34](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-controller/README.md#L34)）。
- 这里的「挂载」是 Docker 的事，不是 DSH 的事：DSH 只接受容器内已存在的绝对路径；bind mount 进来的目录对 DSH 就是一个普通目录。

### 2.2 会话与工作区的对应关系

- 新会话的 `cwd` 由 API gateway 从「用户选中的 workspace.path」解析（否则用显式/默认 cwd），在创建时写进不可变的 `SessionHeader.cwd`；然后 `attachSession` 再用这个 header cwd 校验归属（[workspace.md:126](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/workspace.md#L126)、[persistence.md:145](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/persistence.md#L145)）。
- 归属的权威是 workspace 记录里的有序 `sessionIds`，不是从会话当前 cwd 反推；header cwd 与 workspace 路径不一致的会话不会被算进来（[workspace.md:120](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/workspace.md#L120)）。
- `working_directory` 工具可以改「当前目录」，但它改的是 session projection 和后续请求的 user-context，**不改 header cwd，也不改 sandbox 的 workspace root**；sandbox 仍以 header cwd 为边界（[working-directory README:44](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/working-directory/README.md#L44)、[sandbox.md:43](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/sandbox.md#L43)）。
- 会话日志按 `<root>/--<normalized-cwd>--/<encoded-session-id>/session.vN.jsonl.zstd` 存放（[session-persistence-jsonl README:55](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/session-persistence-jsonl/README.md#L55)）。**容器重建后如果把 workspace 挂到不同容器路径，旧会话的 header cwd 与新路径不再相等，旧会话会掉出 workspace 分组（文件不丢，导航上变 Ungrouped）**。这是 Docker 部署必须保持挂载路径稳定的原因之一。
- 本机实测：会话 header 中 `cwd` 为 `D:\dsh_dev`，对应 `~/.dsh/sessions/--D-dsh_dev--/`（见第 6 节）。

### 2.3 agent 读文件的工具边界

- `read` 的相对路径以「会话当前目录」为基准；`fs-local` 的 `cwd` 只是解析默认值，**绝对路径和 `..` 不受限**（[fs-local README:97](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/fs-local/README.md#L97)、[:133](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/fs-local/README.md#L133)）。真正的 containment 由 `fs-sandbox` 提供，而且它**只围栏 mutation（write/edit/patch/delete/move），读、列目录、只读 watch 保持不限制**（[fs-sandbox README:30](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/fs-sandbox/README.md#L30)）。
- Web 默认 `workspace-write`（`dsh-base` 中 `sandbox-policy.mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`；[base cordis.patch.yml:246](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/base/cordis.patch.yml#L246)）。可写集合 = 会话 header cwd + 平台临时目录 + 配置的 `additionalWritableRoots`；`read-only` 禁止所有 mutation；`danger-full-access` 绕过围栏（[sandbox.md:11](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/sandbox.md#L11)、[sandbox-policy README:49](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/sandbox/sandbox-policy/README.md#L49)）。默认 Web 组合把 read-before-write 的 `fs-observation-policy` 行设为 disabled，因此 `write/edit` 不要求先读，也不做跨进程锁——这不是安全边界（[tool-fs README:42](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs/README.md#L42)）。
- 读的文本上限：单次 `read` 默认/最多 2000 行、单行 2000 字符、选中行合计 51200 字节；文件 ≥10 MiB 走流式读取（[tool-fs README:67](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs/README.md#L67)）。`read` 只接受 UTF-8 文本，二进制会报 `FS_NOT_TEXT`；`read_image` 只接受 PNG/JPEG/WebP/GIF，并把图片再持久化进附件库，且要求当前路由模型声明 image 输入（[tool-fs README:48](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs/README.md#L48)、[read-image.ts:27](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs/src/read-image.ts#L27)）。
- `glob`/`grep` 是 process-backed：直接跑打包的 ripgrep，不经 `ctx.fs`，也不受 fs 写沙箱约束；绝对路径会原样传给 rg。因此它们同样能发现工作区外的文件（[tool-fs-search/src/index.ts:9](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs-search/src/index.ts#L9)）。
- 权限细节：`fs-local` 的原子写把新文件暂存为 `0600`，已有文件保留原 mode；Windows 保留 DACL（[fsio.ts:638](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/fs-local/src/fsio.ts#L638)、[fs-local README:76](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/fs-local/README.md#L76)）。会话里的 shell 写文件则遵循进程 umask。**如果 sidecar 是另一个 UID，它默认读不到 DSH agent 新建的 0600 文件**。
- 模型上下文只含 `Current working directory: "<absolute path>".`；没有工作区文件清单（[working-directory README:68](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/working-directory/README.md#L68)）。

### 2.4 附件库：布局、绑定、限制、权限、删除与去重

#### 布局

```text
<DSH_HOME>/attachments/v1/
  objects/<sha256前2位>/<sha256>          # 归一化后的图片对象
  file-objects/<sha256前2位>/<sha256>     # 通用文件对象（逐字节）
  files/<sha256前2位>/<sha256>/<name>     # 通用文件的只读硬链接别名
  tmp/                                    # 写入暂存（0600），发布后删除
<DSH_HOME>/cache/attachments/request-images/   # 按路由生成的请求图片缓存，可清
```

- 图片对象路径与 `sha256:` id 的对应（[store.ts:53](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/store.ts#L53)）；通用文件的 `file-objects` 与 `files` 硬链接（[file-store.ts:77](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/file-store.ts#L77)、[:82](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/file-store.ts#L82)）。
- `DSH_HOME` 解析优先级：显式配置 > `$DSH_HOME` > `~/.dsh`；空环境变量按未设置处理（[dsh-home-paths README:39](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/util/home-paths/README.md#L39)）。
- 对象不可变；图片会先归一化（EXIF 方向、去元数据、2048×2048 总像素预算、8192 长边、4 MiB 目标），GIF 只保留第一帧；通用文件逐字节保存，不做格式/大小准入（[attachment-local README:84](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/README.md#L84)、[:92](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/README.md#L92)）。

#### 与消息/会话的绑定

- 消息内容块 `FileBlock`/`ImageBlock` 里带 `FileAttachmentRef`/`ImageAttachmentRef`（`attachmentId`、`name`、`bytes` 或图片的 `mediaType/width/height`）。session 事件和模型可见块**只保存引用与元数据，不保存浏览器 object URL、宿主临时路径、provider URL 或 base64**（[attachment.md:5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/attachment.md#L5)）。
- 浏览器上传先进入 per-Session 的 staged receipt（`ctx.fileUploads`，按 receiving Agent 的精确 Session 键控），prompt admission 时解析 receipt、再持久化并写 user message；消息落盘前附件必须已经 durable（[file-upload README:47](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/README.md#L47)）。
- 通用文件对模型**永远不发送原始字节**：请求组装时每个 `FileBlock` 被投影成一行确定性的 handle 文本，例如：
  `[File "report.pdf" (12345 bytes, sha256:abcdef12): verbatim read-only copy saved at "/home/dsh/.dsh/attachments/v1/files/ab/abcdef.../report.pdf". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
  （[content.ts:152](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/llm/llm/src/content.ts#L152)）。如果当前执行文件系统映射不到该宿主路径，文本会明确说读不到。
- 图片走 provider 请求版本；模型历史/重启后仍能复用，读取时按完整 `ImageAttachmentRef` 校验 id/格式/字节数/尺寸。图片读取端点按 `sessionId + 完整 ref` 授权，**不校验该图片是否属于这个 Session**（同一个 DSH_HOME 里任何被授权调用该端点的身份都可读）——单用户单令牌下可接受，但令牌泄露等于附件库泄露（[attachment-read-access 升级指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/upgrade-guide/v0.2.1-rc.3/attachment-read-access/guide.md)）。
- 附件对 session 的绑定是「消息里的 ref」，不是路径；所以恢复/派生会话不依赖工作区文件是否还在，反过来工作区文件移动/删除也不影响已存附件。

#### 大小/类型限制

| 类别 | 限制 |
|---|---|
| 图片源文件 | 单张 ≤ 50 MiB、≤ 64,000,000 像素、单边 ≤ 65,535 px；每消息 ≤ 20 张、合计 ≤ 200 MiB 源字节（[attachment-local/src/index.ts:34](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/index.ts#L34)） |
| 图片归一化存储 | 总像素预算 2048×2048、长边 ≤ 8192、编码目标 4 MiB；体积不够时取质量阶梯最小输出（[attachment-local README:55](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/README.md#L55)） |
| 通用附件 | **无 DSH 准入限制**：任意类型/长度，逐字节保存（[attachment README:40](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment/README.md#L40)） |
| `read_image` 读工作区图片 | 先按 `min(maxImageBytes, maxMessageImageBytes)` = 50 MiB 读字节，再走同一套图片准入；扩展名必须是 `.png/.jpg/.jpeg/.webp/.gif` 或可被 magic 识别（[read-image.ts:343](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs/src/read-image.ts#L343)） |
| Web 上传 route | 通用文件流式写入附件库，无 DSH 大小上限；图片最多读 `min(单图, 单消息)` 字节；传输不可断点续传（[file-upload README:47](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/README.md#L47)、[:88](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/README.md#L88)） |
| Web 文件预览 | 文本页/字节窗口 ≤ 2 MiB、完整文件 ≤ 32 MiB、单页 ≤ 5000 行、单目录 ≤ 2000 项（[workspace-files README:74](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-files/README.md#L74)） |
| 变更卡片 | git snapshot 的 `outputMaxBytes` 默认 8 MiB；单文件捕获/比较上限 2 MiB；超过只记 oversized（[workspace-changes README:41](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/deliverables/workspace-changes/README.md#L41)） |

注意：`file-upload` 的图片限制是 DSH 自带 composer 上传通道的；sidecar 直接往工作区放文件不经过它，但 `read_image` 仍会套 50 MiB/64MP 上限。

#### 权限与属主

- POSIX：附件目录以 `0700` 创建/校正，对象与硬链接别名以 `0400` 发布，暂存文件 `0600`（[store.ts:159](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/store.ts#L159)、[:291](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/store.ts#L291)、[:323](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/store.ts#L323)）。所有者是 DSH 进程的 UID；Windows 上表现为只读属性（本机实测对象 mode 0444）。
- 附件库设计上就是「本机、owner-private」；sidecar 不应以写方式进入 `attachments/v1`，只需要读/备份时用同一 UID 或 root。
- 工作区文件的所有者是写它的进程。DSH 新建文件 0600（见 2.3）；sidecar 若要与 DSH 互读，最稳的是**同一 UID/GID**，其次共享组 + `2775/0664`。只读上传（sidecar 写、DSH 读）用 `0755/0644` 即可。

#### 删除与去重

- 通用文件按原始字节 SHA-256 去重：等字节只保留一个 `file-objects` 对象；不同显示名是同一对象的只读硬链接（[attachment-local README:92](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/README.md#L92)）。图片按「归一化后字节」去重。
- **没有删除 API，也没有 GC**：官方明确「stored images are never deleted automatically / nothing collects unreferenced objects」（[attachment-local README:137](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/README.md#L137)）。session 删除、workspace 删除、对象不再被引用都不会触发清理。
- 手工删除对象会让历史里的 ref 读失败（`ATTACHMENT_NOT_FOUND`/`ATTACHMENT_CORRUPT`），而且没有引用计数可查；**不要手工 prune**。备份/扩容是运维责任；`<DSH_HOME>/cache/attachments/request-images` 可安全删除，会按需重建。
- 工作区文件没有 DSH 去重、回收站或索引；删了就是宿主文件没了。sidecar 的保留/归档策略必须自己实现。

### 2.5 sidecar 写入工作区后，DSH 是否立即可见？

**结论：agent 侧「下一次工具调用即可见」，不需要索引；Web 侧只有已 watch 的目录会自动刷新，否则要 reload；DSH 不会主动通知会话有新文件。**

| 消费者 | 是否需要索引/通知 | 看到新文件的时机 | 证据 |
|---|---|---|---|
| agent `read`/`stat` | 否 | 下一次工具调用，按当前 fs 解析/stat | `fs-local` 的 `resolve` 每次调用重新解析；无缓存索引（[fs-local/src/index.ts:147](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/fs-local/src/index.ts#L147)） |
| agent `glob`/`grep` | 否 | 下一次工具调用；rg 每次重新扫描 | process-backed，不走索引（[tool-fs-search/src/index.ts:9](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs-search/src/index.ts#L9)） |
| `@` 文件补全 | 是，advisory | 目录查询直接列实时目录；bare 模糊查询用缓存索引，tool result 后才标记 stale，下一次查询后台重建 | （[file-reference-local README:44](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/context/file-reference-local/README.md#L44)、[:68](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/context/file-reference-local/README.md#L68)） |
| Web 文件树 | 是，watch | 根目录/已展开目录有 direct-entry watch 时自动刷新；否则 reload | （[sidebar-files README:12](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-sidebar-files/README.md#L12)、[workspace-files README:37](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-files/README.md#L37)） |
| 会话模型上下文 | 无机制 | 不会自动出现；需要用户提示、定时任务或外部触发 | 模型只收到 cwd；workspace 注册表无模型面（[workspace.md:5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/workspace.md#L5)） |
| 变更卡片 | 不是 watcher | 按 turn 的 git snapshot + 文件工具编辑捕获；跨 turn 的 sidecar 写入通常不出现 | （[workspace-changes README:44](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/deliverables/workspace-changes/README.md#L44)） |

补充：

- Web 文件树的根是 **session header cwd**，不是当前 working directory；`read` 的相对路径则跟当前 working directory。agent 若 `cd` 到别处，文件树仍显示原 workspace（[workspace-files/src/index.ts:231](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-files/src/index.ts#L231)）。
- `list` 是 workspace-scoped；`read`/`readBytes`/`stat` 允许工作区外路径；目录 watch 要求目录在 workspace 内，文件 watch 可以跟随文件读权限（[workspace-files README:41](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-files/README.md#L41)）。
- 目录是 direct-entry watch，不是递归 watch；新文件出现在已展开目录会触发，深处的子目录要先展开/刷新。`list` 超过 2000 项会被截断（[workspace-files README:77](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-files/README.md#L77)）。
- 如果 inbox 在 workspace 外：agent 仍可读（读无围栏），Web 文件树不能浏览（list 限定 workspace），写工具默认拒绝（除非配置 `additionalWritableRoots` 或注入 runtime grant）。**所以「能被 agent 读」不等于「能被 Web 文件树看到/被 agent 改」**。
- 本机实测：另一个进程写入 `from-sidecar 2026-11-26.txt` 后，立即用 `read` 和 `glob` 读到；`glob` 也能列工作区外 `~/.dsh/storages`（第 6 节）。

### 2.6 适合手机上传的 inbox 契约（按日期/设备 + 元数据）

#### 落点与 Docker 目录

推荐把 inbox 做成 **独立 workspace + 独立卷**，不要混进项目仓库：

```text
宿主机                            容器内                         DSH 角色
/srv/dsh/home            ->     /data/dsh-home                 DSH_HOME 卷（sessions/attachments/profiles/credentials）
/srv/dsh/inbox-data      ->     /data/inbox-data               同一文件系统，供 staging -> final 原子 rename
  staging/                                             sidecar 写 .part，不注册为 workspace
  final/                 ->     /data/inbox-data/final         注册为 workspace（会话 cwd）
/srv/dsh/project         ->     /workspaces/project            可选的第二个 workspace
```

- DSH 端设置 `DSH_HOME=/data/dsh-home`；注册 workspace 时选 `/data/inbox-data/final`。
- 不要把 `staging` 和 `final` 分别 bind mount 成两个挂载点：跨 mount 的 `rename` 会 `EXDEV`。要挂就挂共同父目录，或把 staging 放在 final 内（不推荐，agent 会看到半成品）。
- 不建议把 `attachments/v1` 暴露给 sidecar；它不是收件箱（见 2.4）。

#### 目录布局

```text
<inbox>/                                  # = final，workspace 根
  YYYY/MM/DD/<device-slug>/
    20261126T085257Z-3f9a1c2d-img-0421.jpg
    20261126T085258Z-9b1e77aa-doc-01.pdf
  _meta/
    manifest-2026-11-26.jsonl             # append-only，一份/日
    latest.json                            # 可选：最近 N 条指针
  .gitignore                               # 若误放进 git 仓，至少忽略 inbox 内容
```

规则：

- **按日 + 设备分片**：`YYYY/MM/DD/<device>`，每个叶子目录控制在 ~1000 项以内（Web `list` 上限 2000；树是一级一级展开的）。超了就加 `part-01/`。
- **文件名不保留原名**：`<UTC 时间戳>-<sha256 前 8 位>-<slug>.<ext>`。时间戳可排序；短哈希来自内容，重传幂等；slug 只保留 `[a-z0-9-]` 并截断（建议 ≤ 60 字符）；`ext` 由嗅探出的 MIME 决定，不信任客户端扩展名。原始文件名放 manifest。
- **禁止**上传内容决定目录结构或创建 `.git`、`.dsh`、`AGENTS.md`、`CLAUDE.md`、symlink；这些由 sidecar 白名单控制。原因见「指令注入」。
- 图片在落盘前转成 PNG/JPEG/WebP/GIF 之一；HEIC/HEIF/TIFF/BMP 等先转 JPEG。`read_image` 会先看扩展名（`.heic` 直接拒绝），再嗅探 magic（[read-image.ts:111](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs/src/read-image.ts#L111)）。
- 文本统一 UTF-8（最好无 NUL），否则 `read` 会以 `FS_NOT_TEXT` 失败。音频/视频 DSH 没有专门读取路径（[attachment README:12](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment/README.md#L12) 明确「audio and video have no dedicated handling」），sidecar 应产出转写/缩略图/封面，或者不要把原文件直接丢进 inbox。
- 单文件建议自己设产品上限并记录在 manifest；DSH 对通用文件没有上限，但 `read` 一页只有 50 KiB、图片 `read_image` 有 50 MiB/64MP 上限。

#### 原子写与 manifest

顺序（同文件系统）：

1. 写 `staging/<uuid>.part`，边写边算 SHA-256，`fsync` 文件；
2. 按嗅探 MIME 决定扩展名与最终路径，`chmod 0644`（或 0664），`fsync` staging 目录；
3. `rename` 到 `final/YYYY/.../name`（原子），`fsync` 目标目录；
4. 追加 manifest 行并 `fsync`；
5. 崩溃恢复时扫描没有 manifest 的 final 文件，补记录或移到隔离区。

manifest 每行建议字段（JSONL）：

```json
{"v":1,"id":"01J...","received_at":"2026-11-26T08:52:57.123Z","device":"pixel-8","path":"2026/11/26/pixel-8/20261126T085257Z-3f9a1c2d-img-0421.jpg","original_name":"IMG_0421.HEIC","mime":"image/jpeg","source_mime":"image/heic","bytes":3214567,"sha256":"...","width":3024,"height":4032,"converted":true,"duplicate_of":null,"client_mtime":"2026-11-26T08:52:55Z","status":"stored"}
```

必备：`id`、`received_at`、`device`、`path`、`original_name`、`mime`、`bytes`、`sha256`；图片加 `width/height`，转换过的加 `source_mime/converted`；去重加 `duplicate_of`；保留 `status` 供后续 `stored/processing/processed/error` 状态机。原始文件名只放这里，不要当叶子名。

#### 权限/属主

- 最省事：sidecar 与 DSH 容器进程使用**同一 UID/GID**；目录 `0755`、文件 `0644`。
- 若必须分 UID：建共享组，目录 `2775`、文件 `0664`，并给 DSH 用户组读+执行权限；DSH 写出的 0600 文件对 sidecar 不可读，需要 agent 侧显式 `chmod` 或 sidecar 只处理自己的文件。
- 不要让 sidecar 以 root 写 `0600` 到 inbox；DSH 非 root 会读不到。
- 只读即可满足「上传 -> agent 读」；若 agent 需要移动/删除 inbox 文件，目录要可写，或让 agent 复制到 `outbox/` 由 sidecar 处理。

#### 不要让上传内容变成「指令」

`dsh-agent-instructions` 会从项目根（默认 `.git` 标记）到 session cwd 逐级加载 `AGENTS.md`/`CLAUDE.md`，以及 `.local.md` 变体；首次请求加载 baseline，成功文件操作后再发现更深层文件（[agent-instructions README:34](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/context/agent-instructions/README.md#L34)、[:38](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/context/agent-instructions/README.md#L38)）。如果手机能把 `AGENTS.md` 以原名写进 inbox 根，它就可能被当成 agent 指令。**文件名前缀化 + 原文件名只进 manifest**可以规避；同时拒绝上传产生 `.git`、`AGENTS.md`、`CLAUDE.md`、`.dsh` 等控制名。上传内容一律视为不可信数据。

#### 通知/触发

在 0.2.2-rc.5 的文档与源码中未发现文件 inbox watcher，也没有「新文件」事件。可行触发：

- 用户打开 inbox workspace 的会话，明确说「处理 manifest 中 cursor 之后的新文件」；
- 定时任务周期性跑同一句；
- 外部 sidecar 在写完 manifest 后，通过 DSH 的公共 API 投递 prompt（该集成不在本票范围，未研究/未证实）。

在文件模型层面，**不要依赖 DSH 自动发现**。

## 3. 方案对比

| 方案 | 落点 | agent 读/写 | Web 文件树 | 优点 | 缺点 |
|---|---|---|---|---|---|
| A. 项目 workspace 下的 `inbox/` | `<project>/inbox/` | 可读可写（在 cwd 内） | 可见 | 一个会话同时看项目和上传；零额外 workspace | 污染项目/ git；change card 噪音；项目迁移/删除会带上 inbox；大目录受 2000 项限制 |
| B. 独立 inbox workspace（推荐） | 容器 `/data/inbox-data/final`，宿主机独立卷 | inbox 会话内可读可写 | 可见（root 就是 inbox） | 干净、独立备份/保留/配额；沙箱边界天然等于 inbox；不污染 git | 需要第二个 workspace/会话；项目会话要读 inbox 得用绝对路径（读可以，写不行） |
| C. DSH composer / upload 通道 | `<DSH_HOME>/attachments/v1` | 模型拿到只读 handle 路径 | 不在工作区树中 | 有 durable ref、图片归一化、绑定到消息、重启可复用 | 只能人工在 Web 里逐个上传；不构成服务器 inbox；附件只读；通用文件无自动保留策略 |
| D. sidecar 直接写 `attachments/v1` | 附件库 | 可能能读文件，但没有 ref，不会出现在消息里 | 不可见 | 看似省事 | 无引用、无索引、无 GC、0400/0700 权限、破坏完整性；**不可行** |

## 4. 推荐

**首选 B：独立 inbox workspace + 独立卷 + 按日/设备分片 + manifest。** 它把「手机上传」与「项目工作区」解耦，agent 在 inbox 会话里对文件有读写权（因此可以移动/归档/生成 outbox），Web 文件树也能直接浏览；项目会话若只需要读 inbox，用绝对路径读即可。

具体建议：

- Docker：`/srv/dsh/home -> /data/dsh-home`（`DSH_HOME`），`/srv/dsh/inbox-data -> /data/inbox-data`；workspace 注册 `/data/inbox-data/final`。保持容器内路径长期稳定（session header cwd 不可变）。
- 文件系统：`attachments/v1` 所在卷要支持 hard link（同卷 tmp->objects 发布依赖硬链接）；不要把 DSH_HOME 放到 SMB/NFS 这类可能不支持硬链接/可靠 fsync 的卷上（风险，未在目标环境验证）。
- sidecar：同 UID/GID 或共享组；只写 `inbox-data`，不写 `home`；原子 rename + manifest；图片预转 PNG/JPEG/WebP/GIF；拒绝 symlink/控制文件名。
- agent 工作流：在 inbox workspace 建专用会话，首条 prompt 读取 `_meta/manifest-*.jsonl` 的 cursor；处理结果写 `outbox/`（或 manifest 状态更新），sidecar 负责归档/删除。不要期望 DSH 自动通知。
- 如果必须「一个会话同时做项目和 inbox」：选 A，但把 `inbox/` 加进 `.gitignore`，并接受 change card/快照噪音；或者把 inbox bind mount 到项目工作区内的一个真实子目录（不要用 symlink，Web 目录 list 对指向 workspace 外的 symlink 目录会拒绝）。
- 如果 inbox 必须留在 workspace 外：读没问题，但要让 agent 写就必须配 `additionalWritableRoots`（部署级、物理绝对路径、每次调用校验）或 runtime `registerWritableRoot`（不持久化）；Web 文件树仍不能浏览它。不推荐作为 v1 主方案。

## 5. 风险与未解问题

### 风险

1. **没有通知/index，上传可能一直不被处理**。缓解：manifest + 明确 prompt/定时任务；不要让用户以为「放进去 agent 就会自己看」。
2. **指令注入**：`AGENTS.md`/`CLAUDE.md` 会被自动加载；上传内容一律按不可信数据处理，叶子名必须前缀化，控制名/目录/符号链接白名单拒绝。
3. **UID/GID 与权限错配**：sidecar 以 root 写 0600、DSH 非 root 读不到；DSH 新建 0600 文件 sidecar 也读不到。必须同 UID/GID 或共享组，并在目标容器里实测。
4. **附件库无界增长**：没有 GC；图片/通用文件永远保留。需要配额、监控、备份策略；不要手工 prune。
5. **附件库依赖硬链接和 fsync**：`tmp -> objects` 用 hard link 发布；SMB/NFS/某些 overlay 可能失败。目标卷需验证。
6. **bind mount 的 inotify 不保证**：Web 文件树的自动刷新依赖 direct-entry watch；Docker/NFS/9p 下可能收不到事件，只能 reload。未在目标 Docker 存储驱动上实测。
7. **容器路径变化导致旧会话 Ungrouped**：header cwd 不可变，日志目录按 normalized cwd 存放。升级/换挂载点时保持路径稳定，否则新建 workspace/会话或接受旧会话掉组。
8. **sidecar/agent 并发写同一文件**：DSH 写是原子替换但无跨进程锁；默认也没开 read-before-write。让 inbox 文件不可变（sidecar 只创建，agent 只读/复制），outbox 也按同样规则。
9. **大于工具上限/不支持的格式**：`read` 只读 UTF-8；`read_image` 只读 4 种图片；音视频没有专用读取；大图 >50 MiB 直接读不了。sidecar 必须转换/提取/预览。
10. **Web 目录 2000 项截断**：不要把一天/一台设备的所有文件堆在一个目录；按日+设备+必要时 part 分片。
11. **令牌/附件读取面**：图片读取不校验 Session 归属；单令牌泄露可读同一 DSH_HOME 的附件。仅内网 + 单用户可接受，但要保护令牌/HTTPS。
12. **备份边界**：`DSH_HOME`（sessions + attachments + credentials）与 inbox/workspace 是两个卷；只备份一个会分别丢历史或丢文件。

### 未解/未证实

- **未证实**：目标 Docker 镜像里 DSH 进程的实际 UID/GID；上游 tag 未提供官方 Dockerfile/compose（仓库树里只有测试 fixture 的 Dockerfile，见 [repo tree](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)），镜像需自建或使用社区方案。
- **未证实**：目标宿主机/存储驱动上 chokidar 的 inotify 行为，以及 Web 文件树在「新目录创建 + 文件落入」时是否需要额外展开。
- **未证实**：iPhone/PWA 实际上传的文件类型（HEIC 默认与否）和 PWA 后台/断点续传行为；无论来源，sidecar 都应统一转码。
- **未证实**：是否能在不改 DSH 的前提下，让 sidecar 安全地通过公共 API 触发 prompt；本票未研究该 API 的鉴权/幂等。
- **未证实**：未来版本是否加入附件 GC/引用计数；当前 0.2.2-rc.5 明确没有。
- **未证实**：Docker 容器中 DSH 默认 workspace 初始化是否可用；精简 Linux 容器可能没有 `xdg-user-dir`/Documents，建议显式注册 workspace。
- **未证实**：`additionalWritableRoots` 在目标 profile patch 中的具体写法；字段存在且行为有文档，但需要按部署组合验证。

## 6. 本机复核记录（DSH 0.2.2-rc.5 / Windows）

这些是本机可以直接复现的观察，用来支撑上面的「源码结论」；Linux 上的权限/挂载行为仍需在目标容器复核。

1. **会话 header**：解压 `~/.dsh/sessions/--D-dsh_dev--/session-70b7c715-.../session.v4.jsonl.zstd` 的第一帧，得到
   `{"type":"session","version":4,"id":"session-70b7c715-...","createdAt":...,"cwd":"D:\\dsh_dev","isSeeded":false,"delegationDepth":0,"agentPreset":"ptc"}`。
   说明 cwd 确实在 header 里，且会话目录按 cwd 分组。
2. **附件引用**：某次 `read_image` 的 tool result 中，`image` block 为
   `{"type":"image","attachment":{"attachmentId":"sha256:cd70558f...","mediaType":"image/png","bytes":339522,"width":1240,"height":2772,"name":"host-first-gui.png"}}`。
   说明消息侧保存的是完整 ref，不是路径/base64。
3. **附件库权限**：`~/.dsh/attachments/v1/objects/00/00b798...` 实测 `mode=0444`、`nlink=1`；本机没有 `file-objects/`/`files/`（因为本机尚未上传通用文件）。
4. **外部进程写入可见性**：用独立 PowerShell 进程写 `.probe-inbox/from-sidecar 2026-11-26.txt`，随后立即用 `read` 得到内容、`glob` 得到路径；无需重启/刷新 DSH。
5. **读边界**：`read` 成功读取工作区外的 `C:\Users\s0364\.dsh\storages\workspace.json`；`glob` 用 `path=C:\Users\s0364\.dsh\storages` 成功列出工作区外文件。说明读/发现不是 workspace-scoped（与源码一致）。
6. **沙箱默认**：本机 Web 会话的 runtime context 显示 `workspace-write`；`dsh-base` patch 中默认 `workspace-write`，`fs-sandbox` 生效（与源码一致）。

## 7. 关键源码/文档索引

以下链接都固定到 `dsh-v0.2.2-rc.5`，便于复核：

- 工作区：[docs/subsystems/workspace.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/workspace.md)
- 会话持久化/header：[docs/subsystems/persistence.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/persistence.md)
- 附件：[docs/subsystems/attachment.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/attachment.md)、[attachment-local README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/README.md)
- 附件源码：[store.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/store.ts)、[file-store.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/file-store.ts)、[index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment-local/src/index.ts)
- 文件工具：[tool-fs README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs/README.md)、[read-image.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/tool-fs/src/read-image.ts)
- 沙箱：[sandbox.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/sandbox.md)、[fs-sandbox README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/fs/fs-sandbox/README.md)、[sandbox-policy README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/sandbox/sandbox-policy/README.md)
- 工作区文件浏览/刷新：[workspace-files README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-files/README.md)、[sidebar-files README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-sidebar-files/README.md)
- `@` 索引：[file-reference-local README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/context/file-reference-local/README.md)
- 指令加载：[agent-instructions README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/context/agent-instructions/README.md)
- 变更卡片：[workspace-changes README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/deliverables/workspace-changes/README.md)
- 上传通道：[file-upload README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/README.md)
- 会话存储布局：[session-persistence-jsonl README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/session-persistence-jsonl/README.md)
- 模型侧文件 handle：[content.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/llm/llm/src/content.ts)
