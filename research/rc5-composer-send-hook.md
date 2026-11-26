# rc.5 Web 端「发送那一刻」钩子核实

> 分支 `research/rc5-composer-send-hook` · 2026-11-26 · 基线 DSH **0.2.2-rc.5**（安装包 asar 源码静态核对，未构建/未运行真实插件）。
> 场景：双端插件在 composer 里放一枚 marker chip，提交那一刻把它换成 workspace 文件路径。
> 本笔记只回答三条主线：①ordinary send 的 default sink 是否调 reference codec、失败是否阻断；②插件能否程序化插 chip、能否从 `InputState.occurrences` 观察撤 chip；③客户端半怎么装配。其余点归入「未验证」。

路径约定：`APP = C:/Users/s0364/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai`。下文所有 `APP/...` 都是可直接复查的字面路径（asar 里用 Node `fs` 读，PowerShell 进不去）。

## 结论先行

1. **有「发送那一刻」的官方机制，但它不叫钩子，就是 `InputTriggerSource.codec.serialize`。** 未被 command claim 接管的普通消息提交时，default sink 在真正把文本交给 Host 之前，用 `serializeDraftPrompt` 把草稿里**每一枚 chip** 逐个交给其 owner source 的 `codec.serialize(ref, signal)` 换成文本；任一 reject ⇒ 本次发送失败，草稿（文字、chip、引用、附件）原样保留，并弹错误 notice。**没有任何更直接的 pre-submit 事件 / slot / service 钩子**（§1.4）。
2. **插件可以程序化插 chip。** `ctx.sessions.scope(sessionId)` 拿到的就是 Session 作用域 ctx（与 `ctx.sessions.binding(id).ctx` 同一个对象），`ctx.conversation.input.for(actx).insertReference(ref, span)` 直接可用；与官方菜单完全同一条路径的写法是 scoped bail 事件 `actx.bail(actx, 'slash/input-insert-reference', { reference, span })`。`span` 是 **detect 坐标**（每枚 chip 占 1 个 U+FFFC）+ `draftRev` CAS；跨包最稳的 span 来源是 session slot 标准 prop `inputActions.captureInsertion()`。**可以**用 `InputState.occurrences`（每项有稳定 `occurrenceId`）观察 chip 被移除，但它区分不了「用户删 chip」和「发送成功清空」——必须叠加 `phase` 的 `sending -> plain` 与 draft 是否被清空来判断（§2.4）。
3. **客户端半的装配契约很窄**：`package.json` 里 `dsh.client.platform: "web"` + `exports["./client"]` 指向一个「classic script 里同步 `window.__ModuleLoader__.load({ id, factory })`」的 bundle，bundle 导出一个 cordis 插件（`apply(ctx)` / `inject`）。服务没有权限/白名单：`sessions`、`conversation`、`inputTriggers`、`slots` 都是 root ctx 上的服务，按名字取（`ctx.inject([...])` / `ctx.get(...)`）。运行时 `require` 只有 11 个平台 seed + 已到达的 boot 行；服务访问不需要 `require`（type-only import 会被擦除）。
4. **对文件桥：主链路成立**——chip 在 composer（`appearance: 'file'` 合法）、提交时 commit pending 并返回路径文本、撤 chip 可观察。但 codec 是「序列化」不是「事务提交」：commit 成功后发送失败不回滚，重发会再次调用（必须幂等），没有 timeout，**返回空串会被静默当成成功且一条消息都不发**（§5）。

---

## 1. 主线一：ordinary send 是否调 codec，失败是否阻断

### 1.1 逐跳调用链（全部一手代码）

| # | 位置 | 关键代码 |
|---|---|---|
| 1 | `APP/dsh-client-ui-conversation/src/client/input/machine.ts:131-136` | Enter 后 `phase = 'sending'`，返回 `{ type: 'default-sink', attempt, draft: attempt.draftSnapshot, mode }` |
| 2 | `APP/dsh-client-ui-conversation/src/client/input/facade.ts:693-696` | `case 'default-sink': this.sinkSerialized(fx.attempt, fx.draft, fx.mode)` |
| 3 | `APP/dsh-client-ui-conversation/src/client/input/facade.ts:727-749` | 见下 |
| 4 | `APP/dsh-client-ui-conversation/src/client/input/prompt.ts:83-88` | `Promise.all(draft.references.map(... await serializeReference(reference.source, reference.ref) ...))` |
| 5 | `APP/dsh-client-ui-input-trigger/src/client/controller.ts:346-352` | `serializeReference(source, ref, signal)`：按 **source 名**在 roster 里找 owner；`owner?.codec === undefined` ⇒ reject；否则 `owner.codec.serialize(ref, signal)` |
| 6 | `APP/dsh-client-ui-conversation/src/client/input/facade.ts:745` | 序列化后的整段 `text` 交给 `deps.defaultSink(text, ...)`，只有这一步才真正发消息 |

