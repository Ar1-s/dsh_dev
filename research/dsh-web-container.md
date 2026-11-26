# DSH Web 容器化与内网暴露（研究 #11）

- 票：#11「DSH Web 容器化与内网暴露」，map #1「DSH 内网服务器与手机上传 v1」
- 分支：research/dsh-web-container
- 日期：2026-11-26
- 研究对象：@deepseek-ai/dsh 0.2.2-rc.5（npm latest；本机安装包同为 0.2.2-rc.5）
- 范围：只产出可实施规格，不写实现；目标 x86_64 Linux 内网主机、单用户、多设备、HTTPS、单令牌。

## TL;DR

1. **官方没有容器镜像**。官方 Linux/headless 入口是 npm 包 **@deepseek-ai/dsh**（bin 为 dsh，engines 要求 Node >= 24.9.0）或源码；**dsh web** 默认只监听 127.0.0.1:3080，**dsh headless** 是一次性任务而不是常驻服务。容器需要自己从 npm 包构建。
2. **0.2.2-rc.5 并非只能监听 127.0.0.1**：**--host** 接受一个具体的本机 IPv4/IPv6 地址，只拒绝 0.0.0.0/:: 这类通配地址；也可以传 **--tls-cert/--tls-key** 让 DSH 自己终止 HTTPS。默认回环是安全默认值，不是硬限制。
3. **单令牌的准确形态**是：启动日志里带 token 的 URL + 持久签名 Cookie。token 每个进程重新生成；Cookie 签名密钥持久化在 DSH_HOME，所以重启后已登录设备仍有效，新设备需要从当前日志取 token。DSH 没有“用户自定义固定密码”这一层。
4. **推荐方案**：官方 npm 薄镜像（非 root、只读根文件系统、tmpfs 可执行、DSH_HOME 与 workspace 双卷）+ Caddy 终止 TLS 反代到 127.0.0.1:3080。Caddy 默认保留 Host、自动支持 WebSocket；DSH 侧加 **--trusted-host** 与 **--public-url**。这样不需要 patch DSH。
5. **最大风险**是手机侧的 HTTPS 信任：Caddy 内部 CA 的根证书必须装进手机并受信任，否则页面不是安全上下文，PWA/Service Worker/部分浏览器能力直接不可用；其次是把 DSH 的 Cookie 在反代层补 **Secure** 的行为需要实测。社区镜像可复用工程做法，但都在 patch DSH，升级敏感。

## 1. 官方发行物：npm 是唯一官方 Linux/headless 路径

### 1.1 npm 包

