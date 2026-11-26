# DSH 认证模式与「摘掉登录」（研究笔记）

> 票：#6「手机端 PWA 交互与认证」 · map #1「DSH 内网服务器与手机上传 v1」
> 研究日期：2026-11-26 · 目标版本：DeepSeek Harness **0.2.2-rc.5**（tag `dsh-v0.2.2-rc.5`，commit `9c2670d3`，与本机安装版本一致）
> 范围：回答「能不能不做登录 / 7 天会不会掉 / 怎么摘 / 摘了会怎样 / 以后怎么接企业登录」。只做评估，不写实现。
> 与既有笔记的关系：**只写增量与纠正**。token 生成、cookie 属性、401/403 区分、撤销、反代要求、PWA 同源必要性等已由 [intranet-https-auth.md](../../intranet-https-auth/research/intranet-https-auth.md) 覆盖，本文不重述。
> 标记：**[已核实]** 来自 rc.5 源码/官方文档/一手规范；**[推断]** 由已核实事实推出、未实测；**[未证实]** 需实测或官方未表态。

## TL;DR

- **rc.5 没有官方「关闭认证 / no-auth / 免登录」模式。** CLI 参数表、config schema、Connection 代码、README、测试五处一致：认证是 Web 载体的无条件前置，连「按方法区分的 loopback 特权层」都在 2026-08 被明确删除。`--trusted-host` 只放宽 Host/Origin 栅栏、`--public-url` 只做公告，**两者都不授予身份**。
- **要关只能打补丁。** 最小补丁面 2 个文件约 20–40 行（`browser-auth.ts` 的 `authenticate`/`authorizeIndex`，`rpc-host.ts` 的 `admit`），但每次升级都要重打，且现有 e2e 直接断言 401 会红。补丁**必须保留 Host/Origin 栅栏**，否则 DNS rebinding 让任意网页都能驱动 agent。
- **「7 天销毁登录凭证」是把 document.cookie 的规则错误推广了。** WebKit 三个一手来源都说得很清楚：7 天上限只覆盖 **script-writable 存储**（IndexedDB/localStorage/sessionStorage/SW 缓存）与 **document.cookie**，以及 **non-cookie** 站点数据；**HTTP 响应头 Set-Cookie 写的第一方 cookie 不在 7 天规则里**。Home Screen Web App 更是明确豁免——WebKit 原话是「we would consider it a serious bug」。DSH 用的是 server-set HttpOnly cookie，正好落在安全区。
- **最省事的「无感登录」不是摘登录，而是把 cookie 寿命调长 + 一次 token 换 30 天。** `cookieMaxAgeDays`（Connection 行配置）是官方开关，默认 30，可调到 90–400；Chrome 有 400 天上限，超过会被截断。
- **如果一定要「网络通即均等权限」，最不坏的做法是让 Caddy 注入一份已登录 cookie，而不是改 DSH。** 零改码、可撤销（换签名密钥即全撤）、升级无痛；代价是把 bearer 写进配置文件，且所有设备共用一个身份。
- **摘掉登录 = 把「内网可达」等同于「主机 root 级控制」。** 未认证的 owner 会话不受 RBAC 检查（`remote-access` 明确 owner 豁免），能跑 shell、读 `.credentials.yaml`（模型 API key + cookie 签名密钥）、读全部 session 历史、装插件、建定时任务。DSH **没有**只读/只上传角色可供降权。
- **企业登录的接缝应放在 Caddy（forward_auth），不要放在 PWA 页面或 DSH 核心里。** v1 唯一要预留的是：稳定 hostname、`/auth/*` 路径、独立 cookie 命名空间、以及「每设备身份」这个现在不存在的数据位。

## 0. 与既有笔记的关系：本轮的增量与两处纠正

**增量（既有笔记没有或没展开）**

1. 「有没有官方 no-auth 模式」的正面核查与结论，以及三个相关开关（`--trusted-host` / `--public-url` / `cookieMaxAgeDays`）的能力边界表。
2. 精确的 patch 点与升级代价（既有笔记只讲「没有登录页」）。
3. ITP 7 天规则的一手考据与纠正（见下）。
4. 未认证暴露的爆炸半径清单，以及 DSH 现有权限模型为什么救不了。
5. 企业登录接缝的三个候选层与推荐。

**纠正 1：既有笔记里的「插件路由 auth: required」不是 rc.5 的机制。** [已核实]
- rc.5 的 `WebRoute` 只有 `kind` / `path` / `handler`（或 `resource`）三个字段，**没有 `auth` 字段**（`packages/host/webserver/src/index.ts:52-58`）。
- webserver 自己也不做认证：「**不提供服务器级认证或来源策略**：`dsh-client-connection` 等 route owner 会实施自己的请求策略。绑定非回环地址仍会向该网络公开未受保护的 route 与静态资源。」（`packages/host/webserver/README.zh.md`；英文版同一句在 `packages/host/webserver/README.md:132`）
- 一个插件要保护自己的路由，必须在 handler 里**自己调用** `ctx.connection.admit(request)` 或 `admitConnection()`，看返回的是 `{ rejection: 401 | 403 }` 还是 `{ peer }`。
- 影响：既有笔记的方案表里「插件路由（`auth: required`）」应改写成「插件路由（handler 内自行 `admit`）」。这不影响结论，但影响实现工作量估计。

**纠正 2：Android 侧的 cookie 共享是确定的，iOS 侧仍不确定。** [已核实 / 未证实分开]
- Android：安装的 PWA（WebAPK/TWA）**与 Chrome 主 profile 共享 cookie 和存储**——Chromium 官方架构文档原文 "Shares cookies and storage with the user's main Chrome profile."（`components/webapps/docs/android_architecture.md`）。所以 Android 上「浏览器登录过，PWA 直接进」成立。
- iOS：WebKit 2020 年那篇说主屏 web app「**not part of Safari**」、有自己的天数计数器（引文见 §2.3），但**没有**一份官方文档说清它与 Safari 的 cookie jar 是否完全隔离。既有笔记标 [未证实] 是对的，本轮不推翻，只补上旁边这条 Android 的确定结论。