`facade.ts:734-748` 原文（节选）：

~~~ts
const inputTriggers = this.deps.inputTriggers?.()
const prompt = serializeDraftPrompt(snapshotDraft(draft, occurrences, undefined, quotes), async (source, ref) => {
  if (inputTriggers === undefined) throw new Error('no serializer for reference source "' + source + '"')
  return inputTriggers.serializeReference(source, ref, attempt.signal)
})
const send = (text: string): void => {
  if (this.dead(attempt)) return
  if (text === '' && draft !== '' && attachmentIds.length === 0) { /* settle success */ }
  this.settleSink(attempt, this.deps.defaultSink(text, attachmentIds, mode, attempt.signal, ...))
}
if (!(prompt instanceof Promise)) { send(prompt); return }
void prompt.then(send, (error: unknown) => { this.failSink(attempt, error) })
~~~

**答案：是。** 草稿里有 reference（chip）时，`serializeDraftPrompt` 一定返回 Promise，每个 occurrence 都会调一次 `inputTriggers.serializeReference(source, ref, attempt.signal)`，所有结果按 span 拼回原文后才是要发送的 `text`；chip 的 `clipboardText` 只是编辑器/持久化投影，**不会**作为降级文本被发出去。

附带确认：随包发布的 `APP/dsh-client-ui-conversation/lib/client.js` 里是同一段代码（grep 字符串 `no serializer for reference source` 命中），说明运行的就是这套逻辑，不是只存在于 src 的旧代码。

### 1.2 失败语义：阻断、保留草稿、报错

- reject ⇒ `facade.ts:788-791` `failSink` ⇒ `{ type: 'sink-settled', ok: false, message: errorText(error) }`。
- `machine.ts:205-217`：`ok === false` 时**不**产生 `commit-draft`，`phase` 回 `plain`；有 `message` 就压一条 error notice。
- 草稿保留：发送失败不触发 `commitDraft`（`facade.ts:704-717` 只在成功时清编辑器并切 undo 历史），用户看到原草稿 + 红色 notice，可直接改。
- 失败原因文案来自 codec 自己 reject 的 `Error`（`errorText`），或 `slash: no serializer for reference source "<source>"`（controller.ts:349）。**owner 缺失/无 codec、codec reject、`inputTriggers` 服务缺失，全都阻断发送**，不会静默降级成 clipboardText（`input-trigger/src/types.ts:135-147` 的契约注释明确写了 "failure blocks the send — never a silent downgrade"）。

### 1.3 必须知道的四个边界（都读自 rc.5 源码）

1. **空串特例：返回 `''` 会被当成成功、且什么都不发。** `facade.ts:741-744`：`text === '' && draft !== '' && attachmentIds.length === 0` 时直接 `settleSink(..., { kind: 'success' })`，随后 `machine` 产生 `commit-draft` ⇒ **草稿被清空，但一条消息都没发**。所以 codec 里「commit 失败」只能 throw，绝不能 `return ''`。（若草稿里还有别的普通文字，`text !== ''`，走正常发送。）
2. **command claim 不经过 codec。** 若 Enter 时被某个 source 的 `matchEnter` 接管成 command（`machine.ts:141-145`、`facade.ts:821-853`），参数直接用 `argsAfter(attempt.draftSnapshot, claim.token)`——即 **clipboard 投影原文**，chip 不会展开。文件桥要避开「草稿以被 claim 的 /命令 开头」这种形态。
3. **abort 只有一个来源：attempt 释放。** `machine.ts:115-128` 每次提交建一个 `AbortController`，`machine.ts:219-227`（`release` 事件）才 abort；`release` 由 `shell.dispose` 发（`facade.ts:608-617`）。用户没有「取消发送」按钮，codec 收到 signal 后如果不理会且永不 settle，`phase` 会**永远停在 `sending`**（编辑器冻结），没有超时兜底。
4. **多枚 chip 是并发序列化。** `prompt.ts:84-87` 用 `Promise.all`，map 顺序发起、完成顺序不保证。同一 `ref` 出现两次会被并发调两次；顺序敏感或需要「按 chip 顺序 commit」的场景要自己排队。

### 1.4 明确回答：没有更直接的 pre-submit 钩子

