# 内网 HTTPS 与单令牌认证（研究笔记）

> 票：#2「内网 HTTPS 与单令牌认证」 · map #1「DSH 内网服务器与手机上传 v1」
> 研究日期：2026-11-26 · 目标版本：DeepSeek Harness 0.2.2-rc.5（tag `dsh-v0.2.2-rc.5`；本机 `dsh --version` 与 npm 包均已核对）
> 范围：x86_64 Linux 内网主机、Docker 部署 DSH Web、手机 PWA 上传到服务器 inbox；仅内网 + HTTPS + 单令牌。只产出可实施规格，不写实现。
> 标记：**[已核实]** 来自本版本源码/官方文档；**[未证实]** 需在目标设备或目标网络实测；**[master]** 仅较新分支有，0.2.2-rc.5 没有。

## TL;DR

推荐一条最小可靠链路：**Caddy 做唯一入口，DSH 只监听容器内网地址的明文 HTTP，上传 PWA 与 DSH 同 origin 挂在 `/upload/`，上传接口走 DSH 插件路由 `/inbox/*`。**

```
手机 / PWA ── HTTPS 443 ──> Caddy（dsh.lan）
                             ├─ /                    → DSH（HTTP，容器地址:3080）
                             ├─ /api/*、/plugins/*   → DSH（WebSocket / SSE）
                             ├─ /upload/*            → 上传 PWA 静态文件
                             └─ /inbox/*             → DSH 插件路由（auth: required）
```

- **TLS 两条路**：有域名就用真实子域 + DNS-01（Caddy 需带对应 DNS provider 的自定义构建）；没有域名就用 Caddy internal CA（`tls internal`），手机装一次根证书。自签叶子证书不推荐。
- **单令牌**：只用 DSH 启动 token（32 字节随机数，base64url 43 字符）。**不要在反代再加 BasicAuth**，否则 DSH 仍会再要一次自己的 token，变成两层认证。
- **PWA 登录**：上传 PWA 自己做一个 token 输入框，向同源 `/?token=…` 发 `fetch`，换 DSH 的 30 天签名 cookie；之后上传只带 cookie。这样即使已安装 PWA 与 Safari/Chrome 的 cookie jar 不同，也能在 PWA 自己的上下文里完成登录。[未证实：需在目标 iPhone/Android 实测；有 iframe 兜底]
- **必须同 host，最好同 origin**：DSH cookie 是 **host-only + SameSite=Strict**，子域或跨源请求拿不到它；跨源方案必然要多一个令牌或另一套 cookie。
- **反代要点**：保留 Host、转发 `Upgrade/Connection`、SSE 不缓冲、上传不设小上限、超时放宽、给 DSH 的 Set-Cookie 补 `Secure`。Caddy 大部分自动；Nginx 有 6 个危险默认值必须显式改。
- **最大风险**：rc.5 **没有登录页、也没有二维码/设备配对**，token 只能从 `dsh web` 启动日志拿；PWA 的 `fetch` 交换 token 后 cookie 是否落盘需实测。其次是没有官方 Docker 镜像、Caddy 根证书卷丢失会导致所有手机重装、token 可能进容器日志。

## Findings

### 1. DSH 0.2.2-rc.5 的认证事实

**1.1 启动 token 是进程级 256 位随机数，只在两个入口被接受。** [已核实]
- `processLaunchToken()` 用 `randomBytes(32)` 生成 base64url 字符串（43 字符），存在进程内 `WeakMap`，**不持久化、不可配置**。每个新进程换一个。
- 只接受两种 query token 入口：`GET /?token=…`（换浏览器 cookie）和 `GET /connect?token=…`（换 API cookie）。**不接受 `Authorization: Bearer` 头**；反代拿 header 令牌替代不了 DSH 认证。
- 源码：[browser-auth.ts@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/browser-auth.ts)、[connection README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md)

**1.2 浏览器 cookie 是 30 天、host-only、HttpOnly、SameSite=Strict 的签名 cookie。** [已核实]
- 签名密钥 32 字节，持久化在凭据记录 `client-connection/browser-session`（`$DSH_HOME/.credentials.yaml`，Linux 权限 0600）。因此 **DSH 重启后旧 cookie 仍然有效**，只有换密钥才失效。
- `cookieMaxAgeDays` 默认 30，可配置；cookie 名是 `dsh-auth-` + `sha256(authority)`，绑定 host+port；HTTPS 监听器的 audience 还带 `https:`，所以 HTTP 下拿到的 cookie 在改成 TLS 后不能复用。
- `Secure` 只由**接收请求的监听器自身协议**决定；`--public-url` 和 `X-Forwarded-Proto` 都不参与。反代终止 TLS、DSH 走 HTTP 时，cookie 默认**没有 Secure**，必须由反代补。
- 源码：[browser-auth.ts@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/browser-auth.ts)、[connection README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md)、[web-auth.e2e.ts@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/tests/web-auth.e2e.ts)（测试直接断言 43 字符、HttpOnly、SameSite=Strict、HTTP 下无 Secure、重启后 cookie 仍 200）

**1.3 401 与 403 是两回事。** [已核实]
- **403**：Host 既不是 loopback、也不是监听器绑定 IP、也不在 `--trusted-host` 列表内；或 Origin 不同 authority；或 `Sec-Fetch-Site: cross-site`。这是来源栅栏，不是身份认证。
- **401**：Host/Origin 可信但没有有效 cookie。rc.5 的 401 是纯文本 `dsh web authentication required…`，**没有登录表单**。
- DSH 不信任转发头来确定 authority；反代必须原样保留浏览器看到的 `Host`，并把 `--trusted-host` 点名成这个 authority。
- 源码：[connection README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md)、[public-deployments@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/guide/public-deployments.zh.md)