## 1. rc.5 有没有官方的「关闭认证 / no-auth / 免登录」模式？

### 1.1 结论：没有。五处一手证据一致 [已核实]

| # | 入口 | 证据 | 说明 |
|---|---|---|---|
| 1 | CLI 参数 | `apps/cli/reference/README.md:40` | web profile 的参数就是 `--host`、`--port`、`--tls-cert`、`--tls-key`、`--public-url`、可重复的 `--trusted-host`、`--no-open`。**没有任何认证相关开关** |
| 2 | 正式 config schema | `packages/client/connection/src/index.ts:96-117`；`docs/config-catalog.zh.md:505-521` | `ConnectionConfig` 只有四个字段：`recovery`、`trustedHosts`、`cookieMaxAgeDays`、`maxRequestBodyBytes`。**没有 auth/enableAuth/disableAuth**。schema 是 `z.natural().min(1).default(30)` 这类形状，不存在布尔认证开关 |
| 3 | 代码路径 | `packages/client/connection/src/index.ts:150-158`；`rpc-host.ts:129`；`browser-auth.ts:371-386` | `/api` 路由第一件事就是 `connection.admit(req)`，`rejection` 直接写 401/403 并返回；`admit` 内部走 `authenticate()`，失败即 401。**没有分支能跳过** |
| 4 | 包 README | `packages/client/connection/README.zh.md:41` | 「通过 Web 载体访问时，**每个 Host RPC 方法和 WebSocket 流都要求经过认证的浏览器或 API Peer，不存在按方法区分的 loopback 层。**」 |
| 5 | 设计笔记 | `.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md:31-41` | 「曾考虑的替代方案」逐条否掉了：从 TCP 对端判定、保留按方法的特权列表、持久化启动令牌/接受 Bearer、每次重启轮换密钥、加 logout/TLS 代理/转发头配置。认证是**正决策**，不是遗漏 |

补充：`git grep -Ei 'no-?auth|disableAuth|authMode'` 在整份 rc.5 源码里 **0 命中**。

### 1.2 三个相关开关：能做什么、不能做什么 [已核实]

| 开关 | 位置 | 能做什么 | **不能**做什么 |
|---|---|---|---|
| `--trusted-host` | CLI，可重复；也可写在 Connection 行 `trustedHosts` | 把浏览器可见的 authority 加入 **Host/Origin 栅栏**的白名单，让请求不被 403 | **不授予身份。** 设计笔记原话：「`--trusted-host` 只扩展 Host/Origin 栅栏，绝不授予身份。」（`.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md:31`）；「每个被接受的 authority 仍须满足浏览器认证」 |
| `--public-url` | CLI / `publicUrl` 配置 / `web-runtime` 行 | 决定打印与打开的 URL、`DSH_WEB_URL`、agent 运行时上下文里的 GUI URL | **不配置任何路由、客户端传输或 cookie 作用域**；「公告既不授予身份，也不代表已认证」；也不影响 `Secure`（`Secure` 只由接收请求的监听器自身协议决定） |
| `cookieMaxAgeDays` | Connection 行 `config`（`packages/bundle/web-app/cordis.patch.yml:238-245` 的 `connection` 行） | 把浏览器/API cookie 的绝对寿命从 30 天改长或改短（`z.natural().min(1)`，无上限；实现会检查不超出安全时间戳范围） | **不是认证开关**，只是寿命。它不能让未持 cookie 的请求通过；超过浏览器上限会被截断（见 §2.6） |

要点：`--trusted-host` 管「谁配跟我说话」，`--public-url` 管「我怎么介绍自己」，`cookieMaxAgeDays` 管「凭证活多久」。**三者都不回答「要不要身份」**。

### 1.3 如果一定要关：patch 点与代价 [已核实 + 推断]

**最小补丁面（2 个文件）**

1. `packages/client/connection/src/browser-auth.ts`
   - `authenticate()`（`:371-382`）：现在对每个请求查 cookie、验 HMAC、验 authority、验有效期。改成无条件返回一个合成 payload，是**最省事也最危险**的一刀。
   - `authorizeIndex()`（`:263`）：现在 `GET /?token=…` 换 cookie 后 302 到 `./`，无效凭证走 `:386` 的 401。改成直接放行，页面才进得去（否则 `/api` 放行了、HTML 还是 401）。
2. `packages/client/connection/src/rpc-host.ts:129` `admit()`
   - 或退一步：在 `index.ts:151` 处把 `admission` 恒等替换成 `{ peer: connection.browserPeer }`。这只覆盖 `/api` 前缀路由，不覆盖 Gateway 的 WebSocket upgrade（`packages/api/gateway/src/index.ts:276` 也调 `admitConnection`），所以**必须在 `admit` 这一层改**，否则页面能开、RPC 连不上。

**必须一起保留的东西（否则比不关还糟）**

- `packages/client/connection/src/api-request-trust.ts` 的 Host/Origin/`Sec-Fetch-Site` 栅栏**必须留着**。关掉认证后，这层栅栏从「防 DNS rebinding 的附加层」升级成**唯一**的来源防线：一个恶意网页可以把域名 rebind 到内网 IP，然后用浏览器直接驱动你的 agent。设计笔记的「问题」段（`:9`）正是说旧方案把 loopback `Host` 当 authority 是错的。
- `Set-Cookie` 的 `Secure`/`SameSite` 逻辑可以留着（无害），但它已经不是安全边界。