- **事件**：conversation 包对外声明的 client events 只有 4 个，全是输入机 mutation 动词，没有 submit/send 事件——`APP/dsh-client-ui-conversation/src/client/contract/input.ts:140-166`（`slash/input-begin-command`、`slash/input-insert-reference`、`slash/input-consume-token`、`slash/input-insert-text`）。全 asar 也 grep 不到 `beforeSubmit` / `preSubmit` / `beforeSend` / `willSend`。
- **slot**：`APP/dsh-client-ui-conversation/src/client/contract/slots.ts:219-363` 的 slot 表里没有 pre-send 槽；`conversation.composer` 是 chain（`slots.ts:286-290`），但它的 owner props 只有 `sessionId` / `session` / `pendingInteraction`（`slots.ts:651-659`），拿不到待发文本，只是 UI 替换。
- **`conversation.blocks` 只能让输入失效**，不是 transform：`APP/dsh-client-ui-conversation/src/client/contract/composer-blocks.ts:4-17`（`ComposerBlock` 仅 `reason`），`input/blocks.ts:1-13` 注释写明「the one way another plugin stops a session's input ... an affordance, not enforcement」。
- **default sink 不可替换**：它是 `InputHub.shellFor` 构造 `SessionInputShell` 时闭包传入的 private dep（`APP/dsh-client-ui-conversation/src/client/input/hub.ts:99-185`，sink 实现在 `hub.ts:269-281`），没有任何服务/事件暴露它。
- 内部确实有一个「提交前」回调 `messageSubmitted`（`facade.ts:48-49`、`751-754`），但它只接到产品分析（`hub.ts:124`），不在任何插件面。
- 另有一个不同平面的接管点 `InputTriggerSource.matchEnter`（`APP/dsh-client-ui-input-trigger/src/types.ts:185-200`）：它按行首 trigger 抢整条提交、把消息变成 command，不是「普通消息发送前」钩子，也不适合文件桥（见 §5）。

---

## 2. 主线二：程序化插 chip + 观察撤 chip

### 2.1 拿 session-scoped actx：`scope()` 与 `binding().ctx` 等价

- 服务面：`APP/dsh-api-session-controller/src/client/contract/sessions.ts:149-168`——`scope(id): AgentContext | undefined`、`binding(id): SessionBinding | undefined`、`sessionOf(ctx)`。
- 两者是同一个对象：`APP/dsh-api-session-controller/src/client/sessions/service.ts:509-511` `scope(id)` 返回 `record.ctx`；`materializeScope` 里 `const binding = { sessionId, session, eventSource, ctx }` 与 `record.ctx` 共用同一个 `ctx`（`service.ts:617-628`）。该 ctx 由 `createScope` 打上 scope 身份与过滤函数（`APP/dsh-api-session-controller/src/client/scope.ts:44-58`）。
- **前提：Session 必须是 retained（已打开、有 scope）。** 未打开时 `scope()` 返回 `undefined`；`conversation.input.for(actx)` 也会抛 `conversation.input.for requires a retained Session scope`（`APP/dsh-client-ui-conversation/src/client/input/hub.ts:75-83`）。插件自己 `retain()` 会顺带打开历史，通常没必要；跟随当前 UI 的 slot/会话切换拿 sessionId 即可。

### 2.2 facade 与插入方法

- `ctx.conversation.input` 的类型是 `SessionInputResolver`（`APP/dsh-client-ui-conversation/src/client/service.ts:40-47`），`for(actx): SessionInput`（`contract/input.ts:227-239`）。
- `SessionInput extends InputTarget`，`insertReference(ref, span): boolean` 就在这个面上（`contract/input.ts:177-185`）。实现：`facade.ts:536-542`——守卫只有两条：`phase` 必须是 `plain`/`claimed`，`span.draftRev === this.rev`（CAS）；然后 `draftEditor.insertReference(span, ref, tail)`。**不要求 span 真的是一个 trigger token**（菜单路径只是恰好用 trigger span），折叠 span 也能插（`span-map.ts:114-119` 用 `RangeSelection.insertNodes`；`span-map.ts:69-80` 折叠区间合法）。
- span 坐标系：**detect 投影**，每枚 chip 记 1 个 U+FFFC（`APP/dsh-client-ui-conversation/src/client/input/editor/projection.ts:1-8`、`:20-21`、`:203-250`）。发布出来的 `InputState.draft` 是 **clipboard 投影**（chip 展开成 clipboardText，`facade.ts:864`），所以**不能**用 `draft` 的字符下标直接当 span。
- 官方 span 来源：`InputActions.captureInsertion()` = `{ ...caretSpan(), draftRev }`（`facade.ts:148-162`）。`InputActions` 是「提供给每个 session-scope slot 组件」的稳定面（`contract/input.ts:258-293`），session slot 的标准 props 里就有 `inputActions`（`contract/slots.ts:395-402`）。⇒ 插件注册一个 session-scoped slot（哪怕渲染 `null`）即可拿到与用户光标同步的合法 span；这是跨包最稳的取 span 方式（**由类型与装配代码推断**，未运行验证）。
- 兜底：需要「插到文档末尾/开头」而不想注册 slot 时，可以自己用 `input.state.getSnapshot().draftRev` + 折叠 span（例如 `{start: 0, end: 0}`）直接调 `insertReference`/事件；rc.5 的 span-map 支持 0 位置与文档尾插入（`span-map.ts:37-61`），但 detect 长度没有发布，**末尾位置只能靠 shell 内部 `caretSpan()`，不在 `SessionInput` 类型上**——属于内部实现。