**1.4 撤销规则：token 轮换 ≠ cookie 撤销。** [已核实]
- 单个浏览器：清除站点数据即可。
- **全部浏览器/API**：删除或替换 `client-connection/browser-session` 凭据记录，然后重启 `dsh`，下一次 Connection 激活生成新密钥，所有旧 cookie 失效。
- **只重启 DSH 不会撤销 cookie**，只会换启动 token；测试明确验证了“新 token + 旧 cookie 仍然 200”。如果 cookie 泄露，必须换签名密钥，而不是只重启。
- rc.5 明确写着“没有 logout 操作”。Cookie 是 bearer，没有按设备会话列表。
- 源码：[connection README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md)、[web-auth.e2e.ts@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/tests/web-auth.e2e.ts)

**1.5 API 入口 `/connect` 的行为。** [已核实]
- `GET /connect?token=…&interactions=none|answer`：验证 token 后创建 owner Peer，返回 302 到 `./api/remote.mux` 并写 v2 API cookie。API 连接默认 `none`；非法/重复 `interactions` 返回 400。
- 每个 API Peer 只允许一条 mux WebSocket；重复关联返回 409。Socket 关闭时同步撤销其 API 凭据。**如果调用方换了 cookie 但从未建立 WebSocket，这个 Peer/凭据会留到 Host 退出**（已知限制）。
- 对上传 PWA 不需要 `/connect`；用浏览器 token 换 cookie 即可。脚本/CLI 才考虑 `/connect`。
- 源码：[connection README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md)