- 官方 npm 包 **@deepseek-ai/dsh** 当前 latest 为 **0.2.2-rc.5**，bin 是 **dsh**，license MIT；该版本 **engines.node >= 24.9.0**，有 91 个直接依赖（不是单文件二进制）。来源：[npm registry 0.2.2-rc.5](https://registry.npmjs.org/@deepseek-ai/dsh/0.2.2-rc.5)、[npm 包页](https://www.npmjs.com/package/@deepseek-ai/dsh)。
- 官方文档只给出两条运行路径：**npx @deepseek-ai/dsh web** 或 clone 源码后 **pnpm dsh web**。没有官方 Docker/Compose 说明。来源：[官方 README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md)、[官网 Harness 页](https://www.deepseek.com/harness/)。
- GitHub Release 只有 tag，**没有二进制附件**；0.2.2-rc.5 的 release 页没有 assets。来源：[dsh-v0.2.2-rc.5 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)。因此“官方 Linux 发行物”实际就是 npm 包/源码，没有官方 AppImage/deb/容器。
- 桌面端不是 Linux 方案：官网下载只给 **macOS (Apple silicon)** 与 **Windows (64-bit)**；仓库的 electron-builder 配置里确实有 Linux **AppImage** target，但官网没有提供 Linux 下载。来源：[官网下载入口](https://www.deepseek.com/en/harness/)、[electron-builder-config.mjs](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/scripts/electron-builder-config.mjs)。CLI 还明确拒绝 **desktop** profile（只由 Electron 应用管理），所以不要试图在容器里跑 desktop profile。来源：[apps/cli/src/args.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/args.ts)。

### 1.2 dsh web 的 flags

官方 CLI 帮助（0.2.2-rc.5 本机输出与文档一致）：

- **--host <host>**：一个具体的本机 IPv4/IPv6 字面量；通配地址被拒绝。
- **--port <port>**：默认 3080；0 表示由 OS 分配。
- **--no-open**：不打开默认浏览器；容器/无头主机必用。
- **--public-url <url>**：公告浏览器实际使用的 HTTP(S) 根（可带挂载前缀），只影响打印/打开/DSH_WEB_URL/运行时上下文，**不授予信任**。
- **--trusted-host <authority...>**：额外接受的浏览器 authority；可重复。
- **--tls-cert / --tls-key**：成对提供，直接以 HTTPS 监听；只读一次，不自动续期，不提供 ACME，也不会回退 HTTP。
- 来源：[docs/cli-help.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.zh.md)、[web-app/startup.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/src/startup.ts)、[WebApp README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.zh.md)。

注意 **dsh headless** 是“回答一个任务后退出”的一次性命令，不是 headless 服务器；常驻 Web 服务仍然是 **dsh web --no-open**。来源：[docs/cli-help.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.zh.md)。

## 2. 监听、profile、认证与会话通道

### 2.1 默认监听与绑定规则

本机 0.2.2-rc.5 的 **dsh --profile web --dump-config** 显示：

- webserver 行：**host = 127.0.0.1**、**port = 3080**、gzip level 1、阈值 1024 字节；tls 来自 CLI。
- web-runtime 行：**publicUrl** 来自 CLI；**connection** 行：**trustedHosts** 来自 CLI。
- 来源：[web-app/cordis.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/cordis.patch.yml)（本机 dump 与之一致）。

官方的绑定规则：

- **host** 必须是本机某个接口的具体字面量。回环（127/8、::1）只留本机；其他字面量就在该地址所属网络上提供服务，未配 TLS 时是明文 HTTP，并会在启动时警告。
- **通配地址在加载时被拒绝**，理由很直白：绑定所有接口会把远程代码执行暴露到网络。来源：[packages/host/webserver/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/src/index.ts)、[docs/subsystems/web-server.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md)、[web-app/startup.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/src/startup.ts)。
- 官方 WebApp README 还给了一个容器示例：绑定容器自身的 Pod 地址（hostname -i 的第一个地址），再用 **--public-url** 公告前置 ingress。来源：[WebApp README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.zh.md)。

**结论**：smanx 镜像 README 里“官方只允许回环、不能 --host”的说法不准确；准确说法是“禁止 0.0.0.0/:: 这类通配地址，允许具体网卡地址”。但在 Docker 里容器 IP 会随重建变化，绑定容器 IP 不如“回环 + 反代”稳定。

### 2.2 profile 组成与插件

- web profile 位于 **$DSH_HOME/profiles/web**，目录里是 **cordis.yml**、**cordis.patch.yml**、**package.json**、**pnpm-workspace.yaml**（本机核对）。
- 组合顺序是：**dsh-base** → **dsh-web-app patch** → 用户 **cordis.patch.yml** / **--patch** overlay。web profile 额外插入 webserver、web-runtime、connection、client-file-upload、ui-attachment 等行。来源：[web-app/cordis.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/cordis.patch.yml)。
- 插件用 **dsh plugin --profile web add <pkg>** 安装；该命令把参数转给 profile 目录里的 **pnpm**。因此容器若要在运行时装插件，镜像里必须带 pnpm（corepack），并且 profile 目录（DSH_HOME）可写。来源：[docs/cli-help.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.zh.md)。

### 2.3 认证：启动 token + 持久签名 Cookie

- 启动后会打印 **dsh web:** 行，根 URL 带一个**新的进程 token**；浏览器用它换取签名 Cookie，然后重定向到不带 token 的同一目录。来源：[WebApp README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.zh.md)。
- token 是**进程级**的：processLaunchToken 在内存 map 里按 owner 缓存，首次随机生成，不落盘。来源：[packages/host/authentication-token/src/browser-auth.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/authentication-token/src/browser-auth.ts)。
- Cookie 的签名密钥是**持久化**的：BrowserAuth.create 通过 credentials provider 初始化“durable signing secret”，该 Harness home 没有时才生成。因此只要 DSH_HOME（含 .credentials.yaml）还在，重启后旧 Cookie 仍有效；删除/重置 .credentials.yaml 会改变签名密钥，旧 Cookie 立即失效。来源：[browser-auth.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/authentication-token/src/browser-auth.ts)、[dsh-container 使用指南](https://github.com/omdsh-dev/dsh-container/blob/main/docs/guide.md)。
- token 本身不提供用户体系：DSH Web 是单 owner；拿到 token/Cookie 的人就是 owner。打印的 URL 携带进程凭据，只应与预期用户分享；**printUrl: false** 会抑制该行，凭据也不会进入模型上下文或 DSH_WEB_URL。来源：[WebApp README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.zh.md)。
- 0.2.2 还有登录页/配对入口：可以粘贴登录链接或 token；也可以在已登录设备的“设置 → 远程连接”里批准另一台浏览器的访问申请。来源：[WebApp README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.zh.md)、[remote-connection README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/remote-connection/README.zh.md)。
- **Cookie 的 Secure 位只由监听器协议决定**：TLS 监听器签发的 Cookie 带 Secure；明文 HTTP 监听器签发不带 Secure 的 host-only Cookie。TLS 在反代终止时，反代需要自己补 Secure（见 §3）。来源：[docs/user/guide/public-deployments.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.zh.md)。

### 2.4 Host/Origin 栅栏与 WebSocket

- Host 栅栏接受：loopback、监听器自身的绑定地址、以及每个 **--trusted-host** 点名的 authority。浏览器用其他 authority 访问时，即使 token/Cookie 正确，每个 API 调用也会得到 403。来源：[public-deployments 文档](https://deepseek-harness.github.io/deepseek-harness/guide/public-deployments.html)。
- **--public-url 只是公告，不是信任**；浏览器实际使用的 authority 必须写进 **--trusted-host**。
- 反代必须：保留浏览器可见的 Host、按需剥离挂载前缀、把 Upgrade/Connection 头原样转发、按需改写 Cookie Path/Secure、把裸挂载重定向到带斜杠的入口。来源：[public-deployments 文档](https://deepseek-harness.github.io/deepseek-harness/guide/public-deployments.html)。
- 0.2.2-rc.5 的浏览器下行主通道是 WebSocket **/api/remote.mux**（客户端 stream-client 使用该路径）；旧文档提到的 events.mux/events.host 也是 WebSocket/SSE 形态。反代必须支持 HTTP Upgrade。来源：[packages/api/gateway/src/stream-protocol.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/gateway/src/stream-protocol.ts)、[public-deployments 文档](https://deepseek-harness.github.io/deepseek-harness/guide/public-deployments.html)。
- 前端静态资源的安全边界：Connection 在读取 dist 根目录和 index 之前完成认证；**非 index 资产保持公开**，非 GET/HEAD 返回 405。也就是说 JS/CSS 可匿名拉取，但数据/API 仍需 Cookie。来源：[docs/subsystems/web-server.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md)。

## 3. 把 127.0.0.1 暴露到局域网：三种可行路径

### 3.1 直接绑定具体 LAN/容器 IP（官方支持，但运维较差）

- 方式：**dsh web --host 192.168.1.10 --tls-cert ... --tls-key ... --trusted-host 192.168.1.10 --public-url https://192.168.1.10**。
- 优点：一个进程、没有反代、Cookie 天然带 Secure、Host 栅栏天然接受绑定地址。
- 缺点：DSH 自己不做 ACME/续期/HTTP→HTTPS 重定向；证书轮换要重启；端口直接暴露给 LAN；Docker 容器 IP 会变，必须用 host 网络/静态地址或每次重建时重算 --host。来源：[WebApp README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.zh.md)。

### 3.2 回环 + Caddy 反代（推荐）

- DSH 继续绑定 **127.0.0.1:3080**；Caddy 监听 443（和 80 做跳转），反代到 127.0.0.1:3080。
- Caddy 默认**原样传递 Host**（只追加 X-Forwarded-*），所以不要设置 **header_up Host**；DSH 侧必须 **--trusted-host dsh.lan**，否则 API 403。来源：[Caddy reverse_proxy 文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。
- Caddy 自动支持 WebSocket 升级（HTTP upgrade 后转为双向隧道），不需要额外开关。来源：同上。
- Caddy 对内部域名/IP 可以用 **tls internal**：生成本地 CA 并签发证书，需要把根证书装进手机并信任；否则浏览器会证书错误，页面也不是安全上下文。来源：[Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)。
- DSH 在明文 HTTP 监听器上签发的 Cookie 不带 Secure；Caddy 可以用延迟 header 正则补上：
  ~~~caddyfile
  dsh.lan {
      tls internal
      reverse_proxy 127.0.0.1:3080 {
          flush_interval -1
      }
      header >Set-Cookie (.*) "$1; Secure"
  }
  ~~~
  该写法来自 Caddy header 文档的 Set-Cookie 正则示例（文档示例是追加 SameSite=None），**需要用实际响应验证多条 Set-Cookie 是否都被正确改写**。来源：[Caddy header 文档](https://caddyserver.com/docs/caddyfile/directives/header)。
- 如果不想在反代层改 Cookie，也可以让 DSH 自己终止 TLS（§3.1），但证书轮换/重定向要自己解决。
- 手机访问时用 **https://dsh.lan**；HTTP 会自动跳到 HTTPS。**不要在反代上把 Host 改成 127.0.0.1**；如果确实改了 Host，就必须同时重写 Origin，否则 DSH 的同源检查会 403（smanx 的代理就是这么做的，见 §4.1）。

### 3.3 容器内中继/认证层（社区做法）

- dsh-container 和 smanx 都把 DSH 保持在容器内的 127.0.0.1，再在前面放一个 Node 中继监听 0.0.0.0。中继负责 WS 转发、Host 保留、可选的认证、以及（smanx）前端补丁。
- 这解决“容器 IP 会变”“不想让 DSH 直接对外”的问题，但引入了额外进程和（通常）对 DSH 内部文件的 patch。详见 §4。

### 3.4 安全上下文与 crypto.randomUUID

- 局域网 IP 的 **http://** 页面不是安全上下文；**crypto.randomUUID** 是仅安全上下文可用的 API。来源：[MDN randomUUID](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)、[MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)。
- 0.2.2-rc.5 已经不再依赖它：上游有 **@deepseek-ai/dsh-util-crypto**（基于 crypto.getRandomValues 的 randomUUID），仓库还有 lint 规则禁止直接调用 crypto.randomUUID；本机 0.2.2-rc.5 的浏览器 bundle 里也能看到内联的 getRandomValues 版本。来源：[util-crypto README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/crypto/README.zh.md)。
- 但 **HTTPS 仍然是硬要求**：PWA 安装、Service Worker、剪贴板等能力与安全上下文绑定；如果手机不信任证书，即使点“继续访问”也不是安全上下文。来源：[MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)。
- 结论：smanx 注入 randomUUID polyfill 对 0.2.2-rc.5 很可能已经冗余；它真正仍然有用的前端改写是 isLoopback（见 §4.1）。

## 4. 社区镜像拆解

### 4.1 smanx/deepseek-harness

- 架构：node:24-slim 多阶段构建；构建阶段安装 python3/make/g++ 编译 node-pty（Linux 没有 node-pty 预编译产物），运行阶段只保留 /usr/local；容器内 DSH 监听 **127.0.0.1:3079**，Node 代理监听 **0.0.0.0:3080**。来源：[Dockerfile](https://github.com/smanx/deepseek-harness-docker/blob/main/Dockerfile)、[README](https://github.com/smanx/deepseek-harness-docker)。
- 代理能力：http-proxy 的 ws:true；HTTP + WebSocket 都过 Basic Auth（PROXY_USERNAME/PROXY_PASSWORD）；根路径先向上游 401 的启动行取 token、换 Cookie 后再代理；对 /manifest.webmanifest、/favicon.svg 等公开路径放行（否则 PWA manifest 会 401）。来源：[proxy/index.js](https://github.com/smanx/deepseek-harness-docker/blob/main/proxy/index.js)。
- 前端改写：注入 crypto.randomUUID polyfill；把 **isLoopbackHostname(pageLocation.hostname)** 文本替换为 true，让局域网访问也能出现设置类功能；changeOrigin 改 Host 后同步把 Origin 改成上游地址，避免 403。来源：同上。
- 运行形态：默认 root（Dockerfile 没有 USER），无 TLS，数据卷挂 /root/.dsh，镜像 tag 跟 DSH 版本（0.2.2-rc.5 已有），Docker Hub 约 27.7 万 pulls（2026-11-26 查询）。来源：[Docker Hub](https://hub.docker.com/r/smanx/deepseek-harness)。
- 可复用：多阶段编译 node-pty、WS 转发、manifest 公开路径、根路径 token 交换、isLoopback 的兼容思路。
- 风险：root、无 TLS、Basic Auth 是唯一入口控制；对 HTML/JS 做文本替换，DSH 前端一改就可能失效；没有只读根文件系统/cap drop；代理与 DSH 之间是明文。适合快速体验，不适合作为长期安全边界。

### 4.2 omdsh-dev/dsh-container

- 架构：node:24-bookworm-slim；pnpm 精确版本安装 @deepseek-ai/dsh，--allow-build 允许 dsh-subprocess-local、koffi、node-pty、@google/genai、protobufjs 的构建脚本；非 root 用户 node（UID 1000）；运行阶段装 bash/curl/git/jq/ripgrep/g++/make/python3 等。来源：[Dockerfile](https://github.com/omdsh-dev/dsh-container/blob/main/Dockerfile)。
- 隔离：read_only 根文件系统、cap_drop ALL、no-new-privileges、tmpfs /tmp 且必须 **exec**（DSH 会把 node-addon-require-builtin 的预编译原生件复制到临时目录再加载；默认 noexec 会报 “No usable prebuilt binary found”）。来源：[使用指南](https://github.com/omdsh-dev/dsh-container/blob/main/docs/guide.md)、[docker-compose.yaml](https://github.com/omdsh-dev/dsh-container/blob/main/docker-compose.yaml)。
- 卷：/home/node（workspace）与 /home/node/.dsh（配置/会话/附件）两个卷；绑定挂载要求 chown 1000:1000。来源：同上。
- 网络与认证：auth-relay 监听 0.0.0.0:3080，DSH 监听 127.0.0.1:3081；relay 用 **changeOrigin: false** 保留 Host，DSH 侧加 **--trusted-host** 与 **--public-url**；可选 **DSH_CONTAINER_KEY** 开启登录页 + HMAC 签名 Cookie（HttpOnly/SameSite=Lax），HTTP 和 WS 都要求认证；未设 key 时任何能连到端口的人都是 owner。来源：[entrypoint.sh](https://github.com/omdsh-dev/dsh-container/blob/main/docker/entrypoint.sh)、[auth-relay/server.mjs](https://github.com/omdsh-dev/dsh-container/blob/main/docker/auth-relay/server.mjs)、[auth-relay/lib.mjs](https://github.com/omdsh-dev/dsh-container/blob/main/docker/auth-relay/lib.mjs)。
- 工程细节：entrypoint 先起 relay、再起 dsh，trap TERM/INT/USR1 转发信号；healthcheck 检查容器状态；relay 从启动日志读 **dsh web:** token 并自动换取 dsh-auth-* Cookie，浏览器不需要手工粘贴 token。来源：[使用指南](https://github.com/omdsh-dev/dsh-container/blob/main/docs/guide.md)。
- 升级敏感点：Dockerfile 在构建时运行 **patch-dsh.mjs**，向 DSH 的 web frontend 注入 auth-bootstrap.js、增加 container plugin，并对 module loader/settings section/Connection/WebServer 的锚点做精确校验；DSH 内部结构一变，构建就会失败而不是静默出错。来源：[patch-dsh.mjs](https://github.com/omdsh-dev/dsh-container/blob/main/docker/patch-dsh.mjs)。
- 可复用：非 root、只读根、cap drop、tmpfs exec、双卷、健康检查、信号处理、保留 Host + trusted-host + public-url、可选稳定密钥。风险：自定义中继与 package patch 增加升级成本；项目较年轻（GitHub 约 6 stars，2026-11-26）；无 TLS，仍需外部 Caddy/Nginx；只支持站点根路径，不支持 /ui/ 子路径。

## 5. 推荐容器规格（草案，未执行）

### 5.1 形态

~~~text
手机/桌面浏览器
   │ HTTPS 443（可信证书）
   ▼
Caddy（宿主机安装，或 network_mode: host 的容器）
   │ HTTP，保留 Host，转发 Upgrade
   ▼
127.0.0.1:3080（Docker 发布到宿主回环）
   ▼
DSH 容器：dsh web --host 127.0.0.1 --port 3080 --no-open
   --trusted-host dsh.lan --public-url https://dsh.lan
   ├─ /data/dsh   DSH_HOME（会话、附件、profile/插件、凭据）
   └─ /workspace  工作区（代码、inbox 等）
~~~

### 5.2 镜像

- 基础：**node:24-bookworm-slim**（glibc；不建议 Alpine/musl，未验证）。
- 构建阶段：安装 python3/make/g++，**npm install -g @deepseek-ai/dsh@0.2.2-rc.5**；需要运行时装插件则再 corepack enable + pnpm 固定版本。
- 运行阶段：从构建阶段复制 /usr/local；创建 /data、/workspace 并 chown 给 node（UID 1000）；**USER node**；WORKDIR /workspace；ENV DSH_HOME=/data/dsh、HOME=/data/home。
- 入口：tini 或 compose 的 **init: true**；命令 **dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host dsh.lan --public-url https://dsh.lan**。
- 健康检查：Node fetch http://127.0.0.1:3080/，接受 200 或 401（未登录本来就是 401），其他状态失败。
- 钉死版本与基础镜像 digest；不要用 latest。

### 5.3 Compose 草案

~~~yaml
services:
  dsh:
    build: .
    restart: unless-stopped
    init: true
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    stop_grace_period: 20s
    ports:
      - "127.0.0.1:3080:3080"
    tmpfs:
      - /tmp:rw,exec,nosuid,nodev,size=512m,mode=1777
    volumes:
      - dsh-data:/data
      - workspace:/workspace
    environment:
      DSH_HOME: /data/dsh
      HOME: /data/home
      TZ: Asia/Shanghai
      # DEEPSEEK_API_KEY: "..."
  caddy:
    image: caddy:2
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
volumes:
  dsh-data:
  workspace:
  caddy-data:
  caddy-config:
~~~

说明：

- **127.0.0.1:3080:3080** 确保 DSH 端口只在宿主回环可见；Caddy 是唯一 LAN 入口。
- Caddy 用 host 网络是为了直接访问宿主回环；如果 Caddy 装在宿主机上，可以删掉这个服务。
- 只读根 + tmpfs exec 是 dsh-container 已经踩过的坑；/data 与 /workspace 是卷，所以可写。
- 若不用 host 网络，需要让 Caddy 与 DSH 共享网络命名空间或走 host-gateway；不要用容器名直连一个只绑 127.0.0.1 的 DSH。

### 5.4 卷、环境变量、端口

- **DSH_HOME=/data/dsh**：sessions、storages、profiles（含 web profile 与插件）、.credentials.yaml、attachments/v1。默认是 ~/.dsh；容器里必须显式设。来源：[home-paths README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/home-paths/README.zh.md)、[attachment-local README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment-local/README.zh.md)。
- **/workspace**：agent 的默认工作目录/挂载项目；建议把手机上传的 inbox 也放这里（见 §5.6）。
- **/data/home**：HOME，给 pnpm/npm 缓存和运行时插件安装用；不要让它落在只读根上。
- 环境变量：DSH_HOME、HOME、TZ、可选 DEEPSEEK_API_KEY、代理场景 NODE_USE_ENV_PROXY=1、可选 DSH_TELEMETRY_DISABLED=1、按威胁模型设 DSH_PERMISSION_MODE（dsh-container 用 danger-full-access，因为容器就是边界；更保守可用 workspace-write）。
- 端口：DSH 3080 只绑回环；对外只开 Caddy 的 443/80。防火墙只允许内网网段。
- 权限：镜像内 node=UID 1000；绑定挂载必须 chown -R 1000:1000，否则 DSH 无法写配置/附件。来源：[dsh-container 指南](https://github.com/omdsh-dev/dsh-container/blob/main/docs/guide.md)。

### 5.5 首次登录、重启与升级

- 首次：**docker compose logs dsh | grep 'dsh web:'** 取带 token 的 URL；在每台设备打开一次 **https://dsh.lan/?token=...**，换到 Cookie 后书签干净的 **https://dsh.lan/**。
- 重启：token 会变，但 Cookie 签名密钥在 /data/dsh 里持久化，已登录设备不用重新登录；新设备/清 Cookie 的设备需要当前日志里的 token。若删除/重置 .credentials.yaml，所有旧 Cookie 失效。来源：[browser-auth.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/authentication-token/src/browser-auth.ts)、[dsh-container 指南](https://github.com/omdsh-dev/dsh-container/blob/main/docs/guide.md)。
- 升级：改钉死版本 → 重建镜像 → **docker compose up -d**；DSH_HOME/workspace 卷保留。升级前备份 /data/dsh（尤其 .credentials.yaml、sessions、attachments、profiles）与 workspace；DSH 会话格式有迁移，插件也可能要重装/适配。
- 插件：dsh plugin --profile web add 在容器内执行；需要 pnpm 与网络，profile 目录在 DSH_HOME 里，升级后保留但可能不兼容新版本。
- 备份：停容器或做卷快照；附件永远不会自动删除，卷会持续增长，需要容量监控。来源：[attachment-local README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment-local/README.zh.md)。

### 5.6 手机 PWA 与 inbox

- DSH Web 前端自带 **manifest.webmanifest**（name/short_name/start_url/scope/display/icons），手机可以尝试“添加到主屏幕”。来源：[apps/web/public/manifest.webmanifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/web/public/manifest.webmanifest)。
- 本机 0.2.2-rc.5 的 dist 文件清单里**没有看到 service worker**；是否可安装、离线行为取决于浏览器，本票未实测。HTTPS 是安全上下文的前提。来源：[MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)。
- DSH 原生上传**不是**写到一个用户可见的 workspace/inbox：图片和通用文件持久化在 **DSH_HOME/attachments/v1**（图片 objects，通用文件 file-objects/files 硬链接），会话事件只引用这些不可变对象。来源：[attachment 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.zh.md)、[attachment-local README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment-local/README.zh.md)。
- 因此：如果产品定义是“手机把文件附加到对话，agent 能读”，原生上传就够了；如果产品定义是“文件落到服务器上的 inbox 目录，由别的流程消费”，需要额外挂载 inbox 并做移动/监听/同步——这部分不属于本票的容器化范围，建议在上传票里明确。**这是本 map 最需要澄清的接口点之一。**

## 6. 已知坑

1. **安全上下文**：LAN HTTP 不是安全上下文；randomUUID 在 0.2.2-rc.5 已用 getRandomValues 替代，但 PWA/Service Worker/部分 API 仍要求可信 HTTPS。手机不信任 CA 时，点过证书警告也不等于安全上下文。来源：[MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)。
2. **WebSocket/SSE**：DSH 用 /api/remote.mux WebSocket；反代必须转发 Upgrade/Connection，不能缓冲。Caddy 自动支持；Nginx 需要 proxy_http_version 1.1 + Upgrade/Connection，并在 dsh-container 指南里有现成示例。来源：[Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[dsh-container 指南](https://github.com/omdsh-dev/dsh-container/blob/main/docs/guide.md)。
3. **Host/Origin 403**：反代改写 Host 而不改 Origin 会被 DSH 拒绝；官方建议保留 Host 并用 --trusted-host。smanx 通过 changeOrigin + 重写 Origin 绕过，但这是额外 patch 面。来源：[public-deployments 文档](https://deepseek-harness.github.io/deepseek-harness/guide/public-deployments.html)。
4. **Cookie Secure**：DSH 在明文监听器上不签 Secure；反代需补。Caddy 的 header 正则示例可用，但多 Set-Cookie 行/重复属性需要实测；不行就退回 DSH 原生 TLS。
5. **原生模块**：node-pty 在 Linux 没有预编译产物，要在构建阶段用 python3/make/g++ 编译；node-addon-require-builtin 会把预编译件复制到 /tmp，tmpfs 必须 exec；koffi、protobufjs、@google/genai 也有构建脚本。来源：[smanx Dockerfile](https://github.com/smanx/deepseek-harness-docker/blob/main/Dockerfile)、[dsh-container 指南](https://github.com/omdsh-dev/dsh-container/blob/main/docs/guide.md)。
6. **Electron 依赖**：Web/CLI 不需要 Electron；desktop profile 被 CLI 拒绝，官方 Linux 桌面包也没有在官网提供。不要在容器里塞 Electron/Xvfb。
7. **isLoopback 的 UI 限制**：浏览器是否被视为回环由 **transport.ownsHost === true || pageLocation.hostname** 决定；非回环页面下，Settings 的“Open configuration file”不渲染（**ctx.remote.$host.isLoopback** 为 false），目录选择器自动退回 browse。smanx 还声称插件配置卡片会受影响，但我在 0.2.2-rc.5 安装包里只确认了这两处，其余未证实。来源：[connection client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/src/client/index.ts)、[ui-settings-general](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-general/src/client/index.ts)、[directory-picker-auto](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/directory-picker-auto/src/resolve.ts)。
8. **token 在日志里**：能读 docker logs 的人等同容器管理员；不要把带 token 的 URL 发到聊天/工单。token 每进程轮换，旧书签会失效；用干净 URL 书签 + Cookie。
9. **附件不回收**：attachments/v1 永远不会自动删除，也没有引用回收；卷会持续增长，必须做容量与备份策略。来源：[attachment-local README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment-local/README.zh.md)。
10. **只读根 + HOME**：pnpm/npm 缓存、插件安装需要可写 HOME；只读根文件系统时要把 HOME 指到卷，或按 dsh-container 把 /home/node 整体做成卷。
11. **容器不是身份边界**：agent 在容器里能读到 DSH_HOME 的凭据和进程环境里的 API key；单用户场景可以接受，但不要把不可信任务和敏感 key 混在一起。dsh-container 指南也明确说共享密钥留在 DSH 进程环境里，agent 可以读取/外传。来源：[dsh-container 指南](https://github.com/omdsh-dev/dsh-container/blob/main/docs/guide.md)。
12. **Caddy 内部 CA 的信任**：tls internal 生成自己的根；服务器上 caddy trust 只解决本机，手机需要手动安装根证书（iOS 还要在“证书信任设置”里启用完全信任；Android 各版本不同）。未在本环境实测。来源：[Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)。

## 7. 方案对比

| 方案 | 绑定/TLS | 认证 | 持久化与升级 | 评价 |
|---|---|---|---|---|
| A. 官方 npm 自建 + Caddy（推荐） | DSH 127.0.0.1:3080；Caddy 443，tls internal 或真实证书 | DSH token + 持久 Cookie | DSH_HOME + workspace 双卷；重建镜像升级 | 不 patch DSH，最符合官方语义；多一个 Caddy，Cookie Secure 需实测 |
| B. 官方 npm 自建 + DSH 原生 TLS | DSH 直接绑 LAN/容器 IP，--tls-cert/--tls-key | 同上，Cookie 天然 Secure | 同上；证书手工续期/重启 | 组件最少；证书运维差、端口直曝、容器 IP 变化麻烦 |
| C. smanx/deepseek-harness | 容器内 3079 + 代理 0.0.0.0:3080；无 TLS | Basic Auth（可选）+ DSH Cookie | /root/.dsh 卷；镜像 tag 升级 | 上手最快；root、无 TLS、前端文本 patch，升级易碎 |
| D. omdsh-dev/dsh-container | 3081 + relay 3080；无 TLS | 可选共享密钥（HMAC Cookie）；relay 自动换 DSH Cookie | 双卷；重建镜像升级；patch 有锚点校验 | 硬化最好；自定义中继/patch 增加升级成本，项目年轻 |
| E. 桌面端容器化 | Electron + Xvfb/VNC | 桌面单实例 | 不适用 | 不推荐：无官方 Linux 包、镜像重、无头/手机体验差 |

## 8. 推荐

**v1 选 A：官方 npm 薄镜像 + Caddy 反代。**

理由：

- 唯一官方支持的运行物就是 npm 包；不 patch DSH 内部文件，升级只需换版本重建。
- DSH 保持回环，LAN 只暴露 Caddy 的 443；Host/Origin/WS 行为与官方文档一致。
- 单令牌直接用 DSH 的 token + 持久 Cookie，不引入第二套认证。
- Caddy 负责证书、80→443 跳转、WS；比 DSH 原生 TLS 的证书轮换省事。
- 社区镜像的工程经验可以借用：dsh-container 的非 root/只读/cap drop/tmpfs exec/健康检查/信号处理，smanx 的多阶段 node-pty 构建/WS 转发/manifest 公开路径。

实施顺序（规格）：

1. 给主机固定 LAN IP 或 DHCP 保留；选一个稳定名字（如 dsh.lan）并在路由器 DNS 指向该 IP；防火墙只放行内网到 443/80。
2. 构建 §5.2 的镜像，钉死 0.2.2-rc.5 与基础镜像 digest；非 root、tini、健康检查。
3. 起 §5.3 的 compose；确认 DSH 只发布到 127.0.0.1:3080，DSH_HOME/workspace 卷可写。
4. 配 §3.2 的 Caddyfile：tls internal（或真实证书）、保留 Host、WS、补 Secure；把 Caddy 根证书装进手机并信任。
5. DSH 启动参数加 **--trusted-host dsh.lan** 与 **--public-url https://dsh.lan**；不要加 0.0.0.0。
6. 从日志取 token URL，每台设备登录一次；确认 Cookie 在容器重启后仍有效。
7. 验收：未带 Cookie 的 / 返回 401；WebSocket 101；手机上传后附件在 /data/dsh/attachments 持久化；重启后仍在；插件安装后重启仍在；升级后会话可读。
8. 备份 /data/dsh 与 workspace；监控附件卷增长。

**什么时候选 B/D：** 如果坚持“单进程、无 Caddy”，B 可行但要接受证书手工运维；如果明确需要“用户自定义的稳定单密钥 + 硬化容器”，D 更接近，但要把 patch 与升级风险算进去。smanx 适合快速体验/临时演示，不建议作为长期唯一入口。

## 9. 风险与未解问题

### 高

- **手机 HTTPS 信任未实测**：Caddy 内部 CA 根证书在 iOS/Android 的安装与完全信任步骤未验证；不信任则 PWA/安全上下文失败。需要一台真实手机做验收。
- **Caddy 补 Secure 的行为未实测**：header >Set-Cookie 正则在多条 Set-Cookie、已有属性时的表现需要抓包确认；失败则改用 DSH 原生 TLS 或换反代。
- **单令牌的“稳定口令”预期**：DSH 的 token 每进程轮换，没有用户可配置的固定密码；如果产品要求“一个永远不变的 token”，需要 dsh-container 式 relay 或自建认证层，这会增加 patch/维护成本。需要产品确认“单令牌”到底指启动 token 还是固定口令。
- **inbox 语义未定**：DSH 原生上传写到 DSH_HOME/attachments，不写 workspace/inbox；如果 map 要求“服务器 inbox 目录”，需要额外设计，不能只靠容器卷。

### 中

- **isLoopback UI 限制的范围**：0.2.2-rc.5 只确认 Settings 的“Open configuration file”和目录选择器受影响；插件配置卡片是否也受影响未证实（smanx 声称是）。如果手机端要改模型/插件，需要实测或 patch。
- **PWA 可安装性/离线能力**：manifest 有，但 dist 未见 service worker；Chrome/Safari 的安装条件与离线行为未实测。
- **Caddy 的 HTTP→HTTPS 跳转是否保留 ?token 查询串**：未实测；首次登录建议直接打开 https URL。
- **社区镜像未审计**：smanx/dsh-container 都在 patch DSH，升级可能碎；dsh-container 的 patch 有锚点校验，smanx 是文本替换，风险更高。没有做安全审计。
- **原生模块构建**：node-pty 的 Linux 编译、node-addon-require-builtin 的 /tmp exec 未在目标机验证；Alpine/musl 未验证，不建议。
- **Caddy host 网络**：network_mode: host 仅 Linux；Docker Desktop/Mac 不适用。目标机是 Linux，符合前提，但部署文档要写清楚。

### 低/待确认

- 反代后 DSH 打印的 public URL 是否正确（--public-url 应解决）。
- 多设备共享 Cookie 的体验：每台设备各自登录一次；配对流程（设置 → 远程连接）是否适合手机，未实测。
- 容器内 pnpm 版本与 corepack 在 node:24 镜像的可用性；需要构建时验证。
- 附件卷的备份/恢复演练；sessions 格式迁移的兼容性。
- 官方未来是否提供容器支持/稳定认证；截至 2026-11-26 未发现。

## 10. 一手来源

官方：

- [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)
- [CLI 帮助（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.zh.md)
- [在反向代理之后发布 Web UI](https://deepseek-harness.github.io/deepseek-harness/guide/public-deployments.html)
- [WebApp README（监听、TLS、token、公开部署）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.zh.md)
- [Web server 参考](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-server.html)
- [web-app startup/flags 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/src/startup.ts)
- [web profile patch](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/cordis.patch.yml)
- [BrowserAuth（token/持久密钥）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/authentication-token/src/browser-auth.ts)
- [Connection client（isLoopback）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/src/client/index.ts)
- [WebSocket 路径](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/gateway/src/stream-protocol.ts)
- [util-crypto（randomUUID）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/crypto/README.zh.md)
- [home-paths（DSH_HOME）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/home-paths/README.zh.md)
- [attachment-local（附件存储）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment-local/README.zh.md)
- [attachment 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.zh.md)
- [PWA manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/web/public/manifest.webmanifest)
- [npm 0.2.2-rc.5 metadata](https://registry.npmjs.org/@deepseek-ai/dsh/0.2.2-rc.5)
- [release 页（无 assets）](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)
- [桌面打包配置（AppImage target）](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/scripts/electron-builder-config.mjs)

社区：

- [smanx/deepseek-harness-docker](https://github.com/smanx/deepseek-harness-docker)
- [smanx Dockerfile](https://github.com/smanx/deepseek-harness-docker/blob/main/Dockerfile)
- [smanx proxy/index.js](https://github.com/smanx/deepseek-harness-docker/blob/main/proxy/index.js)
- [smanx Docker Hub](https://hub.docker.com/r/smanx/deepseek-harness)
- [omdsh-dev/dsh-container](https://github.com/omdsh-dev/dsh-container)
- [dsh-container Dockerfile](https://github.com/omdsh-dev/dsh-container/blob/main/Dockerfile)
- [dsh-container 使用指南](https://github.com/omdsh-dev/dsh-container/blob/main/docs/guide.md)
- [dsh-container entrypoint](https://github.com/omdsh-dev/dsh-container/blob/main/docker/entrypoint.sh)
- [auth-relay server](https://github.com/omdsh-dev/dsh-container/blob/main/docker/auth-relay/server.mjs)
- [patch-dsh.mjs](https://github.com/omdsh-dev/dsh-container/blob/main/docker/patch-dsh.mjs)

第三方官方文档：

- [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Caddy header（Set-Cookie 正则）](https://caddyserver.com/docs/caddyfile/directives/header)
- [MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
- [MDN crypto.randomUUID](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)