### 2.3 官方插入路径就是 scoped bail 事件

- 事件声明（conversation 公共 `./client` 类型里，带 `mode bail`）：`APP/dsh-client-ui-conversation/src/client/contract/input.ts:148-153` `'slash/input-insert-reference'(request: InsertReferenceRequest): true | undefined`；请求体 `{ reference: ReferenceInsert, span: TokenSpan }`（`contract/input.ts:71-75`）。
- 监听方：每个 Session 的 hub 在 `binding.ctx` 上挂 `actx.on('slash/input-insert-reference', req => shell.insertReference(req.reference, req.span) ? true : undefined)`（`hub.ts:158-168`）。
- 派发方（官方 `@` / `/` 菜单就是这么插的）：`APP/dsh-client-ui-input-trigger/src/client/controller.ts:482-497`，插入分支原文就是
  `return actx.bail(actx, 'slash/input-insert-reference', { reference: outcome.insert, span }) === true`。
- bail 语义：同步跑监听器，遇到第一个非 `null/false/undefined` 返回值即停（`APP/cordis/src/events.ts:222-234`、`:12-14`）；作用域过滤在 `scope.ts:49-52`（同 generation 或未打标 listener），所以用 `sessions.scope(id)` 拿到的 ctx 派发即可命中该 Session 的 shell。
- **结论：是官方路径。** 插件在自己的文件选择/上传完成后，用 `inputActions.captureInsertion()` 取 span，`actx.bail(...)` 插 chip；与官方菜单走同一个监听器、同一套 CAS。直接调 `input.insertReference(ref, span)` 也等价（`insertReference` 是同一方法），但类型/文档把 `InputTarget` 这组动词描述为「the hub's bail listeners call these」，直接调用属于「类型可见但文档未承诺的用法」。

`ReferenceInsert` 形状（`APP/dsh-client-ui-conversation/src/client/contract/draft-editor.ts:14-21`）：

~~~ts
{ source: string, ref: string, label: string,
  appearance?: 'session' | 'file' | 'folder', clipboardText: string }
~~~

- `appearance: 'file'` **合法**：官方 `@` source 就用它（`APP/dsh-client-ui-reference/src/client/index.ts:132-150`），chip 渲染成文件图标并通过 `openReference` 提供点击预览（`editor/ReferenceChip.tsx:27-36`、`reference-activation.ts:21-32`）。
- `source` 必须与注册的 `InputTriggerSource.name` 完全一致（序列化按名字路由，见 §1.1 第 5 跳）；`(trigger, name)` 重复注册会抛（`APP/dsh-client-ui-input-trigger/src/client/service.ts:55-59`）。
- `ref` 是 owner 自己的 id，也是**序列化时唯一能拿到的业务标识**（codec 只收 `ref`，收不到 occurrenceId、label、offset）。

### 2.4 观察 chip 被撤：`InputState.occurrences` 成立，但语义不唯一