**代价**

| 项 | 代价 |
|---|---|
| 代码量 | 2 个文件、约 20–40 行；理想情况下再加一个显式开关（否则你无法在 patch 后恢复原行为） |
| 构建 | npm 包入口是 `lib/index.js`（`packages/client/connection/package.json` 的 `main`/`exports`），仓库里改 `src` 需要重新构建；不改构建就只能对已安装的 `node_modules/@deepseek-ai/dsh-client-connection/lib/*.js` 做文本替换。两种都要求你自建 Docker 镜像 |
| 升级 | **每次升 DSH 都要重打并复测。** 认证是活跃开发区（rc.5 里就有 2026-08 与 2026-09 两篇改认证/HTTPS 的决策笔记），补丁与上游冲突的概率高 |
| 测试 | `apps/cli/tests/web-auth.e2e.ts:169` 直接断言未认证请求返回 `status: 401`；打补丁后该 e2e 必红，你会失去「上游认证行为未变」的信号 |
| 责任 | 关掉之后，任何能到达该端口的人都是 owner；以后出了事，上游不会认这个模式 |

**判断**：技术上完全可行，但它把一个「有界、可撤销、有官方测试保障」的安全属性换成了「无限期自维护的 fork」。除非有别的理由（比如完全离线、物理隔离），否则不值得。

## 2. 纠正「7 天销毁登录凭证」

维护者问的原话是「不能做 7 天销毁登录凭证这种吗」。这句话背后有一个流传很广的误读：**把「ITP 对脚本可写存储的 7 天上限」当成了「Safari 会 7 天清掉登录 cookie」**。两者不是一回事。

### 2.1 ITP 2.1（2019-02）：7 天只管 `document.cookie` [已核实]

WebKit 官方博客把两类 cookie 分得很清楚：

> "Cookies can either be set in HTTP responses or through the `document.cookie` API, the latter sometimes referred to as client-side cookies. **With ITP 2.1, all persistent client-side cookies, i.e. persistent cookies created through `document.cookie`, are capped to a seven day expiry.**"

（[webkit.org/blog/8613](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/)，「Client-Side Cookies Capped to 7 Days of Storage」节）

同一篇还写明：把 `Max-Age`/`Expires` 写成 7 天以上的会被压到 7 天；**本来就短于 7 天的保留更短的**；会话 cookie 不受影响。

**结论：HTTP 响应头 `Set-Cookie` 设置的持久 cookie，不在这条规则里。** DSH 的 `dsh-auth-<hash>` 正是 server-set 持久 cookie（`browser-auth.ts:131-138` 的 `sessionCookie()` 写 `Max-Age` + `Expires` + `HttpOnly` + `SameSite=Strict`）。

### 2.2 ITP 2.3（2019-09）与 2020 全量封锁：删的是 non-cookie 数据与 script-writable 存储 [已核实]

- ITP 2.3：「After seven days of Safari use without the user interacting with a webpage on website.example, **all of website.example's non-cookie website data is deleted.**」（[webkit.org/blog/9521](https://webkit.org/blog/9521/intelligent-tracking-prevention-2-3/)）——**non-cookie**，明确排除 cookie。
- 2020-03「Full Third-Party Cookie Blocking and More」：7 天上限扩到「all script-writable storage」，清单是 **Indexed DB、LocalStorage、Media keys、SessionStorage、Service Worker registrations and cache**（[webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)）。**cookie 不在这个清单里**——cookie 由 2.1 那条单独管，且只管 `document.cookie`。
- 触发条件也值得记：是「**7 天 Safari 使用中未与该站点交互**」，不是我装了但没打开就清零；而在 Home Screen web app 里连这个计数器都独立（见下）。

### 2.3 Home Screen Web App：WebKit 明确豁免 [已核实]

同一篇 2020 的博文有一节专门讲这件事：

> "Web applications added to the home screen are **not part of Safari** and thus have their own counter of days of use. Their days of use will match actual use of the web application which resets the timer. **We do not expect the first-party in such a web application to have its website data deleted. If your web application does experience website data deletion, please let us know since we would consider it a serious bug.** It is not the intention of Intelligent Tracking Prevention to delete website data for first parties in web applications."

这段话是**最强的一手依据**：主屏 web app 里的第一方站点数据不在 ITP 的删除目标内；真被删了，WebKit 自己会当 bug 修。

**推论（[推断]，边界要写清）**：
- 「把 DSH 加到主屏、在 web app 里登录一次」比「在 Safari 标签页里登录」更持久，这是设计意图，不是运气。
- 「not part of Safari」也**暗示**主屏 web app 的数据与 Safari 标签页相对独立（否则谈不上"自己的天数计数器"）。是否等于完全独立的 cookie jar，官方没有一句话说死 → 保持 [未证实]。这既支持既有笔记里「PWA 可能和 Safari cookie jar 不同」的担心，也说明在 PWA 内部登录一次就能长期稳定。

### 2.4 iOS 26 与现在的版本 [部分已核实]

- **iOS 26 / Safari 26 与认证直接相关的变化：主屏默认以 web app 打开。** Safari 26 beta 公告：「**By default, every website added to the Home Screen opens as a web app.**」（[webkit.org/blog/16993](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/)，"Every site can be a web app on iOS and iPadOS" 节）。以前要有 manifest 或 `apple-mobile-web-app-capable` 才进 standalone，现在默认进，用户可手动关「Open as Web App」。
  - 对本项目：**iOS 26+ 上用户随手「添加到主屏幕」就会得到 web app 容器**，正好吃到 §2.3 的豁免；但也意味着「同一台手机上 Safari 与主屏图标可能是两套状态」，登录页两条路径都要能走。