**1.6 token 的暴露面。** [已核实/需操作纪律]
- `dsh web` 把带 token 的 URL 打印到 stdout（可用 `printUrl: false` 关掉，但关掉后也没有首次登录入口）。Docker 下它就在容器日志里，必须限制 `docker logs`/journal 的访问。
- 303 响应带 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`，降低 Referer 泄露；但 URL 本身仍会进浏览器历史、截图、代理访问日志。
- Caddy 默认会把 URI query 写进 access log；DSH token 在 query 里。必须用 `log_skip` 或日志过滤，别让 token 进日志。
- 源码：[browser-auth.ts@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/browser-auth.ts)、[Caddy log_skip](https://caddyserver.com/docs/caddyfile/directives/log_skip)

### 2. 传输面与反代要求

**2.1 DSH 实际用到的四种传输。** [已核实]
- **WebSocket**：`/api/remote.mux`，页面 RPC 与事件流都走它。反代必须转发 `Upgrade` 与 `Connection`，并允许长连接。
- **SSE**：`/plugins/events`（客户端插件/HMR 的 `EventSource` 通道）。SSE 不能被响应缓冲，否则页面收不到增量。
- **HTTP POST**：`/api/...` 一元 RPC；缓冲型路由默认最多 300 MiB 请求体。
- **流式上传**：`POST /api/session/uploadFileBinary`（`requestBody: 'streaming'`），按 Session 寻址；图片还有 50 MiB/张、200 MiB/条消息等限额，通用文件不限格式/大小。反代不能把流式上传先整个缓冲到磁盘。
- 源码：[connection README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md)、[HMR README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/hmr/README.zh.md)、[file-upload protocol@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/src/protocol.ts)、[webserver README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/host/webserver/README.zh.md)

**2.2 反向代理必须做的五件事。** [已核实]
1. **保留浏览器可见的 Host**，不要改写成 upstream 地址；否则 DSH 返回 403。
2. **转发升级请求**：每个请求与 WebSocket upgrade 都要带 `Upgrade`/`Connection` 到达 DSH。
3. **剥离挂载前缀**（如果用 `/ui/`）：DSH 只认 origin-root 路由；`/ui/api/...` 必须以 `/api/...` 到达。
4. **改写 cookie**：DSH 在 HTTP 后端签的 cookie 是 `Path=/` 且无 `Secure`；代理要在 HTTPS 链路上补 `Secure`；如果挂到 `/ui/`，还要把 `Path` 改成 `/ui/`。
5. **裸挂载重定向**：`/ui` 必须以 `/ui/` 到达，否则 token 交换拿到 401/404。
- 关键警告：如果 DSH 挂 `/ui/` 且代理把 cookie `Path` 改成 `/ui/`，那么同 host 的 `/upload/`、`/inbox/` **收不到**这个 cookie。要做“单令牌 + 上传 PWA”，建议 **DSH 挂根路径 `/`，cookie 保持 `Path=/`**。
- 源码：[public-deployments@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/guide/public-deployments.zh.md)

**2.3 Caddy 的行为（推荐）。** [已核实]
- `reverse_proxy` **默认原样传递 Host**；WebSocket 自动做 upgrade + 双向隧道；SSE 响应（`Content-Type: text/event-stream`）自动立即 flush，未知长度响应也立即 flush。
- `flush_interval -1` 可显式关闭响应缓冲；对 SSE/WebSocket 不是必须，但可作保险。
- **Caddy 默认不设请求体上限**；只有配置 `request_body { max_size … }` 才会 413。上传场景不要配置比业务上限更小的值（或干脆不配）。
- Caddy 服务器默认：`read_body` 无硬超时、`read_body_idle` 1m、`read_header` 1m、`write` 无硬超时、`write_idle` 1m；WebSocket 的 `stream_timeout` 默认无超时。
- **Caddy 配置 reload 默认会强制关闭所有 WebSocket**（发 Close 帧）。可设 `stream_close_delay 5m` 让旧连接多活 5 分钟，避免集中重连；DSH 客户端本身有 500ms→10s 退避重连。
- 源码：[Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Caddy global options/timeouts](https://caddyserver.com/docs/caddyfile/options#timeouts)、[Caddy request_body](https://caddyserver.com/docs/caddyfile/directives/request_body)

**2.4 Nginx 的六个危险默认值。** [已核实]
| 默认 | 后果 | 必须改成 |
|---|---|---|
| `client_max_body_size 1m` | 手机照片/视频超过 1 MB 直接 413 | `client_max_body_size 0;`（或明确 2g） |
| `proxy_request_buffering on` | 整个上传先落盘再转给 DSH，失去流式/进度 | `proxy_request_buffering off;` |
| `proxy_buffering on` | SSE 被缓冲，页面不增量 | `proxy_buffering off;` |
| `proxy_read_timeout 60s` | 空闲 WebSocket/SSE 60 秒被断 | `proxy_read_timeout 24h;` |
| `proxy_send_timeout 60s` | 慢上传写 DSH 超时 | `proxy_send_timeout 24h;` |
| 默认 Host = `$proxy_host`、`Connection close` | DSH 403、WebSocket 握手失败 | `proxy_set_header Host $http_host;` + `Upgrade`/`Connection` map |
- 另外：Nginx 不会因为 `X-Forwarded-Proto` 给 DSH cookie 加 `Secure`；要用 `proxy_cookie_flags ~ secure;`（1.19.3+）。
- 源码：[nginx WebSocket](https://nginx.org/en/docs/http/websocket.html)、[ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)

### 3. 证书选择与手机信任链

**3.1 方案 A（体验最好）：真实域名 + DNS-01。** [已核实]
- 用如 `dsh.example.com` 的子域，A/AAAA 指向内网 IP（或本地 DNS 覆盖）；证书通过 DNS-01 签发，**不需要公网 80/443 入站**。
- Caddy 的 `tls { dns <provider> {env.TOKEN} }` 可自动签发/续期；Let's Encrypt 证书 90 天，Caddy 自动续。DNS API token 要最小权限（只给该 zone 的 DNS edit + read），不要放全账号 token。
- **Caddy 标准发行版不一定带第三方 DNS provider 模块**；需要 `xcaddy build --with github.com/caddy-dns/<provider>` 自定义镜像，或选一个已内置的 provider。官方 Docker 镜像默认没有 Cloudflare 等模块。
- Let's Encrypt 限制：每注册域每 7 天 50 张证书；测试用 staging CA 避免打满。
- 源码：[Caddy automatic HTTPS/DNS challenge](https://caddyserver.com/docs/automatic-https#acme-challenges)、[Caddy tls dns](https://caddyserver.com/docs/caddyfile/directives/tls)、[caddy-dns/cloudflare](https://github.com/caddy-dns/cloudflare)、[Caddy DNS provider 构建说明](https://caddy.community/t/how-to-use-dns-provider-modules-in-caddy-2/8148)、[Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/)、[rate limits](https://letsencrypt.org/docs/rate-limits/)

**3.2 方案 B（无域名首选）：Caddy internal CA。** [已核实]
- 站点写 `tls internal`，Caddy 生成 root + intermediate，用 internal issuer 给 `dsh.home.arpa` 等内部名字签叶子证书；叶子自动续期。
- 根证书位置：Caddy data dir 下 `pki/authorities/local/root.crt`。Linux 默认 `$XDG_DATA_HOME/caddy` 或 `~/.local/share/caddy`；官方 Docker 镜像设 `XDG_DATA_HOME=/data`，即 `/data/caddy/pki/authorities/local/root.crt`。
- `caddy trust` 只把根证书装进**运行 Caddy 的这台机器**的信任库，不会装到手机；手机要手动导入 `root.crt`。
- 必须持久化 Caddy 的 `/data` 卷。卷丢 = 新根 CA = 所有手机重新装根证书。
- 源码：[Caddy automatic HTTPS/local HTTPS](https://caddyserver.com/docs/automatic-https#local-https)、[Caddy tls internal](https://caddyserver.com/docs/caddyfile/directives/tls)、[Caddy data directory](https://caddyserver.com/docs/conventions#data-directory)、[Caddy 官方 Dockerfile（XDG_DATA_HOME=/data）](https://github.com/caddyserver/caddy-docker/blob/master/2.11/alpine/Dockerfile)、[caddy trust](https://caddyserver.com/docs/command-line#caddy-trust)

**3.3 方案 C（不推荐）：自签叶子证书。** [已核实/判断]
- 每次续期都要在每台手机重新安装；iOS 对“把叶子证书当信任锚”的行为不如根 CA 干净；证书 SAN 必须覆盖你访问的 hostname/IP。除非只是临时实验，否则不要用。
- 内部 CA 至少是“装一次根，叶子自动续”，比自签叶子可靠。

**3.4 手机信任链安装。** [已核实]
- **iOS/iPadOS**：把 `root.crt` 传到手机 → 安装描述文件 → **设置 → 通用 → 关于本机 → 证书信任设置** → 为 “Caddy Local Authority” 打开“启用完全信任”。只安装不打开完全信任，Safari 仍会报证书错误。
- **Android**：设置 → 安全（或“安全与隐私”）→ 更多安全设置 → 加密与凭据 → 安装证书 → **CA 证书** → 仍要安装 → 选 `root.crt`。Android 11+ 通常要求先设锁屏。不同厂商路径不同，以设备为准。
- Android 7+ 的 App 默认不信任用户添加的 CA；Chrome 的证书验证器会考虑本地信任决定，所以浏览器/PWA 通常可用，但别指望所有原生 App 都信任。
- 源码：[Apple 102390](https://support.apple.com/en-us/102390)、[Android KeyChain（CA 证书只能从设置安装）](https://developer.android.com/reference/android/security/KeyChain)、[Android 网络安全配置（用户 CA 与 App 的信任差异）](https://developer.android.com/privacy-and-security/security-config)、[Chrome Root Store FAQ（本地信任决定）](https://chromium.googlesource.com/chromium/src/+/HEAD/net/data/ssl/chrome_root_store/faq.md)

**3.5 主机名与 DNS。** [已核实/建议]
- 用稳定主机名，不要用 IP：PWA origin、cookie、证书 SAN、手机书签都绑在名字上；换 IP 只改 DNS。
- 推荐 `dsh.home.arpa`（RFC 8375 保留给家庭网络）或自己的真实子域；不要用 `.local`（mDNS 冲突）。路由器 DHCP/DNS 或 Pi-hole/AdGuard 把名字指到内网 IP。
- 真实域名 + DNS-01 时，A 记录可以指向内网 IP（手机在内网能解析），也可以做 split DNS；证书只看 DNS-01 TXT，不看 A。
- 源码：[RFC 8375](https://www.rfc-editor.org/rfc/rfc8375.html)

### 4. PWA、安全上下文与上传服务

**4.1 DSH Web 在 rc.5 本身就是可安装 PWA。** [已核实]
- `apps/web/public/manifest.webmanifest` 有 name/short_name、`start_url: "./"`、`scope: "./"`、`display: standalone`、192/512/maskable 图标；index 里还有 `apple-touch-icon`、`mobile-web-app-capable`、`apple-mobile-web-app-title`。
- 仓库中**没有发现 service worker 注册**（按代码搜索）；离线缓存不可用，但按 MDN 当前安装条件，service worker 不是安装必需项。若目标 Chrome 仍要求 SW，可补一个只做 network-only 的最小 SW。
- 安装前提仍是 HTTPS + manifest；内部 CA 必须先被手机信任，否则安装提示/页面都起不来。
- 源码：[manifest@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/web/public/manifest.webmanifest)、[PWA 测试@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/web/tests/pwa-manifest.e2e.ts)、[MDN 安装条件](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)

**4.2 HTTPS 是安全上下文，也是摄像头 API 的前提。** [已核实]
- `getUserMedia` 只在 secure context 可用；`http://192.168.x.x` 不是 secure context，`http://localhost` 才是。PWA 安装、Service Worker 也都要求 HTTPS（或 localhost）。
- iOS 的“添加到主屏幕”独立模式里，`getUserMedia` 在 iOS 13.4 起修复；更老的 iOS 不要指望。现代 iPhone 应可用，但权限提示/拒绝后的恢复路径需实测。
- 对“拍照上传”这类需求，**优先用 `<input type="file" accept="image/*" capture="environment">`**：直接调系统相机 UI，不需要 `getUserMedia` 权限；MDN 标注 `capture` 并非所有桌面浏览器都支持；iOS Safari / Android Chrome 通常可用，仍建议在目标机确认。只有要做实时取景/扫码时才上 `getUserMedia`。
- 源码：[MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)、[MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[MDN capture](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture)、[WebKit bug 185448（iOS 13.4 修复）](https://bugs.webkit.org/show_bug.cgi?id=185448)

**4.3 上传 PWA 与 DSH 必须同 host，最好同 origin。** [已核实 + 设计判断]
- DSH cookie 是 **host-only**（没有 `Domain`，子域收不到）且 **SameSite=Strict**（跨站请求不带）。所以：
  - `upload.dsh.lan` 这种子域：**收不到** DSH cookie。
  - `https://other-host/` 跨源：即使 `fetch` 加 `credentials: "include"`，Strict cookie 也不会随跨站请求发出。
  - 只有同 host（最好同 scheme+host+port）才能天然复用 DSH 的单令牌 cookie。
- 同 origin 还省掉 CORS/preflight、`SameSite=None`、通配证书、PWA scope 跨域等一堆问题。
- 建议布局：`https://dsh.lan/` 给 DSH，`https://dsh.lan/upload/` 给上传 PWA，`https://dsh.lan/inbox/*` 给上传接口。上传 PWA 的 manifest `scope` 设 `/upload/`，不要把 Service Worker 的 scope 设到 `/`（会干扰 DSH）。
- 源码：[MDN Set-Cookie（host-only/Domain）](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)、[MDN Request.credentials](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials)、[DSH browser-auth@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/browser-auth.ts)

**4.4 上传 PWA 的登录设计（单令牌的关键）。** [设计推断/未证实]
- PWA 页面在 `/upload/`，登录框让用户粘贴 `dsh web` 打印的 token；提交时执行同源：
  `fetch("/?token=" + encodeURIComponent(token), { credentials: "same-origin", cache: "no-store" })`
  DSH 对合法 token 返回 303 + `Set-Cookie`，浏览器跟随到 `/` 并落下 HttpOnly cookie；非法 token 返回 401。
- 这样 **cookie 落在 PWA 自己的 cookie jar 里**，不依赖 Safari/Chrome 与 PWA 共享 cookie。即使 iOS 上两者隔离，也能登录。
- 若 `fetch` 的 `Set-Cookie` 在某些浏览器不落盘，退路是隐藏 iframe 导航到同一 `/?token=…`，等 iframe load 后继续；两条都需要在目标 iPhone/Android 实测。
- 安全要点：token 只放内存，不写 localStorage/sessionStorage；输入框 `type="password"`、`autocomplete="off"`；提交后立即清空；Caddy 对该 URL 做 `log_skip`；DSH 303 已带 `no-referrer`/`no-store`。
- DSH 的 401 是纯文本，没有登录页；所以这个登录框必须由上传 PWA 自己提供。rc.5 也没有二维码/设备配对（见 5.4）。

### 5. 单令牌、反代认证叠加与撤销

**5.1 DSH 认证与反代认证是叠加，不是替代。** [已核实]
- 反代自己做 BasicAuth 只解决“能不能到反代”；DSH 仍然要求自己的 token/cookie。DSH **不读 `Authorization` 头**，所以 BasicAuth 不能让它免登录。
- `forward_auth` 到 DSH `/` 是特例：它把 DSH cookie 作为准入判断，可以复用单令牌，但每个请求多一次鉴权子请求。
- 若是“BasicAuth + DSH token”，结果是两层 401、两次登录状态、两套登出；在 PWA 里尤其容易卡在某一层。若“单令牌”是硬要求，**不要给 DSH 加第二层认证**。
- 反代真正该负责的是：TLS、Host/Origin 约束、网络 ACL、限流/日志、静态 PWA；认证交给 DSH。

**5.2 BasicAuth 与 PWA/fetch 的兼容性。** [部分未证实]
- BasicAuth 是 401 + `WWW-Authenticate` 挑战，凭据由浏览器按 origin/realm 管理；**服务端没有标准注销接口**，清 cookie 也未必清 auth 缓存。用户想“退出”通常要清站点数据/重启浏览器。
- `fetch` 的 `credentials` 默认 `same-origin`；如果浏览器已缓存 BasicAuth，可能自动带上；如果没有缓存，`fetch` 是否弹认证框、在独立 PWA/Service Worker 里是否有 UI，**随浏览器而异**（未证实，需实测）。后台 fetch 没有用户手势时基本不能指望弹框。
- WebSocket 构造函数只有 `url`/`protocols`，**不能加 `Authorization` 头**；只能依赖浏览器缓存的 BasicAuth 或 cookie。用 BasicAuth 保护 WebSocket 的可靠性不如 cookie。
- Caddy `basic_auth` 支持 bcrypt/argon2id，但只是“另一个口令”，不是单令牌方案；弱口令还会增加暴力破解面。
- 源码：[MDN HTTP authentication](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Authentication)、[MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)、[MDN Request.credentials](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials)、[Caddy basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)

**5.3 单令牌方案对比。**
| 方案 | 认证层数 | PWA 体验 | 撤销 | 结论 |
|---|---:|---|---|---|
| DSH 启动 token → cookie | 1 | PWA 自己登录，cookie 自动带 | 清 cookie；删签名密钥+重启可全撤 | **推荐** |
| 反代 BasicAuth + DSH token | 2 | 两次登录，PWA 弹框不可控 | 两套状态 | 不推荐 |
| 反代 forward_auth 到 DSH `/` + 独立上传服务 | 1（复用 DSH cookie） | 上传服务不碰 token，但每次请求多一次 DSH 索引渲染 | 同 DSH | 备选；需实测 |
| 上传服务独立 token | 2 | 两个 token，违背“单令牌” | 两套 | 不推荐 |
| 上传接口做成 DSH 插件路由（`auth: required`） | 1 | 同源 cookie，最干净 | 同 DSH | **推荐（若做插件）** |

**5.4 rc.5 没有二维码/设备配对。** [已核实]
- 0.2.2-rc.5 的 `packages/client` 下没有 `remote-connection`；当前 master 文档里的“设置 → 远程连接 / 二维码登录 / 配对申请”是较新功能，**不能当作 rc.5 的能力**。
- 因此 rc.5 的新设备上线只有：拿当前启动 token（日志/打印 URL）→ 在设备上换 cookie。已有设备在 30 天内不需要重新拿 token；DSH 重启也不会踢掉它们。
- 若确实需要“已登录设备批准新设备”，要么升级到带 pairing 的版本，要么自己加一个配对插件；本轮不展开。
- 源码（master 才有）：[remote-connection README（master）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/remote-connection/README.zh.md)；rc.5 对照：[packages/client@rc.5](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5/packages/client)

**5.5 防暴力破解与令牌卫生。**
- token 是 256 位随机数、比较用 `timingSafeEqual`；在线爆破不可行。**DSH 没有内置登录限流/锁定**；局域网内更现实的风险是 token 泄露（日志、截图、URL 分享），不是猜解。
- 建议：只允许内网/防火墙白名单访问 443；限制 `docker logs` 权限；Caddy `log_skip` 掉带 token 的请求；不要把打印 URL 发群/截图；怀疑泄露就“重启 DSH（换 token）+ 删签名密钥（撤所有 cookie）”。
- 源码：[browser-auth.ts@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/browser-auth.ts)、[connection README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md)

### 6. Docker 与推荐配置骨架

**6.1 rc.5 没有官方 Docker 镜像/Compose。** [已核实]
- 仓库里没有 DSH 本体的 Dockerfile/compose（只有一个 ssh 测试 fixture）。需要自建镜像：Node ≥24.9，`npm i -g @deepseek-ai/dsh@0.2.2-rc.5`，入口 `dsh`。
- Web profile 首次启动可能需要 pnpm 安装 bundle；建议构建/首次启动时预热 profile，并把 `$DSH_HOME` 持久化，避免每次重建都联网。
- 源码：[npm @deepseek-ai/dsh@0.2.2-rc.5](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.2-rc.5)、[rc.5 代码树](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)

**6.2 Compose 骨架（示意，需按镜像调整）。** [设计]
```yaml
services:
  dsh:
    build: ./dsh
    environment:
      DSH_HOME: /home/dsh/.dsh
      DSH_TELEMETRY_DISABLED: "1"
    volumes:
      - dsh-home:/home/dsh/.dsh
      - ./workspace:/workspace
    working_dir: /workspace
    command:
      - sh
      - -c
      - >
        exec dsh --profile web --no-open
        --host "$$(hostname -i | awk '{print $$1}')"
        --port 3080
        --public-url https://dsh.lan/
        --trusted-host dsh.lan
    restart: unless-stopped

  caddy:
    image: caddy:2.11
    depends_on: [dsh]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
      - ./upload-dist:/srv/upload:ro
    restart: unless-stopped

volumes:
  dsh-home:
  caddy-data:
  caddy-config:
```
- DSH 容器**不发布 3080**；Caddy 通过 Compose 网络访问 `dsh:3080`。DSH 用 `hostname -i` 绑定容器自身 IP（不能用 `0.0.0.0`，rc.5 会在启动时拒绝通配地址）。
- 只发布 TCP 80/443；**不发布 UDP/443**，避免 Chrome 走 HTTP/3 时遇到 internal CA 的本地信任限制（见风险 9）。
- 如果 DSH 必须绑定 `127.0.0.1`（例如某些镜像的安全策略），可让 Caddy 用 `network_mode: "service:dsh"` 共享 DSH 的网络命名空间；此时端口发布通常写在 `dsh` 服务上（以 Compose 实际行为为准）。Docker 文档支持 `service:{name}`。
- 源码：[Docker Compose network mode](https://docs.docker.com/compose/how-tos/networking/#change-the-network-mode)

**6.3 DSH 启动参数。** [已核实]
```
dsh --profile web --no-open \
  --host "$(hostname -i | awk '{print $1}')" \
  --port 3080 \
  --public-url https://dsh.lan/ \
  --trusted-host dsh.lan
```
- `--host` 只接受一个具体 IPv4/IPv6；`0.0.0.0`/`::` 会被拒绝。
- `--public-url` 只负责公告（打印/打开/DSH_WEB_URL），不授予信任；`--trusted-host` 才让 Host 栅栏接受 `dsh.lan`。两个都要。
- 这是“Caddy 终止 TLS”模式：不要给 DSH 加 `--tls-cert/--tls-key`，否则 Caddy 还要再处理 HTTPS upstream，复杂度上升。
- 源码：[startup.ts@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/web-app/src/startup.ts)、[web-app README@rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/web-app/README.zh.md)

**6.4 Caddyfile 骨架（internal CA 版）。** [设计/已核实指令]
```caddy
{
    skip_install_trust
    # email you@example.com   # 仅公网 ACME 需要
}

dsh.lan {
    tls internal
    # 有真实域名时改为：
    # tls {
    #     dns cloudflare {env.CF_API_TOKEN}
    # }

    encode gzip
    log {
        output file /data/access.log
    }
    @token query token=*
    log_skip @token

    header {
        # DSH 在 HTTP 后端签的 cookie 没有 Secure；在 HTTPS 链路上补上
        >Set-Cookie (.*) "$1; Secure;"
        Referrer-Policy "no-referrer"
        X-Content-Type-Options "nosniff"
        # 等手机信任链验证通过后再考虑 HSTS：
        # Strict-Transport-Security "max-age=31536000"
    }

    redir /upload /upload/ 308

    handle_path /upload/* {
        root * /srv/upload
        file_server
    }

    handle {
        reverse_proxy dsh:3080 {
            flush_interval -1
            stream_close_delay 5m
        }
    }
}
```
- `handle_path` 会剥掉 `/upload`，所以静态文件放在 `/srv/upload` 下；PWA manifest 用相对路径 `./manifest.webmanifest`。
- `handle` 覆盖 `/`、`/api/*`、`/plugins/*`、`/inbox/*`；Caddy 自动转发 WebSocket，SSE 自动 flush。
- `header >Set-Cookie` 是延迟替换，DSH 只发一个会话 cookie；若以后上游发多个 Set-Cookie，需要在目标 Caddy 版本上验证替换行为。该规则只适用于 DSH 走 HTTP 的拓扑；如果 DSH 自己终止 TLS，cookie 已带 `Secure`，不要再重复加。
- 若把 Caddy 直接跑在宿主机并希望服务端本机也信任该 CA，可改用 `caddy trust`；Docker 里通常用 `skip_install_trust`，根证书只给手机装。
- `log_skip @token` 防止 token 进 access log；Caddy 默认还会对 `Cookie/Set-Cookie/Authorization` 打 REDACTED。
- 源码：[Caddy header](https://caddyserver.com/docs/caddyfile/directives/header)、[Caddy log_skip](https://caddyserver.com/docs/caddyfile/directives/log_skip)、[Caddy query matcher](https://caddyserver.com/docs/caddyfile/matchers#query)、[Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

**6.5 上传接口的两种接法。**
- **推荐：DSH 插件路由** `POST /inbox/upload`，注册时声明 `auth: "required"`；WebServer 会在 handler 前完成 Host/Origin 与 DSH cookie 认证，handler 拿到 Peer，并可流式读 body。这样上传与 DSH 共用同一个 cookie/token，没有第二套认证。
- **备选：独立上传服务**（比如一个小 Node/Python 服务）挂在 `/inbox/*`，前面用 Caddy `forward_auth dsh:3080 { uri / }`：对每个上传请求，Caddy 用原 Host/Cookie 向 DSH `/` 发一个 GET，200 才放行，401 直接回给客户端。这样也不用第二个 token，但每次上传多一次 DSH 索引渲染；最好在 DSH 插件里加一个轻量 `/inbox/authz` 返回 204，再让 forward_auth 指向它。
- 不推荐：上传服务自己再发一个 token；那就不是单令牌了。
- 源码：[webserver README@rc.5（auth: required / 流式 handler）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/host/webserver/README.zh.md)、[Caddy forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth)

**6.6 如果坚持用 Nginx（已有 Nginx 时）。**
```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name dsh.lan;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    client_max_body_size 0;
    client_body_timeout 300s;

    root /srv;

    location /upload/ {
        try_files $uri $uri/ /upload/index.html;
    }

    location / {
        proxy_pass http://dsh:3080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 24h;
        proxy_send_timeout 24h;
        proxy_cookie_flags ~ secure;
    }
}
```
- `proxy_cookie_flags ~ secure;` 需要 Nginx ≥1.19.3；它给所有 Set-Cookie 补 Secure。
- `Host $http_host` 保留端口；DSH 的 authority 与 cookie 名都以它为准。
- `X-Forwarded-Proto` 不会让 DSH 的 cookie 变 Secure；别漏 `proxy_cookie_flags`。
- 源码：[nginx WebSocket](https://nginx.org/en/docs/http/websocket.html)、[proxy_cookie_flags](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cookie_flags)

## 方案对比

| 方案 | TLS/证书 | 认证层 | 手机信任 | 上传 PWA | 复杂度 | 结论 |
|---|---|---|---|---|---|---|
| **Caddy + DSH HTTP + 同源 PWA** | Caddy internal CA 或真实域名 DNS-01 | 1（DSH token） | 装根证书 / 公网证书免装 | 同源 `/upload/` + DSH 插件/forward_auth | 中 | **推荐** |
| DSH 原生 TLS，无 Caddy | DSH `--tls-cert`/`--tls-key` | 1 | 装根证书 / 公网证书免装 | DSH 不能直接托管 `/upload/`；需插件或另一入口 | 低（仅 DSH） | 仅 DSH 最小备选 |
| Nginx + certbot/step-ca | 外部证书 | 1 | 装根证书 / 公网证书免装 | 同源可做 | 中 | 已有 Nginx 时备选 |
| Caddy + BasicAuth | Caddy internal/公网 | 2 | 装根证书 | 两次登录，PWA 弹框不可控 | 中 | 不推荐 |
| 子域 `upload.dsh.lan` 独立服务 | 通配/多证书 | 2（或 SameSite=None 另一套） | 装根证书 | CORS + 第二令牌 | 高 | 不推荐 |

## 推荐

**给 v1 的明确规格：**

1. **DNS/名字**：没有公网域名时用 `dsh.home.arpa`，否则用自有真实子域，解析到内网 IP；不要用 IP 或 `.local`。
2. **入口**：Caddy 监听 80/443；DSH 容器只监听容器地址的 3080，不发布端口。Caddy `reverse_proxy dsh:3080`。
3. **TLS**：有域名 → Caddy 自定义构建 + DNS-01；无域名 → `tls internal`，持久化 `/data`，手机装 `root.crt` 并开完全信任。
4. **DSH 参数**：`--no-open --host <容器IP> --port 3080 --public-url https://dsh.lan/ --trusted-host dsh.lan`。
5. **认证**：只用 DSH token；**不加 BasicAuth**。Caddy 用 `header >Set-Cookie … Secure` 补 Secure；`log_skip` 掉 token URL。
6. **PWA**：静态文件挂 `/upload/`（Caddy `handle_path`），manifest `scope/start_url` 都是 `/upload/`；登录框向同源 `/?token=…` 发 `fetch` 换 cookie（失败用 iframe 兜底）；token 不落盘。
7. **上传接口**：优先做 DSH 插件 `/inbox/upload`（`auth: required`，流式）；独立服务则 Caddy `forward_auth` 到 DSH（最好加轻量 authz 路由）。
8. **手机**：iOS 装根证书 + 开完全信任；Android 装 CA 证书；先验证 Safari/Chrome 打开无警告，再“添加到主屏幕”。拍照优先 `<input type="file" accept="image/*" capture="environment">`，需要实时取景再 `getUserMedia`。
9. **运维**：持久化 `dsh-home`、`caddy-data`；备份/保护 `.credentials.yaml`（0600）；限制容器日志访问；怀疑泄露时“重启 DSH 换 token + 删 `client-connection/browser-session` 换签名密钥”；Caddy 根证书卷丢失要重装所有手机。
10. **验收清单**：无 cookie 访问 `https://dsh.lan/` 得 401；token URL 得 303 + Set-Cookie（HttpOnly/SameSite=Strict/Secure）；带 cookie 得 200；WebSocket 得 101；SSE 增量到达；50 MB 上传不被 413；PWA 可安装；PWA 内登录后上传成功；iOS/Android 无证书警告；重启 DSH 后旧 cookie 仍 200、新 token 换新 cookie。

## 风险与未解问题

1. **PWA 内 `fetch` 交换 token 后 cookie 是否落盘（最高风险）**：同源 `fetch` 处理 303 + Set-Cookie 的行为在 iOS Safari/Android Chrome 的独立 PWA 里需实测；不行就用 iframe 导航兜底。两种都未在目标机验证。
2. **PWA 与浏览器的 cookie jar 是否共享**：rc.5 没有登录页/配对；如果已安装 PWA 与 Safari/Chrome 隔离，DSH GUI PWA 可能无法用浏览器里的登录态。上传 PWA 的“自带登录框”能绕开，但 DSH GUI 本身不行。需实测，或只在浏览器 tab 里用 DSH。
3. **Caddy `header` 对多个 Set-Cookie 的替换行为**：DSH 目前只发一个会话 cookie；若未来发多个，需在目标 Caddy 版本验证。备选 Nginx `proxy_cookie_flags`。
4. **内部 CA 在手机上的信任**：iOS“完全信任”开关、Android 厂商路径、Android 7+ App 不信任用户 CA；Chrome 按文档应考虑本地信任，但目标机需实测。根证书卷丢失会导致所有设备重装。
5. **没有官方 Docker 镜像**：需自建 Node 24 镜像；首次 web profile 可能需要 pnpm 联网准备 bundle；建议构建时预热并持久化 `DSH_HOME`。未在真实镜像里验证。
6. **DNS-01 需要自定义 Caddy 构建**：标准镜像不带 Cloudflare 等 provider；需要 xcaddy 构建并管理 DNS API token（最小权限）。若不想维护，改用 internal CA。
7. **Caddy reload 默认踢掉 WebSocket**：设 `stream_close_delay` 或接受 DSH 客户端重连；重连期间前端可能短暂断流。
8. **`forward_auth` 到 DSH `/` 未验证**：每次上传都触发 DSH 索引渲染，成本和副作用需测；更稳的是 DSH 插件里加轻量 authz 路由。
9. **internal CA + HTTP/3**：Chrome 的证书验证器对 QUIC 只把本地信任用于“移除信任”，不用于“新增信任”；如果发布 UDP/443 并启用 HTTP/3，内网 CA 可能在 QUIC 上不被信任。内网 CA 场景建议不发布 UDP/443，或在 Caddy 关闭 h3。
10. **token 进日志/历史**：Caddy `log_skip` 只覆盖 Caddy；DSH 自己打印到 stdout，Docker/journal 仍可能保存。需要限制日志访问，并接受“拿到日志=拿到 token”。
11. **rc.5 没有 pairing/QR**：新设备只能拿当前 token；已有 cookie 30 天有效。若需要“老设备批准新设备”，要升级或另做插件。
12. **`getUserMedia` 在独立 PWA 的权限行为**：iOS 13.4+ 已修复基本可用，但拒绝后的恢复、每次启动是否重复询问，随版本/设备而异；拍照上传优先用 file input capture。

## 来源

**DSH 0.2.2-rc.5（一手）**
- [browser-auth.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/browser-auth.ts)
- [connection README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.zh.md)
- [connection config/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/index.ts)
- [web-auth e2e](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/tests/web-auth.e2e.ts)
- [web-app startup.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/web-app/src/startup.ts)
- [web-app README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/web-app/README.zh.md)
- [public deployments](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/guide/public-deployments.zh.md)
- [webserver README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/host/webserver/README.zh.md)
- [web server subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/web-server.zh.md)
- [HMR README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/hmr/README.zh.md)
- [file-upload protocol](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/src/protocol.ts)
- [file-upload README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/README.zh.md)
- [attachment README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/attachment/attachment/README.zh.md)
- [PWA manifest](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/web/public/manifest.webmanifest)
- [PWA manifest test](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/web/tests/pwa-manifest.e2e.ts)
- [npm @deepseek-ai/dsh 0.2.2-rc.5](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.2-rc.5)

**Caddy**
- [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [request_body](https://caddyserver.com/docs/caddyfile/directives/request_body)
- [header](https://caddyserver.com/docs/caddyfile/directives/header)
- [forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth)
- [automatic HTTPS / local HTTPS](https://caddyserver.com/docs/automatic-https)
- [tls](https://caddyserver.com/docs/caddyfile/directives/tls)
- [global options / timeouts](https://caddyserver.com/docs/caddyfile/options#timeouts)
- [log_skip](https://caddyserver.com/docs/caddyfile/directives/log_skip)
- [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
- [command-line / caddy trust](https://caddyserver.com/docs/command-line#caddy-trust)
- [conventions / data directory](https://caddyserver.com/docs/conventions#data-directory)
- [Caddy official Dockerfile](https://github.com/caddyserver/caddy-docker/blob/master/2.11/alpine/Dockerfile)
- [caddy-dns/cloudflare](https://github.com/caddy-dns/cloudflare)

**Nginx**
- [WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
- [ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)

**证书/平台**
- [Apple：信任手动安装的证书描述文件](https://support.apple.com/en-us/102390)
- [Android KeyChain](https://developer.android.com/reference/android/security/KeyChain)
- [Android network security config](https://developer.android.com/privacy-and-security/security-config)
- [Chrome Root Store FAQ](https://chromium.googlesource.com/chromium/src/+/HEAD/net/data/ssl/chrome_root_store/faq.md)
- [Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/)
- [Let's Encrypt rate limits](https://letsencrypt.org/docs/rate-limits/)
- [RFC 8375（home.arpa）](https://www.rfc-editor.org/rfc/rfc8375.html)

**Web/PWA**
- [MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
- [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MDN input capture](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture)
- [MDN Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
- [MDN Request.credentials](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials)
- [MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)
- [MDN HTTP authentication](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Authentication)
- [WebKit bug 185448（standalone PWA getUserMedia）](https://bugs.webkit.org/show_bug.cgi?id=185448)

**Docker**
- [Compose networking / network mode](https://docs.docker.com/compose/how-tos/networking/#change-the-network-mode)

---

### 研究边界
- 未在本机 Docker/Linux 上实际起 Caddy/DSH 容器；Caddyfile/Compose/Nginx 片段是配置规格，不是已跑通的产物。
- 未在 iPhone/Android 实机验证 internal CA 信任、PWA cookie 落盘、getUserMedia 权限；文中已标“未证实”的都需要在目标机补测。
- 未评估 DSH 0.2.3-alpha 的 pairing 功能；本笔记只按 0.2.2-rc.5 出规格。