- `InputState.occurrences` 是 `Occurrence[]`，每项 `occurrenceId`（按 chip NodeKey 稳定分配，undo 后仍复用）、`source`、`ref`、`offset`、`length`、`label`、`appearance`、`clipboardText`、`invalid`（`contract/input.ts:322-325`；`contract/draft-editor.ts:117-144`；投影见 `editor/projection.ts:203-250`）。
- 发布：`facade.ts:861-872` 每次 `publish()` 都带 `occurrences` 与 `phase`；store 面是 `SessionInput.state: SnapshotStore<InputState>`（`contract/input.ts:223-224`），插件订阅即可。
- 删除 chip 会触发 editor update ⇒ `onEditorUpdate`（`facade.ts:203-219`）⇒ `projectionContentChanged` 比较 occurrences 的 length/occurrenceId/invalid（`facade.ts:109-121`）⇒ 重新 publish。
- 发送成功：`machine.ts:211` 产生 `commit-draft` ⇒ 编辑器清空（`facade.ts:704-717`）⇒ 下一次 publish 的 occurrences 为空、draft 为空、phase 为 `plain`。
- 发送失败：不清空，occurrences 原样，phase 回 `plain`，附 notice。
- **缺口**：两者都表现为「occurrence 消失」，没有 per-attempt 的成功事件。要可靠区分，至少叠加：发送期间 `phase` 是否到过 `sending`、结算后 `draft` 是否被清空（`retainSuffixOf` 为 null ⇒ 全清）、以及 notice 是否存在。用户手工删 chip 通常发生在 `phase === 'plain'` 且不是「sending 后清空」，可据此判为撤 chip。
- 另：`occurrenceId` 不会传给 codec，所以「某 id 被 commit」只能靠 `ref` 自关联；插件应把 pending id 编进 `ref`（并保证同一 ref 多次出现时幂等）。

### 2.5 草稿持久化后 chip 能否恢复并再次序列化

- 发布态每变一次就写草稿：`facade.ts:874-882`（`persistDraft?.(draftSnapshot)`）；`snapshotDraft` 保留 `source/ref/offset/length/label/appearance/clipboardText`（`APP/dsh-client-ui-conversation/src/client/draft.ts:105-114`）。
- 存储是浏览器 localStorage 的 per-session store：`stores.ts:22-27` 定义 `persist: 'dsh.conversation'`；读回 `dsh.conversation.<sessionId>`（`stores.ts:43-56`）。**这是内部实现，不是公开契约。**
- 载入：`hub.ts:183` `shell.setDraft(readConversationDraft(binding.sessionId))` ⇒ `facade.ts:229-237` ⇒ `restoreDraft` 用持久化的 `source/ref/label/appearance/clipboardText` 重建 `ReferenceChipNode`（`editor/runtime.ts:430-473`，`chip-node.tsx:72-98`）。刷新页面后 chip 能恢复，下一次发送会**再次**按 source 名找 codec 序列化（owner 缺失则阻断，见 §1.2）。
- **持久化校验风险**：`draft.ts:7-16` 的 zod schema 要求 `length` 为正整数，`draft.ts:39-59` 的 refine 要求 `length === clipboardText.length` 且 span 与 `text` 内容一致、区间有序不重叠；**任一条不满足，整份草稿被丢弃**（`stores.ts:51` `parseStoredDraft(...) ?? empty`）。所以 `ReferenceInsert.clipboardText` 必须非空，且必须与实际写入的草稿文本完全一致。

---

## 3. 主线三：插件客户端半的装配契约

### 3.1 package.json 必备

- `dsh.client` 必须存在且 `platform` 是字符串；`platform !== 'web'` 直接不算 client 行（`APP/dsh-client-modules/src/index.ts:900-905`）。
- 声明了 `dsh.client` 就必须有 `exports["./client"]`，否则**抛错**（`index.ts:906-909`）；导出值接受字符串或一层 `default` 字符串（`index.ts:203-214`）。
- 字段语义（`APP/dsh-package-manifest/src/types.ts:86-99`）：`inject` 是「informational package-name dependencies, **not** Cordis service injection」；`external` 是「exact module-table requests beyond the implicit client baseline, including subpaths such as <pkg>/client」；`immediately` 是首屏预取。类型注释明确：**type-only import 会被擦除、不产生模块请求**。
- 版本：`dsh-client-modules` 只校验以上字段，**不校验引擎/版本**（resolveMeta 全文 `index.ts:891-918`）；插件自己可以写 `engines.dsh` 给 host 半做兼容性，但 client 半没有运行时版本协商（见 §6）。

### 3.2 bundle 形态与运行时可 `require` 的东西

- bundle 是 classic script（无 ESM），执行时同步注册一次 factory：
  `window.__ModuleLoader__.load({ id: "<该包的 boot 行 id（官方包即包名）>", factory: require => { ... module.exports ... } })`。实物见 `APP/dsh-client-ui-conversation/lib/client.js` 首行、第三方 `C:/Users/s0364/.dsh/profiles/desktop/node_modules/dsh-todo-board/client/client.js:1`。entry 建档用的是同一个 id（`APP/dsh-client-modules/src/client/entries.ts:182-190`）。