- **7 天规则本身：在本轮可查的 WebKit 一手材料里没有找到改变它的条目。** 这只能说明「未检索到」，**不等于「确认没改」** → [未证实]。判断依据是 WebKit 的 ITP 政策与 2.1/2.3/2020 三篇仍是现行口径。
- 版本现实：研究时点是 2026-11，WebKit 博客上最新的是 **Safari 27.x**（`WebKit Features for Safari 27.2`、`news-from-wwdc26-webkit-in-safari-27-beta`）。也就是说问「iOS 26」时，iOS 26 是上一代、iOS 27 才是当前。做兼容时应以 26 为下限、27 为当前。

### 2.5 Android Chrome [已核实]

- **没有 7 天首方 cookie 规则。** Chrome 的 cookie 上限是另一个数字：自 **Chrome M104（2022-08）** 起，cookie 不能把到期时间设到 **400 天**以后（原文大意；会话 cookie 不受影响）。（[developer.chrome.com/blog/cookie-max-age-expires](https://developer.chrome.com/blog/cookie-max-age-expires)）
- **安装到主屏的 PWA 与 Chrome 共享 cookie/存储**：Chromium 官方架构文档的 TWA 一节写着 "Shares cookies and storage with the user's main Chrome profile."（[components/webapps/docs/android_architecture.md](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/webapps/docs/android_architecture.md)）。
- 用户主动「清除浏览数据」、或系统在极端存储压力下回收站点数据，仍会让登录态消失——这属于用户/系统行为，不是浏览器策略，[未证实] 具体触发概率。

### 2.6 那手机到底为什么会掉登录？把真实原因列出来 [已核实/推断]

| 原因 | 会不会发生 | 依据 |
|---|---|---|
| ITP 7 天清掉 server-set 的 HttpOnly cookie | **不会** | §2.1–2.3 |
| 把 token 存 localStorage，7 天被清 | **会**（Safari 标签页里）；主屏 web app 有独立计数器、且属第一方 | §2.2、§2.3 |
| cookie 到达 `cookieMaxAgeDays`（默认 30 天） | **会**，这是唯一正常的到期 | `browser-auth.ts` / README |
| cookie 被浏览器截到更短 | **会**：Chrome 上限 400 天；`cookieMaxAgeDays` 设成 36500 也没用 | §2.5 |
| DSH 换了签名密钥（删 `client-connection/browser-session` 凭据记录并重启） | **会**，这是设计上的全局撤销 | 既有笔记 §1.4 |
| 从 HTTP 切到 HTTPS（或端口变） | **会**，cookie audience 含 scheme 与 port，旧 cookie 作废 | 既有笔记 §1.2；`browser-auth.ts:78` |
| 用户清站点数据 / 无痕 / 换手机 | **会** | 浏览器行为 |
| 同 host 不同 scheme 混用（http 页面配 https 证书） | 会「莫名其妙」掉登录 | 同上 |

**一句话**：不要把「7 天」当约束来设计。真正的约束是 **30 天默认寿命** 和 **浏览器 400 天上限**；要更久就调 `cookieMaxAgeDays`，不需要也不应该去改认证。

## 3. 把登录「摘掉」或做成透明的四种做法

### A. patch DSH 关闭 auth [已核实 + 推断]

- **是否需要改 DSH**：需要，2 个文件（§1.3）。
- **可行性**：高（代码路径清楚），但**不可持续**：每次升级重打、e2e 必红、无上游支持。
- **升级兼容**：差。认证区是活跃改动区（rc.5 内已有两次相关决策变更）。
- **安全边界**：等于把 Host/Origin 栅栏当唯一防线。**必须**保留 `api-request-trust.ts`；否则任意网页可 DNS rebind 驱动 agent。关掉后无设备概念、无撤销、无审计身份。
- **复杂度**：中（改 + 建镜像 + 长期维护）。
- **适合**：完全物理隔离、无不可信设备、且愿意长期维护 fork 的场景。**本项目不符合。**

### B. 反代 / Caddy 侧做「自动带 token 或自动换 cookie」

拆成三个子方案，可行性差别很大：

**B1. 代理注入一份「已登录 cookie」（复制粘贴法）** [推断，但机制清晰]
- 做法：操作员在浏览器里正常登录一次 → 从 DevTools 复制 `dsh-auth-…` 的值 → Caddy 用 `header_up Cookie "dsh-auth-…=<value>"` 注入到每个上游请求。
- 是否需要改 DSH：**不需要**。
- 可行性：**高**。cookie 是 bearer，服务端只看签名与 authority；代理注入与浏览器发送在 DSH 眼里没有区别。`SameSite=Strict` 也不影响，因为这是服务端加的请求头。
- 升级兼容：**好**，只要 cookie 格式（payload version 1/2）与签名算法不变。
- 安全边界：**所有设备共享一个身份**，等于「网络通即均等权限」，但**可撤销**：删凭据记录 + 重启 DSH → 全部失效，比 patch 好。风险是 bearer 落在 Caddyfile / Git / 配置管理里。
- 复杂度：**低**（一个 `header_up`）。维护成本：cookie 到期（默认 30 天，可调）要重新复制一次。
- 注意：cookie 名是 `sha256(authority)` 的函数（`browser-auth.ts:116-118`），换 hostname/端口就要重新拿。

**B2. 代理自己签发 cookie（复刻 HMAC）** [推断]
- 做法：读 `$DSH_HOME/.credentials.yaml` 里 `client-connection/browser-session` 的 32 字节密钥，按 `browser-auth.ts:29-41`、`:142-177` 的 payload/HMAC 格式现签一个 cookie。
- 是否需要改 DSH：不需要，但**等于把认证搬到反代**，并且要跟着 payload 版本演进。
- 可行性：中（约 40 行，但格式是内部实现，随时可能变）。
- 安全边界：密钥必须给代理读 → 代理成为最高价值目标；泄漏即可无限期伪造。
- 复杂度：中高。**不推荐**，除非要做的正是「将来接 SSO 之后免二次登录」。

**B3. 代理自动补 `?token=`** [已核实：不可行]
- 不可行。启动 token 是进程级 256 位随机数，只在 DSH 的 stdout/打印 URL 里出现，**不持久化、不可配置**（既有笔记 §1.1；`browser-auth.ts` 的 `processLaunchToken`）。代理没有可靠渠道拿到它，只能抓日志——重启即失效，脆且脏。

### C. 保留 DSH auth，手机端只做一次性 token 设置，之后无感 [已核实 + 设计]

- **是否需要改 DSH**：不需要。
- 做法：PWA 里一个输入框贴 token → 同源 `fetch("/?token=…")` 换 cookie（既有笔记 §4.4 的设计）→ 之后 30 天无感；把 `cookieMaxAgeDays` 调到 90–180 进一步降低打扰。
- 升级兼容：**最好**，官方路径。
- 安全边界：**最优**。有身份、可撤销、有测试保障；每个设备独立 cookie（虽然 DSH 不区分设备身份，但至少每个浏览器各自持凭据）。
- 复杂度：低（一个输入框 + 一次 fetch）。
- 唯一「缺点」：新设备要贴一次 token；token 要从启动日志拿（rc.5 没有二维码/配对——既有笔记 §5.4）。

### D. 其他：插件路由 / API peer

**D1. 插件路由做一个「只上传」入口** [已核实机制]
- `ctx.webServer` 注册的路由**默认不受认证保护**（§0 纠正 1），所以你可以故意暴露一个最小上传接口，只做「收文件 → 写 inbox」。
- 但注意：**插件进程本身是 owner 权限**。路由少暴露一点 RPC 面，不等于限制了攻击者——他仍然可以走 `/api`（需要 cookie）或打别的路由。它只是「给没登录的手机一个窄入口」，**不能**用来给 DSH 主 UI 免登录。
- 升级兼容：好（公开 API）。复杂度：中。

**D2. `/connect` API peer** [已核实]
- `GET /connect?token=…&interactions=none` 给脚本/CLI 一个 Peer，不给浏览器 UI。手机 PWA 用不上（既有笔记 §1.5 已说明）。

### 方案对比

| 方案 | 改 DSH | 升级兼容 | 可撤销 | 身份粒度 | 安全暴露 | 复杂度 | 判决 |
|---|---|---|---|---|---|---|---|
| **A. patch 关 auth** | 是（2 文件） | **差** | 只能靠回滚补丁 | 无 | **最高**（依赖栅栏） | 中 | 不推荐 |
| **B1. 代理注入 cookie** | 否 | **好** | 是（换密钥） | 全体共享 1 个 | 高（bearer 在配置里） | **低** | **次选**（若必须免登录） |
| B2. 代理签发 cookie | 否 | 中 | 是 | 全体共享 | 高（密钥外流） | 中高 | 不推荐 |
| B3. 代理补 token | — | — | — | — | — | — | **不可行** |
| **C. 官方 token + 长 cookie** | 否 | **最好** | 是 | 每浏览器 1 个 | 低 | 低 | **首选** |
| D1. 插件窄入口 | 否（加插件） | 好 | 是 | 无 | 中（自身逻辑要严） | 中 | 可选补充 |
| D2. `/connect` peer | 否 | 好 | 是 | 每 peer | 低 | 低 | 不适用手机 UI |

## 4. 安全爆炸半径：局域网内任何人无登录访问，等于什么？

### 4.1 先说结论 [已核实]

**等于把「能 ping 到这台机器」升级成「以 DSH 进程所属操作系统用户的身份，对这台机器有完全控制权，并且能拿到它的模型凭据」。**

三条一手依据：

1. 认证决策的「后果」段自己写着：「**持有浏览器 cookie 就能调用完整的工具型 Host API**，这与 Web 应用在创建 Session 后暴露的 authority 一致。」（`2026-08-24-browser-token-authentication.zh.md:45`）
2. 会话就是 owner，而 owner **不受任何 RBAC 检查**：「owner（`{ kind: 'owner' }`）**从不受检查**；下列成员都只针对非 owner principal。」（`packages/api/remote-access/README.zh.md`）——所以不存在「登录了但只读」这种状态。
3. 工具面本身就是等同 shell 的：`bash`/`pwsh`（持久终端）、`write`/`edit`/`apply_patch`、`read`/`grep`/`glob`、`terminal_*`、`web_fetch`/`web_search`、`plugin_manager`、`schedule_*`、`subagent`、`mcp_*`、`office_*`（`docs/tool-catalog.zh.md`）。

### 4.2 具体能做些什么 [已核实能力 + 推断组合]

| 面 | 能做什么 | 依据 |
|---|---|---|
| **Shell / 系统** | 以 DSH 用户身份跑任意命令；读写该用户可及的任何路径；起进程、开端口、装东西 | `bash`/`pwsh` 工具（tool-catalog） |
| **模型凭据** | 读 `$DSH_HOME/.credentials.yaml` → **模型 provider API key** + **cookie 签名密钥**（后者可离线伪造任意长寿命 cookie，撤销要换密钥） | 既有笔记 §1.2（签名密钥就在该文件）；`browser-auth.ts` `ctx.credentials` |
| **工作区文件** | 读/写/删整个 workspace，包括未提交的代码、密钥文件、私有笔记 | `read`/`write`/`edit`/`apply_patch` |
| **会话历史** | 读所有历史 session（含过去的对话、贴过的代码、路径） | Session 持久化 + `read`/`grep` |
| **网络** | 从内网主机发起横向连接；`web_fetch` 明确可以访问 loopback 与私网地址；可把数据外传 | `packages/bundle/base/README.md`：「Web fetch runs without per-call approval and can reach loopback and private-network hosts.」 |
| **持久化后门** | 装/换插件（`plugin_manager`）；建 `schedule` 定时任务；改 profile 配置 | tool-catalog；`schedule_create` |
| **提权** | 权限预设里自带 `danger-full-access` + `never`（`docs/subsystems/permission-presets.zh.md:11`），可行的话切过去就没有沙箱也没有审批 | 同上；**切换是否需要额外确认 [未证实]** |

### 4.3 DSH 有没有「只读 / 只上传」的权限模型？——没有能用的 [已核实]

- **RBAC 存在，但只针对非 owner**：`dsh-api-remote-access` 决定「非 owner Peer 可以调用哪些 Remote 方法」，靠 role + policy 绑定资源（`packages/api/remote-access/README.zh.md`）。浏览器会话是 owner，**整层被绕过**。想让手机只读，得先有「非 owner 的手机」这个概念，目前没有。
- **权限预设（permission presets）不是身份角色**：它是把 **沙箱模式** 与 **审批策略** 两个 knob 捆成会话级预设（`docs/subsystems/permission-presets.zh.md:5`，「该层是可选能力，且不拥有执行策略」）。它约束的是「agent 干活时要不要问/越不越界」，不是「这个 HTTP 调用者能做什么」。
- **没有 logout，也没有设备列表**：rc.5 只有「清浏览器 cookie」和「删签名密钥+重启」两种撤销粒度（既有笔记 §1.4）。
- 因此：**「登录后再降权」这条路在 rc.5 不存在**。要么不给访问，要么给全权。

### 4.4 最小缓解清单（按性价比排序）

1. **网络 ACL 先收口**：只让手机所在 VLAN/网段能到 443；DSH 端口不发布到宿主机，Caddy 是唯一入口。文档也直说了：「无论是公告 URL 还是栅栏都不保护监听端口本身，因此请把端口限制在可信代理或网络内。」（`docs/user/guide/public-deployments.zh.md:27`）
2. **TLS 必须留着**：无 `Secure` 的明文链路上 cookie 就是明文 bearer（`connection/README.zh.md:81` 的已知限制）。
3. **DSH 用专用低权限账号跑**（非登录用户、非 sudo），workspace 只挂载业务目录，`$DSH_HOME` 放在该账号独占路径。
4. **把 `$DSH_HOME/.credentials.yaml` 当最高密级**：它能泄 provider key、能伪造 cookie。文件权限 0600 只是起点，容器里最好只挂必要凭据。
5. **日志脱敏**：`dsh web` 会把带 token 的 URL 打进 stdout；Caddy access log 默认会记 query。用 `log_skip` 过滤带 token 的请求，并限制 `docker logs`/journal 的读者。
6. **插件白名单**：关掉或用策略限制 `plugin_manager` / `plugin_market`，否则「装插件」就是持久化后门。
7. **定时任务审计**：定期看一眼有没有不认识的 `schedule`。
8. **只在该暴露期开**：需要临时给外人用时才开网段，用完收口；配合 §B1 的 cookie 注入可以做到「一键全撤」（换签名密钥）。

## 5. 未来企业登录 / 内部数据库的接缝放在哪一层？

### 5.1 现状：rc.5 只有「一个 owner」[已核实]

- 认证模型是「进程 token → 签名 cookie → 共享 owner Peer」。设计笔记明说浏览器「**始终选择共享 Peer**」，且「本设计明确不区分不同浏览器凭证的身份」（`2026-10-09-operator-scoped-connect-handshake.zh.md:17,29`）。
- 没有「从外部身份系统注入 principal」的扩展点：`--trusted-host` 不是身份，header 也不被信任（栅栏「不采信转发 header 或 `Origin`」）。
- 非 owner principal 那条路（`remote-access` 的 role/policy）是给子代理、liveshare 读者这类**进程内** principal 用的，没有「从 HTTP 头映射成 principal」的入口。

所以：**rc.5 里没有「把企业 SSO 接进 DSH 核心」的官方接缝。** 这是接缝设计的硬约束，必须先承认。

### 5.2 三个候选接缝

| 接缝 | 能解决什么 | 不能解决什么 | 改 DSH？ | 手机端要改吗 |
|---|---|---|---|---|
| **Caddy `forward_auth`**（推荐） | 准入判断、身份来源、登出、按用户审计；将来接内部 DB/SSO 只动代理和认证服务 | 不能替 DSH 生成 cookie（除非 B2）；用户仍需过 DSH 自己那关 | 否 | 否 |
| **DSH 插件** | 可以加新路由/新 UI，能调 `connection.admit`，能消费自定义 header（自己校验） | **不能改 DSH 自己的 `/api` 认证**；插件进程全权，写错就是新洞 | 否（加包） | 否（若要嵌 UI 则要） |
| **PWA 登录页** | 体验层：贴 token、跳转、记住状态 | 纯前端，不是安全边界；页面本身不认证任何东西 | 否 | 是（本来就要做） |

Caddy `forward_auth` 的语义正好是「鉴权网关」：对每个请求向认证上游发一个 GET（uri 可重写），**2xx 就放行并把 `copy_headers` 指定的响应头复制到原请求**，非 2xx 就把上游响应（通常是 302 到登录页）原样回给客户端（[caddyserver.com/docs/caddyfile/directives/forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth)）。这天然对应「将来接内部数据库/SSO」的位置：认证服务换实现，Caddyfile 与手机端都不动。

### 5.3 推荐：接缝放在 Caddy，v1 预留四样东西

**v1 就要定下来的（都是低成本、后补昂贵的决定）**

1. **稳定 hostname**（如 `dsh.lan`）。cookie name 是 `sha256(authority)`、证书 SAN、PWA origin 全绑在它上面；换名字 = 所有手机重登 + 重装证书。
2. **`/auth/*` 路径留给未来的认证服务**，现在就别让 DSH 或上传 PWA 占用。Caddy 用 `handle /auth/*` 单独路由。
3. **独立 cookie 命名空间**：DSH 用 `dsh-auth-*`；未来认证服务用另一个前缀（如 `dsh-sso-*`），避免两者互踩 `Path=/`。
4. **每设备身份的位**：现在就记一笔「这个 cookie 属于哪台设备」（哪怕只存在一张运维表里）。rc.5 做不到按设备撤销；将来接 SSO 时，这是唯一能让「丢手机 → 只踢那一台」成立的数据。

**将来升级路径（不改手机端）**

- 阶段 1（v1）：Caddy 只做 TLS + 静态 + 反代；认证交给 DSH（方案 C）。
- 阶段 2：加认证服务，Caddy 上 `forward_auth`；手机端**只多一个登录页跳转**（由认证服务出页面，PWA 不用改）。此时会变成「两层」：SSO 过了还要过 DSH。
- 阶段 3（可选，去掉第二层）：认证服务在 SSO 成功后**代替浏览器完成 DSH 的 token 交换**——即 B2 的 cookie 签发，或由它在内部持有启动 token 并代发 `/?token=` 重定向。**这一步要提前想好，因为它决定了 `$DSH_HOME` 的密钥是否要给认证服务读。** 如果不想给，就接受阶段 2 的双层登录。

**不推荐把接缝放进 PWA 登录页或 DSH 插件**：前者不是安全边界；后者够不到 DSH 自己的认证，只能旁路加门，容易做成「两个半套」。

## 6. 推荐

### 6.1 主推荐：方案 C（保留认证 + 一次性 token + 长寿命 cookie）

具体形态：

1. Caddy 唯一入口，DSH 绑容器内网地址、只跑 HTTP，`--trusted-host dsh.lan`，`--public-url https://dsh.lan/`。
2. 手机 PWA 首次：贴一次 token → 同源 `fetch("/?token=…")` → 拿 30 天 HttpOnly cookie。
3. 把 `cookieMaxAgeDays` 调到 **90–180**（不超过 400，Chrome 会截断；也不建议 >180，否则撤销窗口太长）。设置位置：web profile 的 `connection` 行 `config`（`packages/bundle/web-app/cordis.patch.yml:238-245`）。
4. 掉登录时的唯一动作：重新贴一次 token（token 从 `dsh web` 启动日志拿）。
5. 撤销：删 `client-connection/browser-session` 凭据记录 + 重启。

代价：新设备要贴一次 token（rc.5 没有配对/二维码）。收益：**这是唯一有官方测试保障、可撤销、且升级不痛的路径**。而且从 §2 看，它比我原先担心的稳得多——server-set cookie 不会被 7 天规则动。

### 6.2 如果坚持「网络通即均等权限」：最小风险版

**用 B1（Caddy 注入一份已登录 cookie），不要用 A（patch DSH）。**

理由：
- 效果一样（所有到达者都是 owner），但 **B1 零改码、升级无痛、且可一键撤销**（换签名密钥 → 注入的旧 cookie 立即失效）。A 的撤销只能靠回滚补丁。
- B1 不需要动安全关键代码，不会因为上游改认证而冲突。

配套硬条件（少一条就不要做）：

1. **保留 Host/Origin/`Sec-Fetch-Site` 栅栏**（DSH 自带，别关）——否则任意网页可 DNS rebinding 驱动 agent。
2. **网络 ACL 到设备级**：只放行家里/办公室的手机与电脑所在网段，其他一律 drop。
3. DSH 用**专用低权限账号**跑，workspace 只挂需要的目录。
4. **TLS 必须开**，且日志 `log_skip` 掉带 token 的 URL。
5. **接受「无设备粒度」**：一台设备丢 = 换密钥 = 全家重登。

### 6.3 必须明确写出来的、接受的风险

选 6.2 就等于接受：

1. **内网任意设备 = 这台机器的完全控制权**（shell、文件、进程、网络）。
2. **模型 API key 会暴露**（`.credentials.yaml` 可读），可能被人拿去刷额度。
3. **cookie 签名密钥可读 → 可伪造长期凭据**，发现异常后必须「换密钥」而不能只重启。
4. **无审计身份**：日志里只有一个共享 cookie，出事无法定位到人/设备。
5. **无可撤销粒度**：不能只踢一台设备。
6. **持久化风险**：插件与定时任务都能被改，且不一定有痕迹。
7. **上游不支持**：这不是官方模式，未来版本可能随时改掉 B1 依赖的 cookie 格式。

如果这些里有任何一条不能接受，就退回 6.1。

## 7. 未证实与未解问题

1. **[未证实]** 主屏 web app 与 Safari 的 cookie jar 是否完全隔离。WebKit 只说「not part of Safari」「有自己的天数计数器」「不打算删第一方数据」，没说共享还是隔离。需在目标 iPhone 上实测（Safari 登录 → 主屏图标打开看是否还登录）。
2. **[未证实]** iOS 26/27 是否在别处改了 7 天规则的适用面。本轮只查了 ITP 相关一手博文，未逐版本读 release notes。
3. **[未证实]** 切换权限预设（比如切到 `danger-full-access`）是否需要额外确认。若不需要，未认证访问等于直接拿到无沙箱无审批的 shell。
4. **[未证实]** B1 注入的 cookie 在 DSH 侧是否有额外校验（如来源 IP、UA）。从 `authenticate()` 读到的只有 cookie + authority，**看起来没有**，但未逐行确认全部调用点。
5. **[未证实]** 更新的 DSH 版本（0.2.2 正式版及之后）是否补上 pairing / 免登录 / 外部身份。rc.5 明确没有；master 有 `remote-connection` 的二维码配对（既有笔记 §5.4），但它是不是能解决「透明登录」未评估。
6. **[未证实]** `plugin_manager` 安装插件是否要审批；若不需要，未认证访问可直接装后门。
7. **未解**：如果 v1 用 B1，将来接 SSO 时要不要把 `$DSH_HOME` 的签名密钥交给认证服务（阶段 3）？这是一个**产品决策**，不是技术问题，建议在 v1 就定。

## 8. 一手来源索引

**DSH 0.2.2-rc.5（tag `dsh-v0.2.2-rc.5`，commit `9c2670d3`）**

| 主题 | 路径 | 链接 |
|---|---|---|
| web profile 参数表（无认证开关） | `apps/cli/reference/README.md:40` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/reference/README.md#L40) |
| Connection config schema（四字段） | `packages/client/connection/src/index.ts:96-117` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/index.ts#L96-L117) |
| 发布版 config catalog 中的同一 schema | `docs/config-catalog.zh.md:505-521` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/config-catalog.zh.md#L505-L521) |
| web profile 里 connection 行（`trustedHosts`/`cookieMaxAgeDays` 落点） | `packages/bundle/web-app/cordis.patch.yml:234-245` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/web-app/cordis.patch.yml#L234-L245) |
| `/api` 路由先 `admit` 再分发 | `packages/client/connection/src/index.ts:150-158` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/index.ts#L150-L158) |
| `admit()` 实现 | `packages/client/connection/src/rpc-host.ts:129` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/rpc-host.ts#L129) |
| cookie 签发/校验、401 出口 | `packages/client/connection/src/browser-auth.ts:116-177,263-286,371-386` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/browser-auth.ts#L116-L177) |
| Host/Origin/`Sec-Fetch-Site` 栅栏 | `packages/client/connection/src/api-request-trust.ts` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/api-request-trust.ts) |
| 包 README：逐方法都要认证、静态资源公开 | `packages/client/connection/README.zh.md:41,43,47,81-83` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md#L41) |
| `WebRoute` 无 auth 字段 | `packages/host/webserver/src/index.ts:52-58` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/host/webserver/src/index.ts#L52-L58) |
| webserver「不提供服务器级认证」 | `packages/host/webserver/README.zh.md`（风险小节） | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/host/webserver/README.zh.md) |
| 反代部署指南（trusted-host 不授予身份、端口要限） | `docs/user/guide/public-deployments.zh.md:25,27,33` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/guide/public-deployments.zh.md#L25-L33) |
| 认证决策笔记（含被否掉的替代方案、后果） | `.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md:9,15,31-47` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md) |
| 信任边界笔记（`--trusted-host` 不授予身份） | `.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md:31` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md#L31) |
| `--public-url` 只是公告 | `.agents/notes/archived/feature/2026-09-07-public-web-deployments.zh.md:14,34` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/.agents/notes/archived/feature/2026-09-07-public-web-deployments.zh.md#L14) |
| owner 免检的 RBAC | `packages/api/remote-access/README.zh.md` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/remote-access/README.zh.md) |
| 权限预设 = 沙箱 + 审批捆绑（非身份角色） | `docs/subsystems/permission-presets.zh.md:5,11` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/permission-presets.zh.md#L5-L11) |
| 工具面清单（shell/文件/网络/插件/定时） | `docs/tool-catalog.zh.md` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/tool-catalog.zh.md) |
| web_fetch 可访问 loopback/私网 | `packages/bundle/base/README.md:50` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/base/README.md#L50) |
| 共享 owner Peer、不区分浏览器身份 | `.agents/notes/implemented/architecture/2026-10-09-operator-scoped-connect-handshake.zh.md:17,29` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/.agents/notes/implemented/architecture/2026-10-09-operator-scoped-connect-handshake.zh.md) |
| e2e 断言未认证 = 401 | `apps/cli/tests/web-auth.e2e.ts:169` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/tests/web-auth.e2e.ts#L169) |
| 包入口是 `lib/index.js`（补丁要重建） | `packages/client/connection/package.json` | [链接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/package.json) |

