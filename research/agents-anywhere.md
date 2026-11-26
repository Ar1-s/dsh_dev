# Agents-Anywhere 参考架构评估（研究笔记）

> 票：[#13「Agents-Anywhere 参考架构评估」](https://github.com/Ar1-s/dsh_dev/issues/13) · map [#1「DSH 内网服务器与手机客户端 v1」](https://github.com/Ar1-s/dsh_dev/issues/1)
> 分支：`research/agents-anywhere` · 文件：`research/agents-anywhere.md`
> 评估基线：[`anywhere-labs/Agents-Anywhere`](https://github.com/anywhere-labs/Agents-Anywhere) `main` @ [`65aa221`](https://github.com/anywhere-labs/Agents-Anywhere/commit/65aa2214d340df7a832f529855be4de0d5afb58a)（2026-11-25）；npm 包 `@agents-anywhere/dsh-bridge-next` 最新为 2.1.0（2026-10-26），仓库源码已是 2.2.0。
> 证据口径：[已核实] = 本次直接读到源码/文档/npm 元数据；[未证实] = 合理推断或未在目标环境（DSH 0.2.2-rc.5、Linux 容器、真机）验证。只把一手来源用于结论；二手文章只用于找线索。
> 与既有笔记的关系：DSH 侧 PWA/插件/文件模型见 #6/#8/#9 的笔记，本文不复述；本文只评估 AA 及其对 v1 的可用面。

## TL;DR

1. **AA 解决的是「从别的设备远程控制工作机」**：Clients ↔ Server ↔ Connector ↔ Runtime。手机/Web/桌面客户端都连 AA Server，Server 再经 Connector 调工作机上的 Codex/Claude/DSH（[README L111](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/README.md#L111)、[README L95](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/README.md#L95)）。我们 v1 是单用户内网 + DSH Web PWA，**这个问题 DSH Web 自己已经回答了**，AA 是第二套控制面。
2. **DSH bridge 不需要 patch DSH**：它用官方插件打包（`dsh.bundle.patch` + `dsh.client`）、Cordis 服务注入、官方客户端 slot、官方 `approval/request` 与 `fileUploads.uploadStream`，并以 npm 包形式装进官方 DSH Desktop（[插件 README L9](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L9)、[TECHNICAL L44](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L44)）。**唯一「非公开契约」是它借用了 DSH Web 客户端的 `$events` 内部线上协议**，并按方法签名自适应；这不是 DSH 插件 API，属于版本脆弱面。
3. **直接采用 AA 的 Server/Connector/手机 App 与 v1 匹配度低**：要 Postgres 17 + Redis + Alembic 迁移 + 账号/管理员/OAuth client + Python 3.12/uv 的 Connector + HTTPS/域名；v2 还把会话/时间线/附件落进 Server 库（[插件 README L107](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L107)、[server README L3-L6](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/server/README.md#L3-L6)）。
4. **组件不能脱离 AA Server 单独用**：插件要 Connector 发布 rendezvous 才注册 `aa.dsh.v2.Bridge`；Connector 要 AA Server 凭据才启动；没有 Server/账号时插件停在 `waiting_bridge`（[contracts L13-L29](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/contracts/dsh-bridge/2.0/README.md#L13-L29)、[connection.ts L137-L139](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/connection.ts#L137-L139)）。
5. **可借鉴的是 5 个「局部正确性」设计**：设备绑定记录、上传暂存/校验/幂等、断线检查点与缓存一致性、时间线 ID/upsert 语义、审批请求同一性。它们都能在没有 AA Server 的情况下落进我们自己的文件桥契约；不必搬它的架构。
6. **明确建议：v1 不采用 AA Server/Connector/手机 App，只借鉴上述 5 点**；把「直接复用」留到触发条件成立后再做 1–2 天 spike（见第 5、6 节）。

## Findings

### F1 它是什么、版本基线 [已核实]

- 仓库 2026-05-22 创建，Apache-2.0，GitHub 3,776 stars / 317 forks / 106 open issues，最后 push 2026-11-25（GitHub API，2026-11-26 查询；[仓库页](https://github.com/anywhere-labs/Agents-Anywhere)）。票面「约 3.7k stars」与本次一致。
- v2 自托管 = PostgreSQL 17 + Redis + 一次性迁移 + FastAPI Server + 同源托管的 Web；附件可走本地卷或 S3（[docker README L117-L122](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docker/README.md#L117-L122)、[README L132](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/README.md#L132)）。
- 仓库同时在迁 v3：轻控制面（账号/设备/隧道/MCP/云盘元数据）+ MeshCall Router，**对话/消息/附件留在工作设备的 Connector 上**，加密设备走 E2EE（[v3 self-hosting L8-L14](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/self-hosting.md#L8-L14)）。v3 自托管要 3–4 个 DNS 名与 Caddy，Router 目前单实例，且文档自述「还没有在公网服务器上用真实证书部署过」（[L18](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/self-hosting.md#L18)、[L65](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/self-hosting.md#L65)、[L67](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/self-hosting.md#L67)）。
- 手机端是原生 App（iOS/Android）+ Web + 桌面，不是 DSH Web 的 PWA（[README 下载表](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/README.md#L30-L38)）。

### F2 插件形态：官方打包，不 patch DSH [已核实]

- 包 `@agents-anywhere/dsh-bridge-next` 通过官方 `dsh plugin --profile <p> add` 安装；官方 DeepSeek Harness Desktop 没有内置，需要从 npm 装；同组织的 DSH Desktop 内置它（[插件 README L9](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L9)、[L33](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L33)）。
- `package.json` 用官方字段：`dsh.bundle.patch = ./cordis.patch.yml`（补丁内容只是把插件自己 insert 进 profile）与 `dsh.client.platform = web`、`dsh.client.inject = [...dsh-client-*]`（[package.json](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/package.json)、[cordis.patch.yml](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/cordis.patch.yml)）。**这是插件 bundle 的 patch 机制，不是 DSH 源码 patch。**
- peer 范围 `@deepseek-ai/dsh-typert-protocol >=0.2.0-rc.1 <0.3.0-0`，自动化验证基线是 DSH `0.2.3-alpha.2`（源码）/ `0.2.1-rc.2`（npm 2.1.0 的 devDeps）；范围内的其他版本「只声明、不验证」（[插件 README L92](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L92)、[TECHNICAL L44](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L44)、[npm 2.1.0 package.json](https://unpkg.com/@agents-anywhere/dsh-bridge-next@2.1.0/package.json)）。我们的目标是 DSH 0.2.2-rc.5（map #1），**落在 peer 范围内但不在 AA 的验证基线里** [未证实]。

### F3 传输拓扑：Connector 拥有 Router，插件注册 Bridge [已核实]

- 2.0 用 MeshCall 取代手写 JSON-RPC：Connector 进程启动本机 Router（macOS/Linux 是 `~/.agents-anywhere/router/<instanceId>.sock`，Windows 是命名管道），在 `~/.agents-anywhere/dsh-bridge/connector.json` 发布 rendezvous（endpoint + `dsh-bridge` key）；插件读到后连 Router、注册 `aa.dsh.v2.Bridge`（[contracts L13-L29](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/contracts/dsh-bridge/2.0/README.md#L13-L29)、[TECHNICAL L179](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L179)）。
- 角色与 API key：`connector` / `host` / `dsh-bridge` 各有注册面与调用面，key 形如 `mk_<id>_<hex>`，Router 按 id 查表比对 SHA-256；**不走 HTTP**（[contracts L23-L29](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/contracts/dsh-bridge/2.0/README.md#L23-L29)）。
- Bridge 的方法面覆盖会话/历史/目录/配置/创建/发送/中断/审批/命令/规划；`sync` 是 server stream，先发 `{kind:"subscribed", projectionVersion, checkpointVersion?}`，随后用 `Sync.ingestBatch` 回传批次（[contracts L38-L48](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/contracts/dsh-bridge/2.0/README.md#L38-L48)）。
- 协议 2.0 是硬切：插件不再写 1.0 的 endpoint 镜像，本机插件、Connector、Desktop 必须一起升到 2.1.0（[release 2.1.0 L24](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/releases/2.1.0.md#L24)）。MINOR 升级不同步时，本机连接会一直停在等待状态（[插件 README L68](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L68)）。

### F4 会话/消息/历史：官方服务 + 投影，不解析原生文件 [已核实]

- Host 服务 `DshRuntimeService` 必须注入 `sessions`、`sessionQuery`、`workspaceRegistry`（[index.ts L22](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/index.ts#L22)）；按需使用 `sessionController`、`agents`、`commands`、`llm`、`permissionPresets`、`agentPresets`、`attachments`、`fileUploads`、`sessionPersistence`、`sessionProjections`、`userApproval`、`userQuestions`、`typertGateway`、`connection` 等官方服务，缺哪个就关闭对应能力，不会崩溃（[native.ts L176-L178](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/native.ts#L176-L178)、[configuration.ts L17-L21](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/configuration.ts#L17-L21)、[catalogs.ts L49](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/catalogs.ts#L49)）。
- 历史读取继续走官方 `ctx.sessionQuery`，不直接解析/修复/改写原生日志；列表用 `sessionQuery.listSessions()`，详情取官方校验后的完整 raw log 再纯转换（[RUNTIME_READS L5](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/RUNTIME_READS.md#L5)）。
- 原生记录 → 统一 Timeline 的映射是显式表：用户消息保留来源；插件注入/空 retry 不输出；tool-call/result 按 callId 合并；`ask_user_question`/`exit_plan_mode` 标为 `tool/input_request`（历史只读）；`approval/asked/decided` 合并成一条 permission；compaction 只做 marker（[RUNTIME_READS L46-L70](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/RUNTIME_READS.md#L46-L70)）。
- ID/内容哈希是平台稳定身份：Server 按 `(sessionId, id)` 写入，同一 ID + 相同 contentHash 的重放不产生新项；`complete=false` 是增量、`complete=true` 是完整替换；各端按平台 ID + 服务器更新序号合并，**不按搜索内容去重**（[timeline-identity L44-L48](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/runtime-protocol/timeline-identity.md#L44-L48)）。
- 发消息带 `clientMessageId`，Bridge 侧缺它直接拒绝（[router.ts L145](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/router.ts#L145)）；Server 的排队消息按 `client_message_id` 幂等，同一 ID 返回已有项且 `created=false`（[message_queue.py L131-L159](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/server/agent_server/infra/repositories/message_queue.py#L131-L159)）。创建+首发失败时返回 `resultUnknown:true`，客户端应「按 sessionId 查询，不要直接重新创建」（[release 2.1.0 L29](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/releases/2.1.0.md#L29)）。
- 原生命令只开放 `/compact`（外加 plan 相关），其他命令名被 Bridge 与 Connector 双重拒绝，避免暴露依赖 DSH 客户端 UI 的入口（[TECHNICAL L208-L216](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L208-L216)）。DSH 0.2.3 在回复下方的操作卡片不会同步，AA 只显示正文（[插件 README L110](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L110)）。

### F5 审批/输入请求：官方 waterfall + 待处理请求同一性 [已核实]

- 插件监听官方 `approval/request` 事件；不满足条件（非 approval、不是本会话、会话不可见）时回 `{kind:'next'}`，把回答权留给原生客户端；满足时把它转成 AA 的 interaction notice（工具名、原因、`allow-once`/`reject`），并声明「A local consumer of the official Remote stream, not a replacement answer provider」（[approvals.ts L14-L33](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/approvals.ts#L14-L33)、[interaction-stream.ts L37](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/interaction-stream.ts#L37)）。
- 回答走 `$events/result`，用 DSH 已鉴权的进程内 `connection.createSharedFetchHandler('/api')`，带 `browserPeer`（旧版回退 `operator`）与 `clientId`；没有 HTTP 出 Host（[interaction-stream.ts L16-L19](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/interaction-stream.ts#L16-L19)、[L45-L51](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/interaction-stream.ts#L45-L51)、[L90-L96](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/interaction-stream.ts#L90-L96)）。
- 同一性：noticeId = `itemId(platformSessionId, 'approval', eventId)`；只允许一次（grant 只作用一次）；轮次结束 `turn/end` 会把仍未处理的审批标成 expired；重连恢复同一个待处理请求，重复提交不会重复批准；原生客户端作答/取消会同步关闭远端通知（[approvals.ts L52](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/approvals.ts#L52)、[L76-L99](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/approvals.ts#L76-L99)、[TECHNICAL L177](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L177)）。
- `ask_user_question` 以 JSON Schema 表单呈现（问题 id、required、additionalProperties:false），plan-review 复用问答卡片并展示完整计划正文（[question-form.ts L91-L93](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/question-form.ts#L91-L93)、[TECHNICAL L177](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L177)）。

### F6 文件：暂存 + 校验 + 官方上传；AA 自己的文件面不做 workspace 围栏 [已核实]

- 上传入口接受的是**不透明 staging ID**，不是调用方指定的文件系统路径（注释：`The Bridge accepts opaque staging IDs, never caller-selected filesystem paths.`）；字段校验 `fileId` / 32 hex `uploadId` / 名字 ≤1024 / 大小 / sha256（[attachments.ts L38-L59](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/attachments.ts#L38-L59)）。
- 发布前：拒绝符号链接、`realpath` 父目录必须等于 staging root、`O_NOFOLLOW` 打开、size 必须与上传声明一致、读时流式 sha256、字节超限在 EOF 前就抛错；图片走官方 attachment store（base64），普通文件走官方 `fileUploads.uploadStream` 拿 receiptId（[attachments.ts L107-L156](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/attachments.ts#L107-L156)）。
- DSH 本地产生的附件不会回传到 AA（「不回传 DSH 本地产生的附件」），AA 发的附件保留 AA 文件引用（[TECHNICAL L44](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L44)）。想从手机取 DSH 会话里的附件，AA 走的是 Connector 的整机文件面，不是这条链路。
- **不要照搬它的文件面**：Connector 的 `resolve_path` 允许绝对路径，`prepare_download` 直接读任意 path，没有 workspace 根围栏（[common.py L28-L32](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/connector/connector/local/common.py#L28-L32)、[file_ops.py L41-L57](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/connector/connector/local/file_ops.py#L41-L57)）。它是「已授权用户可远程管理整台机器」的设计；我们 v1 的下载必须限定在当前 workspace。
- DSH 官方上传本来就不能断点续传、stream 体只能用一次、stream 进度没有总量（[DSH file-upload README L88-L90](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/README.zh.md#L88-L90)）——与 v1「无断点续传」的取舍一致。

### F7 断线/重连/检查点 [已核实]

- Connector 心跳 20 秒、重连间隔 3 秒；插件在 Bridge 连上后即上报 `running`，全量清单建立/同步中断重试期间带 `syncing`/`sync_interrupted` phase，只有 Bridge 不可达才回 `starting`/`error`（[TECHNICAL L36](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L36)、[contracts L71](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/contracts/dsh-bridge/2.0/README.md#L71)）。
- 同步批按 `batchSeq` 严格递增，未知/已结束订阅返回 `subscription_unknown`；Connector 连不上 Server 时整批以可重试的 `backend_unavailable` 失败，插件退避重发同一批，不结束订阅；**检查点只在覆盖的历史被 Server 接受之后保存**（[contracts L60-L74](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/contracts/dsh-bridge/2.0/README.md#L60-L74)）。
- 完整快照走客户端流 `ingestSnapshot`，带 `captureId` 防止被取消的旧流污染下一次捕获；单页 45 MiB、代理上限建议 ≥50 MiB；页内 `snapshotRange` 让每页独立正确，中途失败不会只剩前半段（[dsh-snapshot-uploads L15-L17](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/dsh-snapshot-uploads.md#L15-L17)、[L45](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/dsh-snapshot-uploads.md#L45)）。
- 客户端 realtime 规则：`GET snapshot` 拿 durable cursor → `POST /ws-ticket` → `WS ...?ticket=` → 重连用 `GET /events?after=seq:{n}` 补游标；`/events` 是恢复 API，健康时**不轮询**；只有 durable 恢复不可能时 Server 才回 `snapshotRequired=true`（[realtime L23-L60](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/api/realtime.md#L23-L60)、[L96-L112](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/api/realtime.md#L96-L112)）。
- 会话访问缓存规则：命中已完成初始加载的缓存时先显示、再从已应用游标补齐；恢复失败保留可读缓存；迟到的快照/分页/操作结果不能更新其他会话，也不能覆盖同一会话的下一次访问；缓存按服务器/账号隔离；内存缓存最多 5 个会话、约 16 MiB（[session-cache L7-L12](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/session-cache.md#L7-L12)、[L23-L30](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/session-cache.md#L23-L30)）。
- 它明确**不做**上传断点续传：2.1.0 后慢上传就是更慢的调用返回，没有进度续期（[dsh-slow-upload 开头](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/dsh-slow-upload.md#L3-L5)）。

### F8 配对/账号/移动登录 [已核实]

- AA 是账号体系：插件 OAuth 走临时回环端口 + `state` + PKCE S256 + 一次性授权码；设备注册用 `installationId` 幂等，重试丢响应不会重复建设备；凭据不放进页面状态或跳转 URL（[TECHNICAL L24-L30](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L24-L30)、[binding.ts L134-L155](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/account/binding.ts#L134-L155)）。
- 手机扫码登录：Server 的 `/auth/mobile-login/qr` 生成 120 秒的一次性 login token；手机 `request/status`、Web `confirm`、`exchange` 换 30 天 refresh token；refresh 不延长原有效期（[auth.py L75-L78](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/server/agent_server/api/auth.py#L75-L78)、[release 2.1.0 L27](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/releases/2.1.0.md#L27)）。
- v3 加密设备配对：工作设备本机生成 10 个 Crockford base32 字符的配对码（`XXXXX-XXXXX`，50 bit 随机），10 分钟有效、只能用一次、最多 8 次握手尝试；扫码/粘贴走 `aa-pair://v1/...`，PSK 混入 Noise `IKpsk2`，服务端换不了设备公钥（[e2ee L39-L58](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/e2ee-admission-proposal.md#L39-L58)）。
- 对 v1：账号/OAuth/二维码登录**不适用**（我们只有 DSH 启动 token + 长寿命 cookie）。可借的是「设备 ID + 绑定记录 + 一次性码/幂等注册」的形状，不是它的账号栈。

### F9 移动 UX：控制面与阅读规则 [已核实]

- 产品分工明确：「手机负责控制，工作设备负责执行」，工作设备必须开机、联网、Connector/Runtime 正常（[README L95](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/README.md#L95)）。
- v3 移动 WebView 契约里可借的具体项：`theme.insets`（安全区）与原生层配合、`conversation.cached` 带 `stale:true` 的离线只读缓存、原生的「回到底部」、审批卡片作答（[mobile-bridge L21-L26](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/mobile-bridge.md#L21-L26)、[L53](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/mobile-bridge.md#L53)）。
- 阅读规则：向上阅读时保留阅读意图，刷新运行信息不能强制滚到底；原本跟随最新消息时继续跟随（[session-cache L16](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/session-cache.md#L16)）。
- 它**不是** DSH Web 的手机布局；AA 的客户端是自己的 UI，DSH 客户端插件（如我们的文件桥托盘、todo 板）不会出现在 AA 里 [推断]；DSH 自己的 action card 也不同步 [已核实]（[插件 README L110](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L110)）。这决定了「采用 AA 当手机客户端」= 放弃 DSH Web 的插件 UI。

### F10 运维/数据路径 [已核实]

- 插件数据在 `~/.agents-anywhere/dsh-bridge-next/`；它启动的 Python Connector 用其 `connector/` 子目录；venv 在插件数据目录创建；日志统一由 Connector 写 `~/.agents-anywhere/logs/`；本机共享记录 `~/.agents-anywhere/connector-runtime.json` 由 Python 统一维护；插件用 manager lock 防止两个插件实例分走调用（[TECHNICAL L184-L194](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L184-L194)）。
- v2 的数据主权在 Server：PostgreSQL 存 users/connectors/sessions/timeline/catalogs/runtime config，Redis 存在线租约/路由/失效/pub-sub/短期 ticket/未刷盘 Timeline；附件走文件后端（[server-architecture L25-L28](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/server-architecture.md#L25-L28)）。v3 才把内容留在设备（[v3 self-hosting L14](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/self-hosting.md#L14)）。
- 仓库处于 v2→v3 迁移期，文档版本自身有漂移：docker README 说 schema `v2_35`，upgrading 说目标 `v2_55`（[docker L9](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docker/README.md#L9)、[upgrading L23](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/upgrading.md#L23)）；v3 迁移会**永久删除** 2.x 的 connectors/device_runtimes/pairing_codes 表（[migration-3.0 L14](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/migration-3.0.md#L14)）。采用 v2 等于接一个正在换代的平台。

### F11 许可证与 npm/源码差异 [已核实]

- 仓库 Apache-2.0，README 说明此前 MIT 代码的声明保留在 NOTICE（[README L165](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/README.md#L165)、[NOTICE](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/NOTICE)）。仓库源码的 `dsh-bridge-next/package.json` 版本 2.2.0、license Apache-2.0。
- **npm 2.1.0 的 package.json 仍写 `"license": "MIT"`**（[unpkg 2.1.0](https://unpkg.com/@agents-anywhere/dsh-bridge-next@2.1.0/package.json)），registry 元数据也是 MIT（[registry.npmjs.org/@agents-anywhere%2Fdsh-bridge-next](https://registry.npmjs.org/@agents-anywhere%2Fdsh-bridge-next)）。两种都是宽松许可，但**署名/NOTICE 义务与版本对应关系要按实际拿到的制品核对**，别把仓库的 Apache-2.0 当成 npm 2.1.0 的许可。
- npm 最新 2.1.0（2026-10-26）落后仓库 2.2.0；2.1.0 验证基线 DSH 0.2.1-rc.2，2.2.0 验证基线 0.2.3-alpha.2。**我们如果复用，只能选「钉 npm 2.1.0」或「从源码构建 2.2.0」之一，并各自重验 DSH 0.2.2-rc.5** [未证实]。

## 可借鉴清单（每条给 v1 落地形式）

### D1 设备身份与绑定（借鉴，不做账号）

**AA 事实**：设备注册用 `installationId` 幂等，绑定文件按「服务+账号」隔离、原子写、POSIX 0600；设备失效/被删有明确的人工恢复分支，不静默重建（[binding.ts L55-L134](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/account/binding.ts#L55-L134)、[TECHNICAL L142-L144](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L142-L144)）。v3 用一次性配对码/二维码 + E2EE（F8）。

**v1 形式（候选，待 #12 定稿）**：
- 文件桥维护 `<DSH_HOME>/filebridge/devices.json`（0600，原子替换；容器内 uid 1000）：`{deviceId, name, createdAt, lastSeenAt, revokedAt}`。`deviceId` 由服务端生成（例如 `ph_` + 8 位 base32），客户端只存 cookie 里的不透明引用；**不让客户端自报 deviceId 决定落盘目录**。
- 手机首次进入文件桥时显示「未绑定」；用户在已登录的 DSH Web 里点「添加手机」→ 服务端生成 120 秒、一次性 `pairCode`，页面展示二维码（编码 `<origin>/filebridge/pair#c=<code>`；`#` 后不进 Referer/日志）。手机换取 HttpOnly、SameSite=Strict、Secure、90–180 天的设备 cookie；绑定记录写 `devices.json`。
- 幂等：同一 `pairCode` 重复 exchange 返回同一 deviceId（不重复建）；重放/过期返回 `pairing_expired`；不把 token 放进 URL 查询串（借 AA「凭据不进页面状态/跳转 URL」的规则，F8）。
- 明确 **不做**：账号、OAuth、云登录、多用户；设备数量按 #4 的「单用户多设备」范围由 #12 定，撤销即删 cookie + 标记 `revokedAt`。

### D2 文件上传/下载：暂存 + 校验 + 幂等（v1 核心）

**AA 事实**：不透明 staging ID、size+sha256 校验、拒绝符号链接/路径穿越、流式校验、发布后才算成功；上传请求带稳定 ID；失败结果有 `resultUnknown` 语义，要求按 ID 查询而非重建（F4/F6）。

**v1 形式（候选）**：
- `POST /filebridge/uploads`（同源、走 DSH 已认证的 connection 载体：官方 `ctx.connection.fetch.register({ methods:['POST'], requestBody:'streaming' })`，[file-upload index.ts L80](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/src/index.ts#L80)）流式 body；请求头 `X-FB-Request-Id`（UUIDv4，客户端生成）、`X-FB-Device`、`Content-Type`、`Content-Length`。服务端只接受**生成后的** inbox 路径，不接受任何调用方路径。
- 大小/类型准入：图片 ≤20 MiB、视频 ≤200 MiB 且 ≤60 s、其他 ≤200 MiB，单批 ≤10、并发 1（与 #4/#10 已定边界一致；`60s` 时长校验在服务端做，允许「无法解析时长时按体积兜底」要在 #12 写明）。
- 落盘：`inbox/.staging/<requestId>.<rand>.part`（同卷），边读边算 sha256 + 计数；先校验 `Content-Length` 与上限，再 `fsync`；通过后 `rename` 到 `inbox/YYYY/MM/DD/<deviceId>/<UTC时间>-<sha8>-<净化slug>.<ext>`；失败/中断删 `.part`。拒绝符号链接（`O_NOFOLLOW`）、父目录 `realpath` 必须在 staging root 下。
- 幂等：按 `requestId` 查 manifest（按日 JSONL，沿用 #8 的布局）。已存在则直接返回同一 `{requestId,path,sha256,bytes}`，**不重写文件**；不存在则新建。客户端断线后重试同一 requestId；若响应丢失，调 `GET /filebridge/uploads/<requestId>` 得到 `committed | staging | absent`，**不直接重传**（借 AA 的 resultUnknown 查询语义）。
- 路径注入：上传成功后按 #6 用官方 `inputActions.insertText/setDraft` 把路径挂到当前草稿，用户按发送；不自动发消息。**注意**：DSH 官方 `fileUploads` 的 receipt 是「按 Session 暂存、prompt 准入时消费」，只到附件库，不写 workspace（[DSH file-upload README L47](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/README.zh.md#L47)）；因此 v1 的 inbox 落盘必须自建，不能拿 receipt 当路径。
- 下载：`GET /filebridge/download?path=<workspace-relative>`；服务端对 `realpath` 做 workspace 根 containment（与 AA 的整机文件面相反），≤50 MiB，`Content-Disposition`，不允许目录/符号链接逃逸；不实现 Range（v1 复用 32/50 MiB 通道，见 #6/#10）。
- 能力协商：客户端启动时取 `GET /filebridge/capabilities` → `{schemaVersion, maxUploadBytes:{image,video,file}, maxBatch, concurrency, resume:false, downloadMaxBytes, pairMode:'code'}`；客户端据此禁用/提示。借 AA 的 `initialize.features` 与 effective capability 分层（[contracts L40](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/contracts/dsh-bridge/2.0/README.md#L40)、[capabilities L13-L53](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/api/capabilities.md#L13-L53)）。

### D3 断线重连、缓存与移动 UX 规则（借鉴）

**AA 事实**：cursor + `/events?after=` 恢复、不轮询；`snapshotRequired` 只在无法恢复时；检查点只在服务端接受后保存；`syncing`/`sync_interrupted` 是 phase，不是错误；迟到结果按「每次访问独立生命周期」隔离；离线缓存只读并标 stale（F7/F9）。

**v1 形式（候选）**：
- 上传队列状态机（客户端插件内）：`queued → uploading(progress) → committed | failed(retryable) | unknown`；`unknown` 只能查询，不自动重发；在页面生命周期内保留 `requestId + deviceId`；刷新后不承诺续传（v1 不注册 Service Worker，与 #3 一致）。
- 插件自己的状态指示：`idle / uploading / offline / degraded`；不要把 DSH Web 的「运行中」和插件上传混成一个状态；连接恢复后先 `GET /filebridge/uploads/<requestId>` 对账，再决定重试或丢弃。
- 移动 UX 只做插件自己的面：安全区用 `env(safe-area-inset-*)`；上传按钮/托盘在 `conversation.input.attachments` 槽（DSH 官方 slot，[slots L190](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/slots.zh.md#L190)）；不接管滚动、不改 DSH 布局、不做「回到底部」；离开页面不自动重发。
- 「离线只读」规则：如果插件在断线时缓存了最近一次上传结果，只作为展示并标 `stale`；不能据此判断文件已落盘。

### D4 时间线/会话投影的 ID 与 upsert 语义（借鉴到 manifest）

**AA 事实**：平台 ID 稳定，contentHash 只表示状态、不能当合并键；Server 按 `(sessionId,id)` upsert，同 ID 同哈希重放不产生新项；`complete=true` 是替换、`false` 是增量；删除/移动触发 reset fence（[F4]）。

**v1 形式（候选）**：
- manifest（按日 JSONL + 定期 compaction）每条：`{schemaVersion, requestId, deviceId, finalPath, sha256, bytes, mediaType, originalName, receivedAt, status:'committed'}`。**业务身份 = `deviceId + requestId`**；`sha256` 只做完整性/展示，不做内容去重（与 #10「请求幂等不做内容去重」一致）。
- 重建：manifest 丢失时扫描 `inbox/YYYY/MM/DD/<device>/` 按文件 mtime + 文件名里的 sha8 重建「展示用」索引，但**不能**恢复 `requestId`；服务端返回 `manifest_unknown`，客户端重新生成 requestId 上传（宁可多一个文件，不猜）。这与 AA「旧检查点不匹配就补快照」同思路：状态不可证明时重校准，不猜测。
- 迁移：`schemaVersion` 变化时不复用旧记录；文件名布局变更保持「旧文件不动、索引可重建」（借 AA 检查点/投影版本升级的做法，[F7]）。

### D5 审批/输入请求的同一性与一次性授权（v1 只预留，不实现）

**AA 事实**：noticeId 稳定派生自 `(platformSessionId, 'approval', eventId)`；`turn/end` 让未处理项过期；grant 只一次；重连恢复同一请求、重复提交不重复批准；不满足条件的请求 `next` 回原生（F5）。

**v1 形式**：
- v1 手机端就是 DSH Web，审批/问答**原生已支持**，插件不要拦截、不要镜像、不要提供第二个批准入口——这是降低风险的最简做法。
- 但在文件桥契约里预留：若 v2 做通知/角标，必须使用「稳定 noticeId + 一次性 + 轮次结束过期 + 原生作答即关闭」的模型；不得实现「远程自动批准」或「批量同意」。可把这四条写进 #12 的验收（即使 v1 不实现）。
- 若未来确实需要在插件 UI 里展示审批，**不要**直接复用 AA 的 `$events` 盗听方式；优先走 DSH 官方面向客户端的公开通道（以 0.2.2-rc.5 的插件 API 为准，需另票核实），否则把它列为升级阻塞项。

### D6 移动 UX（只借三条，且只作用于插件自己的 UI）

1. 安全区（`env(safe-area-inset-*)`）与键盘不重叠：只包插件托盘/弹层，不动 DSH 页面布局。
2. 迟到的上传响应/轮询结果只更新发起它的那次访问（带 `requestId` + 组件实例 id），不覆盖新一次上传的 UI。
3. 「上传中/已完成/失败可重试/未知需查询」四态文案明确；失败保留草稿与已选文件，不自动清空。
（「回到底部」「离线只读缓存」归 DSH Web 自己；v1 不碰。）

## 直接采用成本

### 4.1 最小部署面（v2）

| 组件 | 要求 | 来源 |
|---|---|---|
| PostgreSQL | 17，Alembic 迁移；Server 启动时要求 schema 恰好在当前 revision | [docker L117](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docker/README.md#L117)、[server README L41-L44](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/server/README.md#L41-L44) |
| Redis | 在线租约、跨实例 RPC 路由、失效 pub/sub、短期 WS ticket、分布式锁、未刷盘 Timeline + 序列号；AOF `everysec`、`noeviction`、持久卷 | [docker L118-L123](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docker/README.md#L118-L123)、[server-architecture L27-L28](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/server-architecture.md#L27-L28) |
| Server + Web | FastAPI + 同源静态 Web；首启 setup token 建管理员；HTTPS/Caddy | [README L132](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/README.md#L132)、[server README L3-L6](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/server/README.md#L3-L6) |
| 账号/鉴权 | 邮箱注册/登录、管理员、插件 OAuth client、Connector token、30 天移动 refresh | [server README 环境变量](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/server/README.md)、[release 2.1.0 L27](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/releases/2.1.0.md#L27) |
| Connector | Python ≥3.12 + uv；插件内打包源码，首次连接建 venv、按需下 Python/依赖（可配 PyPI 镜像） | [connector README L28-L42](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/connector/README.md#L28-L42)、[TECHNICAL L121](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L121)、[L167](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L167) |
| 数据卷 | PG / Redis AOF / 上传附件（或 S3） | [docker L120-L123](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docker/README.md#L120-L123) |
| 客户端 | 原生 iOS/Android App 或 AA Web；官方 DSH Desktop 需另装 bridge 插件 | [README 下载表](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/README.md#L30-L38)、[插件 README L9](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L9) |

### 4.2 数据路径与治理

- v2：会话/时间线/附件按功能**经过或保存在 AA Server**；自托管时由你部署的实例处理（[插件 README L107](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L107)）。PostgreSQL 是 users/connectors/sessions/timeline 的 durable owner（[server-architecture L25](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/server-architecture.md#L25)）。
- 后果：聊天正文和工具结果进入第二套数据库；备份、保留、删除、审计都要按「有第二轮数据副本」设计。v1 的「内网单用户、数据在 DSH 卷」被破坏。
- v3 改成控制面只存账号/设备/隧道/云盘元数据，内容留设备（[v3 self-hosting L14](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/self-hosting.md#L14)），更接近我们想要的数据主权；但 v3 自述未在公网真实证书下部署过、Router 单实例（[L65-L67](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/v3/self-hosting.md#L65-L67)），且 3–4 个 DNS 名与 4 个对外地址对单机内网是净负担。

### 4.3 运维与升级

- **三件套锁步**：本机插件、Connector、Desktop/Server 的 MINOR 必须一起升；2.0 是硬切；不同步会停在等待状态（[release 2.1.0 L24](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/docs/releases/2.1.0.md#L24)、[插件 README L68](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L68)）。
- **数据库迁移是停写式**：v2.24 起新旧 writer 不得混跑，迁移要备份+维护窗；降级通常不可用（[server README v2.24 段](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/server/README.md#L50-L63)）。我们的 v1 回滚策略是「上一镜像 + 卷快照」，AA 的迁移风险会把回滚复杂度抬高。
- **运行时自举**：插件首次连接会用 uv 下 Python/依赖，装 venv；这与我们「镜像预置依赖、离线可重启、版本钉死」的打包策略冲突（[TECHNICAL L121](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L121)、[L167](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L167)）。
- **单用户/单实例假设**：同一数据目录只允许一个插件实例管理设备，插件用 manager lock 防止两个实例分走调用（[TECHNICAL L186](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L186)、[L194](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L194)）。这与 v1 的「一个容器一个 uid 1000」兼容，但多开/多实例会更麻烦。
- **升级链条长**：AA Server 的 OAuth client、DB schema、Connector venv、插件 peer、手机 App 版本全部要对齐；任一处漂移都可能表现为「手机看不到会话」，排障跨三端。

### 4.4 与单用户内网 DSH 的匹配度

| 维度 | 匹配度 | 说明 |
|---|---|---|
| 单用户 | 低 | AA 以账号/设备/管理员为前提；单用户只是「只用其中一个账号」，系统复杂度不降 |
| 内网 | 低 | v1 的价值是「不出内网」；AA 要把手机、Server、Connector 串起来，v3 还要公网域名/证书 |
| 数据主权 | v2 低 / v3 中 | v2 内容落 Server；v3 内容留设备但平台未成熟 |
| 移动体验 | 中-高 | 原生 App、审批、文件、终端都有；但 UI 不是 DSH Web，插件 UI 不出现 |
| 现有投资 | 低 | 我们的文件桥/todo 板/DSH 布局/插件生态不会自动出现在 AA 客户端 |
| 运维可接受度 | 低 | 多一套 PG/Redis/迁移/账号/OAuth/venv/版本锁步 |
| 离线/降级 | 低 | AA Server 不可用时手机端不可用；DSH Web 仍可用，但用户会认为「系统坏了」 |

### 4.5 组件复用可行性（逐个回答）

| 组件 | 能否脱离 Server 单独用 | 复用方式 | 结论 |
|---|---|---|---|
| `@agents-anywhere/dsh-bridge-next`（npm） | **否**（原样） | 装进 DSH 后等 Connector rendezvous；无 Connector 就停在 `waiting_bridge`，没有对第三方的本地 HTTP API | 不能当文件桥/远程 API 的现成后端 |
| 插件 host 运行时（`src/host/dsh-runtime`，约 4,451 行 TS；全插件 src 约 10,737 行） | 代码层可以，运行层不行 | Apache-2.0 可 vendor；需替换 MeshCall + Sync 传输、重实现鉴权与 `runtime-host` 契约，并按 0.2.2-rc.5 重验 | 「fork 改造」可行，工作量中-大；v1 不值得 |
| Python DSH 适配器（`connector/connector/runtimes/dsh`，约 2,801 行） | 否 | 它实现 AA 的 runtime 协议 + Server 回调，不能独立跑 | 只可读作参考实现 |
| contracts（JSON Schema / fixtures） | 是 | 可当文件桥/同步契约的设计参考；Apache-2.0 | 推荐参考，不必复制文件 |
| Server / Connector / 手机 App | 否 | 必须整体采用；替换不了我们的 DSH Web PWA | v1 不采用 |
| 客户端 UI 组件 | 部分 | 用 DSH 官方 `@deepseek-ai/dsh-client-ui-primitives` 的同类组件即可，不需要 AA 的代码 | 只借交互模式 |

**原样复用的前提（缺一不可）**：① 一个可达的 AA Server（自托管或 Cloud）与账号；② 手机/DSH 所在网络能访问该 Server；③ 工作机上能跑 Python 3.12+ 与 uv（首次连接建 venv，必要时配 PyPI 镜像）；④ Connector 进程成功发布 `~/.agents-anywhere/dsh-bridge/connector.json`；⑤ DSH 版本落在插件 `peerDependencies` 范围内。缺其中任一项，插件都不会进入可用状态，且没有「只连本机、不连 Server」的开关（见 F3、[插件 README L106](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/README.md#L106)）。

**许可证**：源码 Apache-2.0 + NOTICE；npm 2.1.0 元数据 MIT。无论选哪个，二次分发/内嵌都要保留版权与许可声明；**不得使用其商标/品牌**（Apache-2.0 不授予商标权）。如果只是内部部署不对外分发，义务更轻，但仍建议留 NOTICE。

## 触发条件：什么时候从「参考」升级为「直接复用/采用」

| 触发条件（满足任一即评估） | 为什么 v1 解决不了 | 建议动作 |
|---|---|---|
| T1 手机必须**不装 VPN**、从内网外（4G/公网/NAT）直接访问 | v1 只做内网 + Caddy；公网暴露要另做认证/防护/穿透 | 先评估 VPN/Tailscale；若必须直连，再评估 AA v3 的 Router+E2EE |
| T2 需要**多用户/多设备账号**（≥2 人，或需要独立 token/审计/撤销） | v1 单用户、单 token；device 只是落盘分片 | 评估 AA Server 的账号/设备模型；同时评估「Caddy forward_auth + 企业 SSO」而不是 AA |
| T3 需要**原生后台/大文件/断点续传/推送**（PWA 被杀后仍要传/收通知，或 >200 MiB、跨小时续传） | v1 明确不做断点续传、不注册 SW、无 APNs/FCM | 评估 AA 原生 App + Connector；先确认 AA 是否真的支持你要的后台/续传语义 |
| T4 **自研文件桥/客户端连续两次卡住**（同一问题两次迭代未过验收） | 继续自研的边际成本高于换架构 | 起 1–2 天 spike：AA 自托管 + 官方 DSH Desktop + 插件 + 手机 App，按下面的退出标准验收 |
| T5 手机需要**整机文件管理/终端**（超出 workspace） | v1 刻意只做 workspace inbox + 下载 | AA 的 Connector 文件面/终端正好覆盖；但这是新安全边界，需另开 threat model |
| T6 需要**手机 UI 与 DSH Web 不同**（底部导航/原生手势/独立客户端） | 不改 DSH Web 就只能做移动壳/独立客户端 | AA App 是一个候选，但会丢 DSH 插件 UI；先确认「插件 UI 不出现」可接受 |
| 非触发（别因此采用） | — | 「AA 的账号/UI 更好看」「不想写配对端点」「50 MiB 下载不够」「想让手机看 todo 板」都不构成理由；最后一条恰恰是 AA 的弱点 |

**Spike 退出标准（T4 用）**：在目标内网 + 目标 DSH 0.2.2-rc.5 上，① 插件能装、Bridge 能起、会话清单/历史能同步；② 手机审批一次「允许一次」能回到 DSH 原生请求且不重复；③ 手机上传一个附件，DSH 会话能看到；④ 手机下载一个 workspace 文件；⑤ 断网 30 秒重连后无重复/丢失；⑥ 数据落点/备份/升级路径可接受。任一项失败 → 回到 v1 自研，不扩大投入。

## 推荐

**v1：不采用 AA 的 Server/Connector/手机 App，也不把 bridge 插件装进镜像；只借鉴 D1–D5（D6 的三条局部 UI 规则可选）。**

理由（按重要性）：
1. **问题不同**：AA 解「远程控制工作机」；v1 解「内网单用户手机用 DSH」。后者 DSH Web 已经是客户端，引入 AA 等于复制控制面。
2. **数据与运维反向**：v2 让会话内容进第二套 PG；v3 虽好但要求公网/域名/证书/Router，且未成熟；单机内网没有收益。
3. **插件 UI 丢失**：我们的文件桥托盘、todo 板、DSH 布局不会出现在 AA 手机端；采用 AA 等于重做手机端产品，而不是复用。
4. **运行时自举与镜像策略冲突**：插件要 uv/Python 运行时；v1 镜像要预置、离线、可回滚。
5. **可借的部分已经足够**：上传暂存/校验/幂等、检查点、ID/upsert、审批同一性都能在没有 AA Server 的情况下实现。

**给 #12/#14 的可执行条目（建议直接进规格/验收）**：
- 文件桥增加 `GET /filebridge/capabilities`（含 `schemaVersion`、大小/批量/并发/`resume:false`、`downloadMaxBytes`、`pairMode`）；客户端按能力禁用 UI。
- `POST /filebridge/uploads` 增加 `X-FB-Request-Id` + `GET /filebridge/uploads/<requestId>` 对账；manifest 记 `deviceId+requestId`，不做内容去重；失败/未知态不自动重传。
- 上传流水线固定为「staging 同卷 → 流式校验 → fsync → 原子 rename → manifest 追加」，拒绝符号链接/路径穿越/调用方路径；下载做 workspace realpath containment + 50 MiB 上限。
- 设备绑定 `devices.json`（0600、原子替换、deviceId 服务端生成、pairCode 120s 一次性）；撤销/过期有明确错误码。
- 客户端上传状态机四态 + 「未知需查询」；迟到结果按 requestId 隔离；安全区只作用于插件 UI。
- 审批：v1 不改 DSH 原生行为；若 v2 做通知，noticeId/一次性/轮次过期/原生作答关闭四条先进契约。

**如果将来触发 T1–T6**：先做 §5 的 spike，以「退出标准」决定是否采用；在 spike 通过前，不把 AA 写进 v1 架构图，也不把 v1 的验收绑在 AA 上。

## 风险与未解问题

| # | 风险/未解 | 状态 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 插件依赖 DSH Web 内部 `$events`/`typertGateway.wireStream` 协议，且按方法签名自适应（3/5 参数、`browserPeer`/`operator`） | [已核实]（[interaction-stream.ts L16-L35](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/src/host/dsh-runtime/interaction-stream.ts#L16-L35)） | 直接复用会在 DSH 升级时碎；不是公开插件 API | v1 不依赖；若 v2 需要，等 DSH 公开/稳定后再做，或只做只读镜像 |
| R2 | DSH 0.2.2-rc.5 兼容性未验证（AA 只测 0.2.1-rc.2 / 0.2.3-alpha.2） | [未证实] | 采用时可能起不来/部分能力缺失 | spike 必须先在 rc.5 上跑 §5 的六项 |
| R3 | npm 2.1.0（MIT）与源码 2.2.0（Apache-2.0）版本/许可不一致；npm 落后源码 | [已核实] | 许可/功能预期错位 | 钉制品 + 记录 SPDX/NOTICE；不要混用 |
| R4 | v2→v3 迁移期：文档 schema 版本漂移、v3 删 2.x 设备表、v3 未公网验证 | [已核实] | 采用 v2 后可能被迫迁移；数据/设备要重注册 | 只做 spike，不承诺长期平台；v3 稳定前不投入生产 |
| R5 | v2 内容落第二套 PG，备份/删除/审计双份 | [已核实] | 数据治理负担、隐私面扩大 | v1 不采用；若采用，先定数据保留与删除策略 |
| R6 | 运行时 uv/Python 自举 + PyPI 网络依赖 | [已核实]（[TECHNICAL L121](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L121)、[L167](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/dsh-bridge-next/TECHNICAL.md#L167)） | 与内网/离线/钉版本冲突；首次启动可能失败 | v1 不引入；spike 必须验证离线/镜像源 |
| R7 | AA 的 Connector 文件面是整机范围、无 workspace 围栏 | [已核实]（[common.py L28-L32](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/connector/connector/local/common.py#L28-L32)、[file_ops.py L41-L57](https://github.com/anywhere-labs/Agents-Anywhere/blob/65aa2214d340df7a832f529855be4de0d5afb58a/connector/connector/local/file_ops.py#L41-L57)） | 若照搬会扩大攻击面 | 明确不照搬；v1 下载锁 workspace |
| R8 | 手机 App 对自签/内网 CA 的信任未验证 | [未证实] | 内网 HTTPS 方案可能不被原生 App 接受 | spike 真机验证；v1 用浏览器/PWA 可装根证书 |
| R9 | AA 手机端不展示 DSH 插件 UI（文件桥托盘、todo 板） | [已核实] 对 action card；插件 UI 为 [推断] | 采用 AA = 重做手机端功能 | 把「插件 UI 不出现」列为采用前确认项 |
| R10 | v1 若参考过度（把 AA 的暂存/幂等做成通用同步框架）会拖慢交付 | [未证实] | 范围膨胀 | 只落地 D2 的最小闭环；D4/D5 只写契约 |
| R11 | 文档自身漂移（badge 2.0.3 vs release 2.2.0；schema v2_35 vs v2_55） | [已核实] | 按文档操作可能踩坑 | 以源码/迁移/`CURRENT_SCHEMA_REVISION` 为准 |
| R12 | 「AA 能传文件」与「我们要的 inbox 路径注入」不是同一件事 | [已核实] | 误以为采用 AA 就解决上传 | 明确：AA 传的是消息附件，不写 workspace；我们的 inbox 必须自建 |

## 证据索引（一手来源）

- AA 仓库：<https://github.com/anywhere-labs/Agents-Anywhere>（`main` @ `65aa2214d340df7a832f529855be4de0d5afb58a`）
- AA README / 插件 README / TECHNICAL：`README.md`、`dsh-bridge-next/README.md`、`dsh-bridge-next/TECHNICAL.md`
- 桥接契约 2.0：`contracts/dsh-bridge/2.0/README.md`；Runtime 读取与投影：`dsh-bridge-next/RUNTIME_READS.md`
- Server 架构/数据所有权：`docs/server-architecture.md`；Server 运行要求：`server/README.md`
- Realtime/缓存：`docs/api/realtime.md`、`docs/session-cache.md`；Timeline 身份：`docs/runtime-protocol/timeline-identity.md`
- 文件/慢上传：`docs/dsh-snapshot-uploads.md`、`docs/dsh-slow-upload.md`；附件实现：`dsh-bridge-next/src/host/dsh-runtime/attachments.ts`
- 审批/交互：`dsh-bridge-next/src/host/dsh-runtime/approvals.ts`、`interaction-stream.ts`、`question-form.ts`
- 账号/配对/登录：`dsh-bridge-next/src/host/account/binding.ts`、`server/agent_server/api/auth.py`、`docs/v3/e2ee-admission-proposal.md`
- v3 自托管/迁移：`docs/v3/self-hosting.md`、`docs/v3/migration-3.0.md`
- npm：<https://registry.npmjs.org/@agents-anywhere%2Fdsh-bridge-next>、<https://unpkg.com/@agents-anywhere/dsh-bridge-next@2.1.0/package.json>
- DSH 0.2.2-rc.5 一手来源：`packages/host/webserver/README.zh.md`（raw route 不提供服务器级认证）、`docs/subsystems/slots.zh.md`（`conversation.input.attachments`）、`packages/client/file-upload/README.zh.md`（上传无断点续传）、`packages/client/file-upload/src/index.ts`（`ctx.connection.fetch.register`）；仓库 <https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5>