- `require` 解析顺序（`APP/dsh-client-modules/src/client/system.ts:326-339`）：平台 seed → 已物化模块（包名或 `<pkg>/client` 归一）→ 已注册 factory → 抛错。
- 平台 seed 只有 11 个（rc.5 前端 dist `APP/dsh-web-frontend/dist/assets/index-Ciz7DZxv.js` 里的 `qJ()`）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。dist 文件名带内容 hash，换版本会变。
- 别的包模块要走 boot 行：`inject` 声明的包行会先到、再物化本行（`system.ts:253-280`），`external` 是精确请求；两者都不是服务注入。**只访问服务时不需要 require 任何 `@deepseek-ai/*` 模块**（type-only import + Context 声明合并即可，服务按名字取）。
- 第三方实物：`dsh-todo-board` 的 client bundle 结尾是 `exports.name = 'dsh-todo-board'; exports.inject = ['slots']; exports.apply = function apply(ctx){ ... ctx.slots.inject('shell.overlay', ...) }`，只 require `react`，另外用 `fetch('/dsh-todo-board/api')` 打自己 host 半注册的路由——说明第三方双端插件在 rc.5 是完整支持的。

### 3.3 可用的服务与权限

- `ctx.sessions: ISessions`（`APP/dsh-api-session-controller/src/client/index.ts:90-95`）。
- `ctx.conversation: IConversation`、`ctx.uiConversation`（`APP/dsh-client-ui-conversation/src/client/index.ts:109-116`）——`IConversation.input` 就是 per-session input registry（`service.ts:40-47`）。
- `ctx.inputTriggers: InputTriggerServiceContract`（`APP/dsh-client-ui-input-trigger/src/client/index.ts:34-39`），能力只有 `registerSource(src)` 与 `sessionOf(actx)`（`.../client/contract.ts:11-25`）。
- `ctx.slots: SlotRegistry`（`APP/dsh-client-ui-renderer/src/client/index.ts:43-48`）。
- **没有权限/白名单/能力门**：loader 只校验 §3.1 的声明；client bundle 拿到的就是 root ctx，`apply(ctx)` 里能 `inject`/`get` 任何已注册服务。官方 `@` source 的写法就是最好模板：`export const inject = ['inputTriggers', ...]`（`APP/dsh-client-ui-reference/src/client/index.ts:45-49`）、`inputTriggers.registerSource(source)` 包在 `ctx.effect` 里（同文件 `:172-178`）。
- 失败粒度：client 半的包声明坏了（有 `dsh.client` 却没 `./client`、文件读不到）属于 `modules`（required）失败 ⇒ **整机启动失败**；而 host 半 apply 抛错只让该行 FAILED、其余照常。插件装配时要保证 client 声明始终合法。

### 3.4 推荐的最小装配（文件桥 client 半）

1. `package.json`：`type: "module"`、`exports` 至少 `.` 与 `./client`、`dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-conversation", ...] }`（`inject` 只写确实要 `require` 的包；只用服务就留空/省略）。`external` 一般不需要。
2. `client.js`：classic script + `__ModuleLoader__.load({ id: "<包名>", factory })`，`exports.inject = ['inputTriggers','sessions','conversation','slots']`，`exports.apply = ctx => { ctx.inputTriggers.registerSource(source); ctx.slots.inject(...) }`。
3. source：`{ trigger: '@', name: '<唯一名>', async candidates(){ return [] }, onPick(){ return undefined }, codec: { clipboardText: ref => ..., serialize: async (ref, signal) => ... } }`。`candidates` 返回空数组**合法**：空 ready 组会触发菜单自动关闭（`APP/dsh-client-ui-input-trigger/src/core/menu.ts:77-79`），不报错；也就是说 source 不必「用户能从菜单点到」，注册本身就能让序列化路由生效。
4. 插入 chip：`const actx = ctx.sessions.scope(sessionId)`；`span = inputActions.captureInsertion()`（session slot 标准 prop）；`actx.bail(actx, 'slash/input-insert-reference', { reference, span })`。

---

## 4. 公开契约 vs 内部实现（文件桥依赖哪层）