**WebKit / ITP**

| 主题 | 链接 |
|---|---|
| ITP 2.1：document.cookie 限 7 天，HTTP 响应 cookie 不受影响 | [webkit.org/blog/8613](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/) |
| ITP 2.3：7 天删的是 non-cookie 站点数据 | [webkit.org/blog/9521](https://webkit.org/blog/9521/intelligent-tracking-prevention-2-3/) |
| 2020：7 天扩到 script-writable 存储（清单不含 cookie）；Home Screen web app 豁免 | [webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) |
| Safari 26：主屏默认以 web app 打开 | [webkit.org/blog/16993](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/) |

**Chrome / Android**

| 主题 | 链接 |
|---|---|
| Chrome M104 起 cookie 最长 400 天 | [developer.chrome.com/blog/cookie-max-age-expires](https://developer.chrome.com/blog/cookie-max-age-expires) |
| 安装的 PWA（TWA）与 Chrome 共享 cookie 与存储 | [components/webapps/docs/android_architecture.md](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/webapps/docs/android_architecture.md) |

**Caddy**

| 主题 | 链接 |
|---|---|
| `forward_auth` 语义（2xx 放行 + copy_headers，否则回上游响应） | [caddyserver.com/docs/caddyfile/directives/forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth) |

---

**附注：既有笔记的引用**。本文多处依赖 [intranet-https-auth.md](../../intranet-https-auth/research/intranet-https-auth.md) 已经核实的事实（token 生成、cookie 属性、401/403、撤销、反代要求、PWA 同源）。引用时只写「既有笔记 §x.y」，不重复论证。