| 依赖点 | 性质 | 依据 |
|---|---|---|
| `dsh.client.{platform,inject,external}` + `exports["./client"]` | **公开契约**（loader 校验、有报错文案） | `client-modules/src/index.ts:203-214, 891-918`；`dsh-package-manifest/src/types.ts:86-99` |
| `__ModuleLoader__.load({id,factory})`、cordis 插件 `apply/inject`、服务按名取 | **事实契约**（无其它入口，第三方插件现役） | `client-modules/src/client/system.ts:326-339`、`entries.ts:182-190`；todo-board 实物 |
| `InputTriggerServiceContract.registerSource` / `InputTriggerSource` / `ReferenceCodec` | **公开契约**（`contract.ts`/`types.ts` 均标 contract，`./client` 导出类型） | `input-trigger/src/client/contract.ts:11-25`、`src/types.ts:135-147,160-242` |
| `slash/input-*` 四个 scoped bail 事件 | **公开契约**（声明在 conversation 的 `contract/input.ts`，随 `./client` 类型发布，官方 source 就这么用） | `conversation/.../contract/input.ts:140-166`；`input-trigger/.../controller.ts:482-497` |
| `InputState` / `InputActions` / `SessionInput` / `SessionInputResolver` / `ReferenceInsert` / `DraftSnapshot` 类型 | **公开类型面** | `conversation/src/client/index.ts:100-107` |
| `SessionInputShell` 内部：default sink 装配、`sinkSerialized` 顺序、空串特例、`dead` 守卫、commit 时清 undo | **内部实现**（类注释明写 package-private，hub 独占构造） | `facade.ts:1-10, 727-749, 788-791` |
| `codec.clipboardText(ref)` | **类型声明但 rc.5 无调用点**（chip 的 clipboardText 来自 `ReferenceInsert`，序列化只调 `codec.serialize`） | `types.ts:142-147` vs `controller.ts:351`（全 asar grep 无 `codec.clipboardText` 调用） |
| `Occurrence.invalid` / `ReferenceChipNode.setInvalid` | **当前是死面**：定义了、投影会读，但 rc.5 无任何调用点；owner 解析失败不会把 chip 标 invalid | `chip-node.tsx:150-164`、`projection.ts:228`；全 asar grep 无 `setInvalid(` 调用 |
| localStorage 键 `dsh.conversation.<sessionId>`、zod schema | **内部实现**（换版本可能变） | `stores.ts:22-27,43-56`、`draft.ts:7-59` |
| `InputBar` 的 `keyboard`/`blur`/`addFiles` 等 | **包内面**（slot inject 用，不对外） | `slots.ts:586-624`、`facade.ts:600-664` |

一句话：文件桥只需要 §3.4 的公开面；一旦用到 shell 内部 `caretSpan()`、内部 localStorage 结构或 `SessionInputShell` 的其它方法，就进入了内部实现，升级会断。

---

## 5. 对文件桥的适用性判断

**chip 在 composer（成立）**：用 `ReferenceInsert{ source:'<bridge>', ref:<pendingId>, label:<文件名/大小>, appearance:'file', clipboardText:<marker 文本> }` 插入。要求 `clipboardText` 非空且与实际草稿文本一致（否则刷新后整份草稿被丢，§2.5）；`ref` 里编入 pending/文件标识（codec 只拿得到它）。

**提交时 commit + 返回路径（成立，但语义是「序列化」不是「事务」）**：`codec.serialize` 在真正发送前被调用（§1.1），此时 commit 并返回 `<workspace 路径>` 字符串即可——这段文本会替换 chip 在消息里的位置（chip 的 span 用 offset/length 记录，`prompt.ts:61-82` 按 span 拼接）。注意：

1. **commit 与发送不是一个事务**：serialize 成功后 Host 仍可能拒收（`sendSession` 失败、断网、prompt error），此时草稿与 chip 原样保留、不会回滚已 commit 的文件；用户重发会**再调一次** serialize。⇒ commit 必须幂等，并有「同一 ref 已 commit 过」的判定。
2. **一次发送可能对同一 ref 调多次**（重复 chip、重试），且**多枚 chip 并发**（§1.3-4）；需要全局 pending 表 + 串行化/幂等，不能依赖调用顺序。
3. **失败要 throw，不能返回 `''`**（§1.3-1：空串会静默成功且清空草稿）。
4. **不要放进被 claim 的命令行**：command 参数的 chip 不展开（§1.3-2）。
5. **序列化期间编辑器冻结**：用户不能在这个窗口删 chip；但反过来，长时间不 settle 会把 composer 卡在 `sending`（无 timeout，§1.3-3），commit 慢的网络操作要自己加超时并 reject。
6. **刷新恢复**：刷新后 chip 会回来、下次发送重新 serialize；若插件被卸/改 source 名，chip 会永久阻断该 Session 的发送，只能删 chip（§1.2、§2.5）。给 source 名加版本化并长期保留旧名，或提供「清理孤儿 chip」的 UI。

**撤 chip 的观察点（部分成立）**：`InputState.occurrences` + `phase` + `draft` 三者一起订阅可以覆盖「发送成功清空」与「未发送就删 chip」，但没有逐次提交的成功事件，也没有把 occurrenceId 传给 codec（§2.4）。如果要严格区分，建议：记录 `phase === 'sending'` 时的 occurrences 快照，结算后对比 draft/occurrences 是否清空；清空 ⇒ 视为已发送，否则视为撤 chip。撤 chip 只删 pending（工作区不落文件）这条产品语义可以据此实现，但**需要实测**（见 §6）。

**「路径注入消息上下文」不是本钩子**：codec 只能产出**这条消息的文本**。原型里 `agent.inject` 式的「把路径作为上下文注入而不进正文」在 Web 客户端提交面上没有对应钩子；如果有，也只可能在 Host 侧（不在本次核实范围，见 §6）。

---

## 6. 未验证 / 不能保证

- 全部结论是 asar 源码静态核对，**没有构建并运行一个真实双端插件**；§3.4 的装配清单、§2.2 的 span 取法、§5 的判断均未跑通端到端。
- 「session slot 标准 props 里一定有 `inputActions`」来自 `contract/slots.ts:395-402` 的类型声明与 `apply.ts:321-333` 的 provide 装配，**未在第三方 slot 里实测**。
- 「`candidates` 返回 `[]` 后菜单自动关闭、无副作用」来自 `core/menu.ts:77-79` 的 reducer，**未实测 UI**。
- Host 侧路径（prompt admission、`agent.inject`、把路径作为上下文/系统提示注入）**完全未核实**，本笔记不结论。
- `@deepseek-ai/dsh-client-file-upload` 只做了对比性阅读（见 §7），未展开，也未验证自定义路由的替代方案。
- 版本：本笔记钉在 **0.2.2-rc.5**（各包 `package.json` 的 version 均为 `0.2.2-rc.5`，`APP/dsh/desktop-runtime.json` 的 `release.version` 同）。`slash/input-*` 与 `codec.serialize` 在类型上被标为冻结契约，但**没有运行时版本号/兼容性断言**，升级到下一个 rc 必须重新核对行号与行为；`codec.clipboardText` 当前无人调用、`invalid` 当前无人设置，这两处可能在后续版本被接线，届时行为会变。
- 插件加载形态的更多细节（安装、patch、pnpm、认证路由）不在本笔记范围（见 `research/file-bridge-packaging` 分支的笔记）。

---

## 7. 其他（仅对比，未展开）

`ctx.fileUpload.upload(sessionId, data, name?, signal?, onProgress?)` 是**原生附件上传**，不是通用宿主路由：

- 走固定路由 `/api/session/uploadFileBinary`（`APP/dsh-client-file-upload/src/protocol.ts:2-8`），`POST` + `application/octet-stream`，query 带 `sessionId`/`name`/`mediaType`（`src/http-route.ts:23-72`）。
- 返回 `{ receiptId, file }`（`src/client/contract.ts:16-33`、`src/client/runtime.ts:355-379`），receipt 是 Host 侧 staged 凭证，在 prompt admission 时被消费（`APP/dsh-api-session-controller/src/commands.ts:342,372`、`APP/dsh-client-file-upload/src/index.ts:191-215`）。
- 因此它**不能**用于「上传到自定义宿主路由」；文件桥若要自己的落盘语义，需要 host 半用 `ctx.inject(['webServer'], ...)` 注册自己的路由（第三方 `dsh-todo-board` 的 host 半就是范例：`lib/index.js:3563-3617` 用 `webServer.register({ kind:'exact', path, handler })`，client 半 `fetch(ROUTE)`），并自行处理连接栅栏（同文件 `:3382-3450` 用 `connection.requestRejection`）。此路线**未验证**，也不构成本次三条主线的结论。

---

## 8. 复查方式（可复制）

Node（本 runtime 的 fs 是 asar-aware；PowerShell 进不去 asar）：

~~~js
const fs = require('node:fs')
const APP = 'C:/Users/s0364/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'
const show = (p, a, b) => fs.readFileSync(APP + '/' + p, 'utf8')
  .split(String.fromCharCode(10)).slice(a - 1, b)
  .forEach((l, i) => console.log((a + i) + '| ' + l))
show('dsh-client-ui-conversation/src/client/input/facade.ts', 727, 749)
show('dsh-client-ui-conversation/src/client/input/prompt.ts', 83, 88)
show('dsh-client-ui-input-trigger/src/client/controller.ts', 346, 352)
show('dsh-client-ui-conversation/src/client/input/hub.ts', 158, 168)
show('dsh-client-ui-conversation/src/client/contract/input.ts', 147, 153)
show('dsh-client-modules/src/index.ts', 900, 909)
~~~

另可直接 grep 发布产物，确认运行的就是这套逻辑：

~~~js
const t = fs.readFileSync(APP + '/dsh-client-ui-conversation/lib/client.js', 'utf8')
console.log(t.includes('no serializer for reference source')) // true
~~~
