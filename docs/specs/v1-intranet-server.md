# DSH 内网服务器与手机客户端 v1 实施规格

> 状态：v1.2（2026-11-26，插件启停与本地优先补充）· 类型：可实施规格 · 地图：[DSH 内网服务器与手机客户端 v1](https://github.com/Ar1-s/dsh_dev/issues/1)
>
> 本文件是地图 #1 的目的地交付物。它把 #2–#14 已收口的结论合拢成一份可以直接照做的规格；实现代码不在本轮，实施按 §13 的顺序拆票。
>
> 证据等级：**S** = 在 DSH 0.2.2-rc.5 源码/文档中直接读到；**D** = 本规格的设计决定；**U** = 尚未在目标环境验证，已列入 §14。

---

## 0. 怎么读这份规格

- 要部署：读 §4–§6、§9、§11、§12。
- 要写文件桥插件：读 §7、§8、§9、§10、§12。
- 要验收：读 §12；要排期：读 §13；要评估风险：读 §14。
- 要理解「为什么不是别的做法」：读 §7.3 与 §16。

规格里的路径、字段名、状态码、目录名都是**规范性**的；实现不得静默改名。若实现中发现某条不可行，先改本规格并记录原因，再改代码。

---

## 0.1 调查范围与既有笔记复用

本轮先读了地图 #1、本票正文与 3 条评论、#2–#14 的正文与 resolution 评论，以及仓内已有的研究笔记/原型。结论：

- 既有笔记覆盖的事实层（不复述全文，只记一句话结论）：
  - `research/intranet-https-auth.md`：Caddy 唯一入口 + DSH 明文 HTTP + 同源 cookie；token 换 30 天（后调 90 天）cookie；Caddy 必须给 Set-Cookie 补 Secure。
  - `research/mobile-pwa-capture.md`：原生 file input + capture 四入口够用；v1 不注册 SW；HEIC/MOV 服务端归一化。
  - `research/dsh-file-model.md`：workspace 是目录注册表；附件库与工作区两套存储；sidecar 写 inbox 后 agent 下一次工具调用可见但不通知。
  - `research/plugin-headless.md` / `research/dsh-web-container.md` / `research/pinning-upgrade.md`：web profile、官方 npm 薄镜像 + Caddy、profile seed 指纹刷新、同进程插件风险。
  - `research/mobile-dsh-client.md` / `research/dsh-auth-modes.md`：DSH Web PWA + 双端插件可行；无「按服务器路径附加附件」API；rc.5 无 pre-submit 公开回调（本轮进一步核实了替代路径）。
  - `research/agents-anywhere.md`：v1 不采用 AA，只借鉴设备绑定/幂等/检查点等 5 点。
  - `research/file-bridge-packaging.md`：双端包最小清单、零构建 client bundle、加载期失败粒度。
- **既有笔记不能回答**「普通消息发送那一刻能否由插件把 chip 换成路径」：mobile-dsh-client 只列了草稿纯文本/代发/`agent.inject` 三条，均不满足「这条消息、可阻断、非伪造」的约束。因此按 /research 规则新查一次，产物：
  [research/rc5-composer-send-hook.md](https://github.com/Ar1-s/dsh_dev/blob/research/rc5-composer-send-hook/research/rc5-composer-send-hook.md)（分支 `research/rc5-composer-send-hook`，commit `088aedf`）。
- 结论已并入 §7；不复制笔记全文。

---

## 1. 目的地与范围

### 1.1 目的地

在 x86_64 Linux 内网主机上用 Docker 运行 DSH Web（HTTPS、单令牌接入、数据持久化、两个本地双端插件可用），并让手机通过 DSH Web PWA 使用云端 agent：

1. 对话、会话切换、工作区浏览与下载复用 DSH Web。
2. 手机把照片/视频/任意文件上传到**当前会话 workspace 的 `inbox/`**。
3. 上传的文件在**用户按下发送的那一刻**提交到最终路径，并把 workspace 相对路径放进**这条消息**，agent 在同一轮看到。
4. 发送前撤掉附件 chip 只删除暂存区文件，工作区不产生文件、manifest 不写行。

v1 的完成定义是**规格 + 验收清单**，不是可运行实现；但规格必须细到实施者不需要再做产品决策。

### 1.2 范围基线（继承已关票）

| 项 | v1 决定 | 来源 |
|---|---|---|
| 客户端形态 | DSH Web PWA + 文件桥插件；不 patch DSH、不做移动壳/原生 App | #4、#6、#14 |
| 服务器 | 官方 npm 薄镜像 + Caddy 唯一入口；不采用社区镜像 | #2、#7、#11 |
| 认证 | DSH 启动 token 一次性换 90 天 HttpOnly cookie；不做 BasicAuth/SSO | #2、#6 |
| 文件桥 | 本仓 `plugins/dsh-file-bridge/` 单包双半、零构建纯 JS | #14 |
| 落点 | 当前会话 workspace 的 `inbox/YYYY/MM/DD/<device>/` | #10 |
| 提交时机 | 发送时从 `inbox/.pending/<requestId>` 原子 rename 到最终路径并写 manifest | #5、#10 |
| 注入 | 发送时把路径放进这条消息；**不使用 agent.inject** | §7（对 #5/#6/#10 的修正） |
| 下载 | 复用 DSH Web 文件树/下载；≤50 MiB | #4、#6、#10 |
| 媒体 | HEIC/HEIF → JPEG（不保留原 HEIC）；MOV/其他原样；不做视频转码 | #10 |
| 上限 | 照片 20 MB；视频 200 MB 且 ≤60 s；其他 200 MB；单批 10；并发 1；无断点续传 | #4、#6 |
| 部署环境 | 内网、单用户、x86_64 Linux、Docker Compose | 地图 #1 |

### 1.3 明确不做（v1）

原生 iOS/Android App、移动壳、独立客户端；企业 SSO/多用户/租户隔离；公网直接暴露；Web Share Target；后台上传/断点续传；服务端上传历史/删除/重命名 UI；上传后自动触发 agent；视频转码/转写/关键帧；>50 MiB 的流式下载；桌面本地 DSH/桌面客户端；DSH 本体的多用户改造。

---

## 2. 术语

- **Host / 宿主半**：插件在 DSH 宿主进程（Node）里的代码，经包主入口装入 profile；能写文件、注册路由、使用 host 服务，但没有界面。
- **Client / 浏览器半**：插件在 DSH Web 页面里的代码，由 `dsh.client.platform: "web"` 与 `exports["./client"]` 声明；页面以 classic script 加载并注册成 Cordis 插件，能渲染 slot、调用已认证的同源 HTTP 路由。
- **workspace**：DSH 的目录注册表记录；会话创建时把 workspace 路径写进不可变的 `SessionHeader.cwd`。v1 固定根 `/data/workspaces/main`。
- **inbox**：workspace 根下的上传区 `inbox/`，不是独立 workspace。
- **pending**：`inbox/.pending/` 下的暂存文件；发送前只存在这里。
- **commit**：把 pending 原子 rename 到 `inbox/YYYY/MM/DD/<device>/` 并追加 manifest 的动作。
- **chip**：composer 里的原子引用节点；显示文件名，提交时由 reference codec 序列化成路径。
- **path**：workspace 相对路径，例如 `inbox/2026/11/26/phone-a1b2c3d4/20261126T143005Z-3f2a9c1d-report.pdf`；消息里写作 `@` + path。
- **Caddy**：唯一对外入口，终止 TLS、提供 `/login/` 静态页、反代到 DSH。

---

## 3. 总体架构

~~~
手机浏览器 / PWA
   │  HTTPS 443（内网 CA 或真实域名）
   ▼
Caddy（唯一入口；TLS、/login/ 静态页、反代、Set-Cookie 补 Secure、日志跳过 token）
   │  HTTP 3080（Compose 网络内；不发布端口）
   ▼
DSH 容器（node:24-bookworm-slim；@deepseek-ai/dsh@0.2.2-rc.5；web profile）
   ├─ @local/dsh-laser-report  宿主半 + 浏览器半（既有业务插件）
   └─ @local/dsh-file-bridge   宿主半 + 浏览器半（本规格）
        ├─ 宿主半：/api/bridge/* 精确路由；写 /data/workspaces/main/inbox/
        └─ 浏览器半：composer 的 + 面板、托盘、reference chip、进度/重试
   卷：dsh-home（DSH_HOME）/ dsh-workspace（/data/workspaces/main）
~~~

关键边界：

- 浏览器只经 Caddy 访问；DSH 端口不发布，Host/Origin 栅栏只接受 `dsh.lan` 与容器自身绑定 IP。
- 文件桥只写 `<workspace>/inbox/` 与 `inbox/.pending/`；不写 `attachments/v1`。
- 路径注入不走第二条消息、不走 `agent.inject`、不伪造用户消息；它在**普通发送事务**里由 reference codec 生成，作为这条消息正文的一部分。
- 文件内容的唯一事实源是文件系统 + `inbox/_meta/`；没有第二套索引。

---

## 4. 版本与钉住

### 4.1 版本表

| 组件 | v1 值 | 钉法 |
|---|---|---|
| DSH | `@deepseek-ai/dsh@0.2.2-rc.5` | 精确版本，不用 range |
| Node | node:24-bookworm-slim（≥24.9） | 基础镜像按 digest 钉；digest 写进 `deploy/versions.lock` |
| pnpm | `11.28.5` | 构建期 corepack 精确激活；与 DSH 同版本升级/回滚 |
| Caddy | `caddy:2.11`（或更高 2.x，按 digest） | 镜像 digest；内部 CA 场景不发布 UDP/443 |
| 文件桥插件 | `@local/dsh-file-bridge@0.1.0` | 镜像 tag + OCI `org.opencontainers.image.revision`（构建 commit）；包版本仅追踪 |
| 激光插件 | `@local/dsh-laser-report@0.1.0` | 私有仓 `Ar1-s/file_analysis` 的 commit SHA（v1 用 `0f57681` 或后继显式 pin）；构建期只读凭据 |
| 版本豁免 | 0 条 | `profiles/web/compatibility.json` 为空；构建/启动断言 |

### 4.2 钉住规则

- 插件安装一律 `dsh plugin --profile web add <spec> --save-exact`；锁文件 `profiles/web/pnpm-lock.yaml` 入库。
- CI 断言 `profiles/web/package.json` 的依赖里没有 `^`/`~`/`latest`；镜像构建后 `--dump-config` 两插件都在。
- 基础镜像 digest、Caddy digest、DSH 版本、两个插件 commit 全部写进 `deploy/versions.lock`，由构建脚本读取；不允许在 Dockerfile 里散落 `latest`。
- 升级 DSH 必须同时重验 reference codec 相关扩展点（§7.2）与插件加载契约；本规格按 rc.5 固定，跨版本升级不是自动兼容。

---

## 5. 部署拓扑与容器

### 5.1 Compose（规范性骨架）

文件：`deploy/compose.yml`。变量从 `.env` 读取，`.env` 不入库。

~~~yaml
name: dsh-intranet

x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"

services:
  dsh:
    image: ${DSH_IMAGE:?set DSH_IMAGE in .env}
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs:
      - /tmp:rw,exec,mode=1777
    environment:
      DSH_HOME: /data/dsh-home
      HOME: /data/dsh-home
      DSH_PYTHON: /usr/bin/python3
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:?set DEEPSEEK_API_KEY in .env}
      DSH_PUBLIC_URL: ${DSH_PUBLIC_URL:-https://dsh.lan/}
      DSH_TRUSTED_HOST: ${DSH_TRUSTED_HOST:-dsh.lan}
    volumes:
      - dsh-home:/data/dsh-home
      - dsh-workspace:/data/workspaces/main
    # 不发布 3080：只有 Caddy 经 Compose 网络访问
    cap_drop: [ALL]
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          node -e "const http=require('http'),os=require('os');
          const ip=Object.values(os.networkInterfaces()).flat()
            .find(i=>i&&i.family==='IPv4'&&!i.internal)?.address;
          if(!ip)process.exit(1);
          http.get('http://'+ip+':3080/',r=>process.exit([200,303,401,403].includes(r.statusCode)?0:1))
            .on('error',()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 30s
    logging: *default-logging

  caddy:
    image: ${CADDY_IMAGE:?set CADDY_IMAGE in .env}
    restart: unless-stopped
    depends_on:
      dsh:
        condition: service_healthy
    ports:
      - "80:80"
      - "443:443"
      # 不发布 443/udp：内部 CA 下避免 HTTP/3 证书信任问题
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./login:/srv/login:ro
      - caddy-data:/data
      - caddy-config:/config
    logging: *default-logging

volumes:
  dsh-home:
  dsh-workspace:
  caddy-data:
  caddy-config:
~~~

要点：

- **DSH 不发布端口**；Caddy 经 Compose 网络访问 `dsh:3080`。DSH 绑定容器自身 IPv4（不是 `0.0.0.0`，rc.5 拒绝通配地址），由 entrypoint 解析。
- 卷只挂两个：`dsh-home`（sessions/attachments/storages/logs/.credentials.yaml/profiles）与 `dsh-workspace`（`/data/workspaces/main`，inbox 在其中）。不挂 docker socket、不挂宿主机 home。
- 根文件系统只读；`/tmp` 是 exec tmpfs（Office/WASM 与部分运行时需要）。
- 单用户 + 内网 + 最小挂载是 v1 的安全边界；不承诺对抗拿到容器或宿主权限的攻击者。

### 5.2 镜像构建

参考 Dockerfile（`deploy/Dockerfile`）：

~~~dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:<写进 versions.lock>
FROM ${NODE_IMAGE} AS build

ARG DSH_VERSION=0.2.2-rc.5
ARG PNPM_VERSION=11.28.5
ARG LASER_COMMIT=<写进 versions.lock>
ARG BUILD_REVISION=<build commit>

ENV DSH_HOME=/opt/dsh-seed \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-openpyxl python3-pil \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION}

# 本仓插件：构建上下文直接带入
COPY plugins/dsh-file-bridge /opt/plugins/dsh-file-bridge
# 私有仓插件：构建机用只读凭据 clone 到固定 commit（不把 token 写进镜像层）
COPY vendor/dsh-laser-report /opt/plugins/dsh-laser-report

# 构建期密文扫描：绿盾 %TSD-Header- 命中即失败
RUN if grep -RIl --exclude-dir=node_modules '%TSD-Header-' /opt/plugins; then \
      echo 'plaintext guard failed' >&2; exit 1; \
    fi

RUN dsh plugin --profile web add file:/opt/plugins/dsh-file-bridge --save-exact \
 && dsh plugin --profile web add file:/opt/plugins/dsh-laser-report --save-exact

# 断言 profile 依赖里没有浮动版本
RUN if grep -E '"@local/(dsh-file-bridge|dsh-laser-report)": "\^|~' /opt/dsh-seed/profiles/web/package.json; then \
      echo 'floating plugin version' >&2; exit 1; \
    fi

# 种子指纹：内容变化就换指纹，entrypoint 据此刷新卷里的 profiles
RUN node -e "const fs=require('fs'),c=require('crypto');\
const p='/opt/dsh-seed/profiles/web';\
const h=c.createHash('sha256');\
for(const f of ['package.json','pnpm-lock.yaml','cordis.patch.yml','cordis.yml'])\
  h.update(fs.readFileSync(p+'/'+f));\
fs.writeFileSync(p+'/.seed-id',h.digest('hex')+'\\n')" \
 && echo "$BUILD_REVISION" >> /opt/dsh-seed/profiles/web/.seed-id

FROM ${NODE_IMAGE}
ARG DSH_VERSION=0.2.2-rc.5
ENV DSH_HOME=/data/dsh-home \
    HOME=/data/dsh-home \
    DSH_PYTHON=/usr/bin/python3 \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-openpyxl python3-pil fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /usr/local/bin/dsh /usr/local/bin/dsh
COPY --from=build /opt/dsh-seed/profiles /opt/dsh-seed/profiles
COPY --from=build /opt/plugins /opt/plugins
COPY deploy/entrypoint.sh /usr/local/bin/dsh-entrypoint
COPY deploy/patches /etc/dsh/patches
RUN chmod 0755 /usr/local/bin/dsh-entrypoint

LABEL org.opencontainers.image.revision="<build commit>"
LABEL org.opencontainers.image.version="0.2.2-rc.5"

ENTRYPOINT ["/usr/local/bin/dsh-entrypoint"]
~~~

说明：

- 运行阶段不装 pnpm、不需要外网；插件已随 profile 的 `node_modules` 打好。
- 只 `COPY` 运行所需；`/opt/plugins` 保留源目录便于排障与 `file:` 路径一致。
- HEIC 解码依赖在构建期装进 profile（见 §9.9）；不要依赖运行期安装。
- **npm 11 的 allowScripts**：DSH 依赖里 `@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`、`protobufjs` 有 install/postinstall 脚本；npm 11 默认把它们标成 pending，`npm install` 只打 warning。构建必须显式 `npm install-scripts approve <pkg>`（精确版本）并重跑重建，或在冒烟中验证 `koffi`/`node-pty`/`subprocess-local` 可加载且 PTY 可用；不要把 warning 当通过。
- seed 指纹必须包含 `BUILD_REVISION`（构建 commit）或插件文件哈希：只哈希 profile 文件时，插件源码变了但版本号没变会导致卷里的旧 profile 不刷新。
- 若激光插件仓是私有的，构建机的只读凭据只用于 clone；不要把 token 写进 Dockerfile、构建参数或镜像层。

### 5.3 entrypoint（规范性骨架）

文件：`deploy/entrypoint.sh`。以 root 启动，完成卷初始化后 drop 到 uid/gid 1000。

~~~sh
#!/bin/sh
set -eu

DSH_HOME="${DSH_HOME:-/data/dsh-home}"
DSH_WORKSPACE="${DSH_WORKSPACE:-/data/workspaces/main}"
DSH_PUBLIC_URL="${DSH_PUBLIC_URL:-https://dsh.lan/}"
DSH_TRUSTED_HOST="${DSH_TRUSTED_HOST:-dsh.lan}"
SEED=/opt/dsh-seed/profiles/web

log() { printf '[dsh-entrypoint] %s\n' "$*" >&2; }

# 1) 目录与属主（只改根目录，不递归改用户文件）
install -d -m 0755 -o 1000 -g 1000 "$DSH_HOME" "$DSH_WORKSPACE"
install -d -m 0755 -o 1000 -g 1000 "$DSH_WORKSPACE/inbox" \
  "$DSH_WORKSPACE/inbox/_meta"
install -d -m 0700 -o 1000 -g 1000 "$DSH_WORKSPACE/inbox/.pending"
install -d -m 0755 -o 1000 -g 1000 "$DSH_WORKSPACE/inbox/.staging"

# 2) profile 种子按指纹刷新；旧目录留 bak，最多 3 份
need_seed=0
if [ ! -f "$DSH_HOME/profiles/web/.seed-id" ]; then
  need_seed=1
elif ! cmp -s "$SEED/.seed-id" "$DSH_HOME/profiles/web/.seed-id"; then
  need_seed=1
fi
if [ "$need_seed" = 1 ]; then
  ts=$(date -u +%Y%m%d%H%M%S)
  if [ -d "$DSH_HOME/profiles/web" ]; then
    mv "$DSH_HOME/profiles/web" "$DSH_HOME/profiles/web.bak-$ts"
  fi
  mkdir -p "$DSH_HOME/profiles"
  cp -a "$SEED" "$DSH_HOME/profiles/web"
  # 保留用户 patch（插件启停/覆盖）；运行时安装的依赖仍以镜像为准
  if [ -f "$DSH_HOME/profiles/web.bak-$ts/cordis.patch.yml" ]; then
    cp -a "$DSH_HOME/profiles/web.bak-$ts/cordis.patch.yml" "$DSH_HOME/profiles/web/cordis.patch.yml"
  fi
  chown -R 1000:1000 "$DSH_HOME/profiles/web"
  log "profile seed refreshed ($ts)"
fi
ls -1dt "$DSH_HOME"/profiles/web.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -rf

# 3) 启动前断言配置树（以运行用户写 profile）
setpriv --reuid=1000 --regid=1000 --clear-groups \
  dsh --profile web --patch /etc/dsh/patches/connection.yml --dump-config \
  > /tmp/dump.yml 2> /tmp/dump.err || { cat /tmp/dump.err >&2; exit 1; }
grep -q '@local/dsh-laser-report' /tmp/dump.yml || { echo 'missing laser plugin' >&2; exit 1; }
grep -q '@local/dsh-file-bridge' /tmp/dump.yml || { echo 'missing file-bridge plugin' >&2; exit 1; }
if grep -Eq 'skipping profile bundle|did not activate|startup failed' /tmp/dump.err; then
  cat /tmp/dump.err >&2
  exit 1
fi

# 4) 解析容器 IPv4（绑定具体 IP；不用 0.0.0.0）
BIND_IP=$(node -e "const os=require('os');const a=Object.values(os.networkInterfaces()).flat().find(i=>i&&i.family==='IPv4'&&!i.internal);process.stdout.write(a?a.address:'127.0.0.1')")
log "binding dsh to $BIND_IP:3080, public $DSH_PUBLIC_URL"

# 5) drop 到 1000 启动
exec setpriv --reuid=1000 --regid=1000 --clear-groups \
  dsh --profile web \
    --patch /etc/dsh/patches/connection.yml \
    --host "$BIND_IP" --port 3080 --no-open \
    --public-url "$DSH_PUBLIC_URL" \
    --trusted-host "$DSH_TRUSTED_HOST"
~~~

注意：

- `--dump-config` 会写 profile，因此必须在 uid 1000 可写之后、以 1000 执行；本机 rc.5 的 profile 必须可写（#7 已记录）。
- 每次启动都会重写 `cordis.yml`，但不会重装插件；插件更新靠镜像 + seed 指纹刷新。
- 非空卷会遮住镜像里的 `profiles`；所以 seed 刷新不是可选项。
- seed 刷新会保留旧 profile 的 `cordis.patch.yml`（插件启停/用户覆盖）；不保留运行时安装的依赖与 `node_modules`。只做启停时不需要 pnpm；运行时 install/remove 另见 §20。
- `setpriv --clear-groups` 在 Debian bookworm 可用；若目标基础镜像没有 `setpriv`，用 `gosu 1000:1000` 等价替换，但必须在规格里改。
- `--patch` 的 patch 文件内容见 §6.2。

### 5.4 Caddy（规范性骨架）

文件：`deploy/Caddyfile`。默认 internal CA（无域名）；有真实域名时替换 `tls` 行为 DNS-01，并需自定义 Caddy 构建（标准镜像不带第三方 DNS provider）。

~~~caddy
{
  # internal CA 场景不发布 UDP/443；这里显式只开 h1/h2，避免 HTTP/3 的本地信任差异
  servers {
    protocols h1 h2
  }
}

https://${DSH_HOST:dsh.lan} {
  tls internal

  # 访问日志：带 token 的 URL 不落日志
  @token query token=*
  log {
    output stdout
    format console
    log_skip @token
  }

  route {
    # 无 cookie 且没有 token 的根请求 -> 登录页
    @needsLogin {
      method GET
      path /
      not header Cookie *dsh-auth-*
      not query token=*
    }
    redir @needsLogin /login/ 302

    # /login/ 静态页，先于反代
    handle /login* {
      root * /srv/login
      try_files {path} /index.html
      file_server
      header Cache-Control "no-store"
      header Referrer-Policy "no-referrer"
      header X-Content-Type-Options "nosniff"
    }

    handle {
      # DSH 在 HTTP 后端签的 cookie 没有 Secure；在 HTTPS 链路上补
      # 目标 Caddy 版本需验证：DSH 目前只发一个 Set-Cookie；若将来多个，验证替换行为
      header >Set-Cookie (.*) "$1; Secure;"

      # 覆盖 200MB 视频；不要设得比业务上限更小
      request_body {
        max_size 220MB
      }

      reverse_proxy dsh:3080 {
        stream_close_delay 5m

        # 过期/无效 cookie：根请求 401 -> 登录页；/api/* 的 401 保持空响应，
        # 避免浏览器 fetch 把登录 HTML 当 API 结果
        @unauth {
          status 401
          method GET
          path /
          not query token=*
        }
        handle_response @unauth {
          redir /login/ 302
        }
      }
    }
  }
}

http://${DSH_HOST:dsh.lan} {
  redir https://${DSH_HOST:dsh.lan}{uri} 308
}
~~~

要点：

- 保留浏览器可见的 `Host`；Caddy 默认保留，不要改成 `127.0.0.1`。
- WebSocket 与 SSE：Caddy 默认转发 `Upgrade`，SSE 自动 flush；`stream_close_delay` 让配置 reload 不立刻踢掉所有连接。
- 不配置 `forward_auth`；认证只在 DSH。`/login/` 是 Caddy 静态页，不抢 DSH 的 index fallback。
- `Set-Cookie` 补 `Secure` 的规则必须实测：DSH 目前只发一个会话 cookie（S）。若目标 Caddy 的 `header` 对多值 Set-Cookie 的行为不同，需在升级验收中复测。
- 内部 CA 根证书：`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./deploy/root.crt`；手机安装并（iOS）开启完全信任。Caddy 的 `/data` 卷必须备份，丢了等于所有手机重装根证书。
- 不发布 UDP/443；internal CA + HTTP/3 在部分 Chrome 上会绕过本地信任。

---

## 6. 认证与登录

### 6.1 流程

1. 操作员启动容器，DSH 打印 `dsh web: https://dsh.lan/?token=<43字符>`（token 是进程级一次性凭据，重启即换）。
2. 手机打开 https://dsh.lan/：无 cookie、无 token query -> Caddy 302 到 `/login/`。
3. `/login/` 是 Caddy 静态页。用户粘贴 token；页面用同源 `fetch('/?token=...')` 交换。
4. DSH 校验 token 后回 303 + `Set-Cookie: dsh-auth-<hash>=...; Path=/; HttpOnly; SameSite=Strict`；Caddy 在 HTTPS 链路上补 `Secure`。
5. 浏览器跟随 303 到 `/`，拿到 DSH index；之后 `/api/*`、WebSocket、`/plugins/*` 都带该 cookie。
6. cookie 是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`，寿命 90 天（`cookieMaxAgeDays`）。
7. 刷新、重启容器、换网络都不掉登录；换签名密钥（删除 `client-connection/browser-session` 凭据并重启）会撤销所有设备。

### 6.2 90 天 cookie 的配置补丁

DSH 的 web bundle 里 `connection` 行默认 `cookieMaxAgeDays: 30`（S，`@deepseek-ai/dsh-client-connection@0.2.2-rc.5` 的 `ConnectionConfig`）。用 `--patch` 覆盖成 90，并重述 `trustedHosts`（patch 会替换整段 config）：

文件 `deploy/patches/connection.yml`：

~~~yaml
- id: connection
  config:
    trustedHosts: !!js ctx.webStartup.trustedHosts
    cookieMaxAgeDays: 90
~~~

- `trustedHosts` 来自 `--trusted-host`；不重述会丢。`recovery` 与 `maxRequestBodyBytes` 未写，走 schema 默认值（300 MiB）；文件桥的 upload 是 streaming 路由，不受该缓冲上限约束。
- 如果未来企业 SSO 接管登录，cookie 由 SSO 侧管理，本补丁要重新评估。
- 90 天是 v1 值；Chrome 对 cookie 的绝对上限是 400 天，90 留有余量。若维护者要 180 天，只改这一处。

### 6.3 `/login/` 页面

Caddy 静态托管 `/srv/login/index.html`；不经过 DSH，不抢 DSH 的 index fallback。页面是零依赖单文件，行为规范：

- 输入框 `type=password`、`autocomplete=off`、`autocapitalize=off`、`spellcheck=false`；提交后立即清空变量。
- 提交时 `fetch('/?token=' + encodeURIComponent(token), { credentials: 'same-origin', cache: 'no-store' })`；成功（2xx/3xx 跟随后的 index）则 `location.replace('/')`。
- 若 fetch 因浏览器策略没有落下 Set-Cookie，退化到隐藏 iframe 导航到同一个 `/?token=...`；iframe `onload` 后 `location.replace('/')`。
- 失败显示「token 无效或已过期」；不把 token 写入 localStorage/sessionStorage/URL hash/console。
- 页面响应头：`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。不要加 CSP 阻断同源 fetch。
- token 只在内存；提交后变量置空。浏览器历史里可能留下带 token 的 303 前 URL；这是已知风险，靠 DSH 303 到干净目录 + 运维限制历史访问降低。

参考实现（可原样放进 `deploy/login/index.html`）：

~~~html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>DSH 登录</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100dvh;display:grid;place-items:center;background:#0b1020;color:#e8ecf8}
  main{width:min(92vw,360px);padding:24px;border-radius:16px;background:#151b30}
  h1{font-size:18px;margin:0 0 16px}
  input,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;border-radius:10px;border:1px solid #334;background:#0e1428;color:inherit}
  button{margin-top:12px;background:#3b82f6;border-color:#3b82f6;font-weight:600}
  p{min-height:1.5em;margin:12px 0 0;color:#fca5a5;font-size:14px}
</style>
<main>
  <h1>DSH 内网登录</h1>
  <form id="f">
    <input id="t" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="粘贴启动 token" required>
    <button>登录</button>
  </form>
  <p id="e" role="alert"></p>
</main>
<script>
const f = document.getElementById('f');
const t = document.getElementById('t');
const e = document.getElementById('e');
f.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const token = t.value.trim();
  t.value = '';
  if (!token) return;
  e.textContent = '';
  try {
    const res = await fetch('/?token=' + encodeURIComponent(token), {
      credentials: 'same-origin', cache: 'no-store'
    });
    if (res.status === 401) { e.textContent = 'token 无效或已过期'; return; }
    if (!res.ok) throw new Error('login failed');
    location.replace('/');
  } catch (_) {
    // 兜底：同源 iframe 导航，等它落 cookie 后再进应用
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = '/?token=' + encodeURIComponent(token);
    frame.onload = () => location.replace('/');
    document.body.appendChild(frame);
    setTimeout(() => { e.textContent = 'token 无效或已过期'; }, 8000);
  }
});
</script>
~~~

### 6.4 Caddy 侧的两条硬规则

1. **补 Secure**：DSH 只在**接收请求的监听器自身提供 TLS**时给 cookie 加 `Secure`；`--public-url` 与 `X-Forwarded-Proto` 都不参与（S，`@deepseek-ai/dsh-client-connection@0.2.2-rc.5` 的 `browser-auth` 与 README）。本拓扑 DSH 是 HTTP，所以必须由 Caddy 补。Caddyfile 用 `header >Set-Cookie (.*) "§1; Secure;"`；该规则只在 `handle` 的 DSH 分支生效，不污染登录页。
2. **token 不进日志**：Caddy `log_skip @token` 跳过 `?token=` 请求；DSH 自己仍会把带 token 的启动 URL 打到 stdout，容器日志必须限制访问（见 §14.3）。

### 6.5 撤销与未来 SSO

- 单设备撤销：清浏览器 cookie；90 天后自然过期。
- 全部撤销：删除 `$DSH_HOME/.credentials.yaml` 里 `client-connection/browser-session` 记录并重启 DSH（S）。这会同时轮换 cookie 签名密钥；所有设备重新用启动 token。
- token 撤销：重启 DSH（token 是进程级）。
- 企业 SSO 接缝：Caddy `forward_auth` 指向企业认证服务，v1 不启用；预留稳定 hostname、`/auth/*`、独立 cookie 命名空间、每设备身份位。不要 patch DSH 的认证层。

### 6.6 401 行为

| 场景 | 期望 |
|---|---|
| 无 cookie 打开 `/` | Caddy 302 `/login/` |
| cookie 过期/无效打开 `/` | Caddy 把 DSH 的 401 转成 302 `/login/`（只在 `GET /` 且无 token query） |
| 无 cookie 调 `/api/*` 或 `/api/bridge/*` | 401（不要重定向成 HTML） |
| 登录页 token 错误 | 401，页面显示错误；不跳转 |
| 文件桥上传统 401 | 客户端回登录页，托盘状态保留；重新登录后可继续（上传未完成则重新上传） |
| WebSocket 未认证 | 401/拒绝 upgrade；客户端显示断线并回登录 |

---

## 7. 「发送那一刻」：结论与证据

### 7.1 结论（S）

DSH 0.2.2-rc.5 **没有**一个名为 `beforeSubmit` 的公开回调，但它有一条**官方的、在普通消息提交事务内执行的引用序列化路径**，正好可以作为「发送那一刻」的钩子：

1. 浏览器半在 composer 里插入一枚**引用 chip**（reference chip），来源是插件注册的 `InputTriggerSource`，`ref` 是插件自己的不透明 id。
2. 用户按发送（Enter 或发送键）时，会话输入壳执行 `serializeDraftPrompt(...)`；对每个引用 occurrence 调 `inputTriggers.serializeReference(source, ref, signal)`。
3. 这个调用路由到插件 source 的 `codec.serialize(ref, signal)`；它是 async 的，abort 跟随本次提交；**抛错会阻断发送**，不会静默降级成 chip 的剪贴板文本（S，`@deepseek-ai/dsh-client-ui-conversation@0.2.2-rc.5` 的 `src/client/input/facade.ts`、`src/client/input/prompt.ts`；`@deepseek-ai/dsh-client-ui-input-trigger@0.2.2-rc.5` 的 `src/client/controller.ts` 的 `serializeReference`）。
4. 序列化结果替换掉 chip 的剪贴板投影，成为**这条用户消息正文的一部分**；随后才进入 `defaultSink`（`conversation.sendSession` / `session.prompt`）。
5. 失败时 DSH 保留草稿与附件、在 composer 里显示错误；不会把消息发出去（S）。

所以本规格把「发送时 commit + 路径进消息」落在 `codec.serialize` 上，而不是 `agent.inject`、不是 DOM 启发式、也不是「先写草稿纯文本」。这是对 #5 定版第 6 条、#6 路径注入改判、#10 决议的技术落实；差异见 §16。

### 7.2 关键证据（rc.5，按包列）

| 事实 | 位置（安装包内相对路径） |
|---|---|
| 默认发送路径对每个 reference 调 `serializeReference`；失败 `failSink` | `dsh-client-ui-conversation/src/client/input/facade.ts`（`runDefaultSink` 附近） |
| 引用序列化协议：`codec.serialize(ref, signal)`，失败不许降级 | `dsh-client-ui-conversation/src/client/input/prompt.ts`；`dsh-client-ui-input-trigger/src/types.ts` 的 `ReferenceCodec` |
| source 路由：按 `name` 找 source；缺 source 或缺 codec 直接 reject | `dsh-client-ui-input-trigger/src/client/controller.ts` 的 `serializeReference` |
| 插件可程序化插入 chip：`SessionInput.insertReference(ref, span)`（public face） | `dsh-client-ui-conversation/src/client/contract/input.ts` 的 `SessionInput` / `InputTarget` |
| 通过 `ctx.conversation.input.for(actx)` 取 session facade | 同上的 `SessionInputResolver`；`IConversation.input` |
| 拿 session-scoped `actx`：`ctx.sessions.scope(sessionId)`（借用已保留的 Agent scope） | `dsh-api-session-controller/src/client/contract/sessions.ts` 的 `ISessions.scope` |
| chip 删除可从 `InputState.occurrences` 观察 | `dsh-client-ui-conversation/src/client/contract/input.ts` 的 `InputState.occurrences` / `Occurrence` |
| composer 槽位：`conversation.input.right`（发送键前）、`conversation.input.dock`（composer 卡上方全宽） | `dsh-client-ui-conversation/src/client/skeleton/InputBar.tsx`；`src/client/contract/slots.ts` |
| draft 持久化保留 reference 的 source/ref/label/appearance/clipboardText | `dsh-client-ui-conversation/src/client/contract/draft-editor.ts` 的 `DraftSnapshot` / `DraftReference` |

> 这组事实的逐行证据、行号与最小代码骨架见研究笔记 [rc5-composer-send-hook.md](https://github.com/Ar1-s/dsh_dev/blob/research/rc5-composer-send-hook/research/rc5-composer-send-hook.md)（分支 `research/rc5-composer-send-hook`）。本规格只记录结论与接口，不复制笔记全文。

### 7.3 为什么不用另外三条路

| 备选 | 为什么不选 |
|---|---|
| `agent.inject`（#5/#6/#10 早期写法） | 它是 host 侧向会话上下文注入一段内容，**不绑定到某一条用户消息**，也没有「发送这一条时执行」的事务边界；无法可靠保证「这条消息带这个路径」，也无法在注入失败时阻断发送。v1 不用。 |
| 把路径直接写进草稿纯文本（#5 的 `?paths=draft`） | 输入框会挤、路径会重复显示、撤 chip 与文本要双写；更关键的是用户可能编辑/删除文本导致路径与文件不一致。原型已判为不算数。 |
| 客户端 DOM 启发式（监听 Enter/发送按钮） | 依赖 DSH 内部 DOM、IME、命令模式、移动键盘；脆弱且无法在 rc.5 升级后保证。仅在 reference codec 不可用时才作为最后退路（本规格不采用）。 |
| 请 DSH 加回调 | 正确但 v1 不想等；reference codec 已是官方扩展点，先用它。若未来 DSH 提供 `beforeSubmit`，可迁移，接口语义相同。 |

### 7.4 生命周期（规范）

~~~text
选择文件
  -> 上传到 inbox/.pending/<requestId>（XHR，字节级进度）
  -> 成功后插入 reference chip（source=filebridge, ref=sessionId|requestId）
  -> 用户继续编辑；chip 只是草稿里的一个原子节点
  -> 用户按发送
       -> DSH 调 codec.serialize(ref, signal)
       -> 客户端 POST /api/bridge/commit {sessionId, requestId}
       -> host: pending -> 最终路径；写 manifest；返回 path
       -> 客户端返回 '@' + path
       -> DSH 把它拼进这条消息正文，再调 session.prompt
  -> 发送成功：草稿清空，chip 消失（文件已 committed，不再删）
  -> 发送失败：草稿保留，chip 仍在；重试 commit 幂等
  -> 发送前用户删 chip：occurrence 消失 -> POST /api/bridge/delete -> 只删 pending
~~~

状态机（客户端每个上传项）：

`queued -> uploading -> uploaded -> chipped`；失败分支 `failed -> retrying -> uploading` 或 `failed(no-retry)`；取消 `uploading -> canceled`（清 pending）；已 `chipped` 后撤 chip -> `removed`（只删 pending）。已 committed 的项不再回到 pending。

### 7.5 失败语义（必须照做）

- `codec.serialize` 抛错 => 发送被阻断；composer 显示错误；草稿与 chip 保留。不要 catch 后返回文件名的剪贴板文本（那是静默降级，禁止）。
- `codec.serialize` **不得返回空串**：rc.5 把空串当成功并清空草稿，但一条消息都不发（S）。commit 失败只能 throw。
- 网络错误/5xx => 客户端可重试 commit（同 requestId 幂等）；重试期间不要清 chip。
- 404/410（pending 不存在/已过期）=> 显示「文件已过期，请移除 chip 重新上传」；不要伪造路径。
- 401 => 回登录页；草稿与 chip 保留；登录后重试发送。
- 413/415 => 上传阶段就拒绝；不要进入 chip。
- 409（commit 发现已 committed 到别的 session）=> 拒绝并提示；不覆盖。
- abort（用户取消发送/切换会话）=> 客户端终止请求；host 若已 rename 则保持 committed（幂等）；下一次同 requestId 返回同一路径。

---

## 8. 手机端交互规格

### 8.1 入口与上限

composer 右侧 `+` 按钮（slot `conversation.input.right`，列表项，session scope），点开底部 action sheet：**2×2 网格**：

| 入口 | input 属性 | 行为 |
|---|---|---|
| 拍照 | `accept="image/*" capture="environment"` | 单张；iOS 直接进相机，Android 按系统相机/选择器 |
| 相册 | `accept="image/*" multiple` | 多选；iOS 可能给 HEIC，服务端转 JPEG |
| 录像 | `accept="video/*" capture="environment"` | 单段；≤60 s |
| 文件 | `accept="*/*" multiple` | 任意文件；走系统文件选择器 |

校验（客户端，服务端复核大小）：

- 照片 ≤20 MB；视频 ≤200 MB 且时长 ≤60 s；其他 ≤200 MB。
- 单批 ≤10；队列并发 1；无断点续传；失败重传整文件。
- 视频时长用 `HTMLVideoElement` 的 `loadedmetadata` 读；读不到（部分 MOV）时提示「无法读取时长，仍可上传」，不阻断。
- 空文件（0 字节）拒绝；文件名净化后为空用 `upload`。
- 单文件超过限制时在 action sheet 内提示，不进入上传队列。

### 8.2 上传与托盘

- 选择即上传，没有确认页。
- 上传走 `XMLHttpRequest`（fetch 没有上传进度）：`POST api/bridge/upload?sessionId=&device=&name=&kind=`；header `X-Request-Id`；`Content-Type: application/octet-stream`；`xhr.upload.onprogress` 更新已传字节。
- 托盘渲染在 `conversation.input.dock`（composer 卡上方、全宽、session scope 的 `list`），order 50；每项 64px 高：缩略图/图标、文件名、大小、进度条、已传字节与百分比、取消/移除/重试。**不显示剩余时间**。
- 进度文案：`已传 1.43 / 3.40 MB · 42%`；首次进度前用不定态。
- 网络/超时/5xx：先 `GET api/bridge/uploads?sessionId=&requestId=` 对账；若 pending/committed 则视为成功；否则退避重试 2 次（1 s、3 s + 抖动）。4xx 不重试。
- 401：跳 `/login/`，托盘状态保留，重登后可继续。
- 413/415：该项标记失败，给出原因，不重试；用户可移除。
- 取消：`xhr.abort()`，再 `POST api/bridge/delete`；若已 committed 返回 409，忽略。
- 页面刷新/切后台：上传状态丢失（与 #3 一致，不上 SW、不做后台）；已完成的 pending 由 24 h 懒清理兜底。
- 上传成功后：从托盘移除该项，插入 chip；不保留「本次成功列表」（与 #5 定版一致）。

### 8.3 chip 的插入

chip 不是普通附件，也不是 DSH 原生附件；它是 **reference chip**。插入接口在 rc.5 是公开 face（S）：

~~~js
// 组件里拿到 session 与 inputActions（DSH slot 标准 props）
const sessions = ctx.get('sessions');          // 客户端 sessions 服务
const scope = sessions.scope(session.sessionId); // 已保留的 Agent scope
const input = ctx.get('conversation').input.for(scope);
const span = inputActions.captureInsertion();  // {start,end,draftRev}，detect 坐标
const ok = input.insertReference({
  source: 'filebridge',
  ref: 'fb1|' + session.sessionId + '|' + requestId,
  label: displayName,                          // 文件名，截断 60
  appearance: 'file',
  clipboardText: displayName,                  // 草稿投影；必须非空、不要以 / 开头
}, span);
~~~

规范：

- `source` 固定 `filebridge`；`ref` 形如 `fb1|<sessionId>|<requestId>`，两段都不许含 `|`；requestId 是 UUID。
- `label` 是原始文件名（净化后），`appearance: 'file'`；`clipboardText` 用文件名（不带路径），不使用 `[附件]` 前缀。它必须**非空**且与草稿投影一致：rc.5 的恢复逻辑用它重建草稿，空值会导致整份草稿被丢。
- 插入点用 `captureInsertion()`（detect 坐标；chip 在 detect 文本里占 1 个 U+FFFC，不是剪贴板长度）；不抢焦点、不把光标移到文末。
- 若 `phase !== 'plain'` 或 span CAS 失败：保留待插入状态，等下一次 `useInput` 变为 `plain` 重试（最多 5 次）；仍失败则在托盘显示「点此插入」，用户手动触发。
- 同一文件只插一次；重复点击/重试要按 requestId 去重。
- 切换 session 后上传完成：把结果记在发起 session 名下，等该 session 的 composer 再次挂载时插入；不要插到当前另一个 session。
- 页面刷新后草稿里的 chip 由 DSH 的 draft 持久化恢复；托盘可空，但 chip 仍可发送/删除。不要因为托盘没有记录就清掉 chip。
- **source 名永不变更**：持久化 chip 只记 `source: 'filebridge'`；插件卸载、改名或未加载时，恢复的 chip 会找不到 codec，从而永久阻断该 session 发送。升级必须保留 source 名；可选实现一个兜底 source 返回可读文本，但 v1 不允许静默丢 chip。

### 8.4 发送时 commit

reference source 的 codec（浏览器半，root scope 注册一次）：

~~~js
const source = {
  trigger: '@',
  name: 'filebridge',
  showGroupTitle: false,
  async candidates() { return []; },   // 不提供 @ 菜单候选，只做 chip 的序列化 owner
  onPick() { return undefined; },
  codec: {
    clipboardText() { return '📎'; },  // rc.5 未见对 chip 的调用；保持稳定短形
    async serialize(ref, signal) {
      const [tag, sessionId, requestId] = ref.split('|');
      if (tag !== 'fb1' || !sessionId || !requestId) throw new Error('invalid file-bridge ref');
      // 自加超时：DSH 不会给 codec 设超时；卡住会把 composer 永久留在 sending
      // 15 s 自超时；AbortSignal.any 不可用时用 AbortController 手动合并
      const timeout = AbortSignal.timeout(15000);
      const combined = AbortSignal.any
        ? AbortSignal.any([signal, timeout])
        : mergeSignals(signal, timeout);
      const res = await fetch('api/bridge/commit', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, requestId }),
        signal: combined,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        throw new Error((data && data.error && data.error.message) || '文件提交失败');
      }
      committedRefs.add(ref);       // 供撤 chip 判断：已提交的 ref 不再删 pending
      return '@' + data.path;       // 消息正文里的 workspace 相对路径 mention
    },
  },
};
ctx.effect(() => ctx.inputTriggers.registerSource(source), 'file-bridge: reference source');
~~~

规范：

- `serialize` 必须 async、支持 `signal`；commit 的 abort 跟随发送取消；另外必须有 15 s 自超时（DSH 没有 timeout）。
- 返回值是 `'@' + path`；`path` 是 workspace 相对路径（不带前导 `/`），所以消息里是合法的 DSH 文件引用。**不得返回空串**：rc.5 会把空串当成功、清空草稿但不发消息（S）；commit 失败必须 throw。
- 若目标浏览器没有 `AbortSignal.any`，用 `AbortController` 手动合并 `signal` 与 15 s timer；不要退化成只用 `signal`（超时会失效）。
- 多 chip 时 DSH 会并发调用每个 occurrence 的 `serialize`；每个 commit 独立、幂等。任一失败则整条发送失败（S）。
- commit 成功但发送失败：文件已 committed，不回滚；重发会再调一次 commit，返回同一路径（幂等）。客户端不得在失败路径上 delete 已 committed 文件。
- 不要在 `serialize` 里改草稿、不要 `setDraft`、不要发第二条消息、不要调 `agent.inject`。
- **slash 命令组合限制**：rc.5 的 command claim 走自己的 `submit(args)`，草稿参数不经过 reference codec（研究已核）。因此 v1 不允许「带 file chip 的 slash 命令」：检测到 `phase === 'claimed'` 或草稿以 `/` 开头且含 filebridge chip 时，用 `ctx.conversation.blocks` 把该 session 的 composer 置为不可发送并提示「命令消息不支持文件 chip，请先发送或移除」；移除 chip 或删掉命令前缀后释放。+ 按钮在 claimed/submitting 阶段禁用。

### 8.5 撤 chip

- 托盘/组件订阅 `useInput`，同时跟踪 `occurrences`、`phase`、`draft`。
- **不能只凭 occurrence 消失判断用户删除**：发送成功清空草稿也会让 occurrence 消失。实现必须叠加：
  1. `serialize` 成功时把 `ref` 记进 `committedRefs`（内存 Set）；该集合里的 ref 消失 => 发送成功/已提交，不删 pending。
  2. `phase` 从 `sending` 回到 `plain` 且草稿清空，且 ref 在 committedRefs => 同上。
  3. 其余情况（`phase === 'plain'` 且 ref 消失）=> 用户删除，500 ms debounce 后 `POST api/bridge/delete {sessionId, requestId}`。
- 删除只删 `inbox/.pending/<requestId>` 与 metadata；不写 manifest、不产生最终文件、不删已 committed 文件。
- 若 delete 返回 409 `already-committed`：忽略（发送已成功或正在 commit）；不重试。
- 若 chip 被撤销后又 undo：pending 可能已删；重新发送会在 `serialize` 收到 410，按 §7.5 提示移除 chip 重传。这是可接受的边界，不为此保留 pending。
- 页面卸载/断网导致 delete 未发出：pending 由 24 h 清理兜底；不会自动变成最终文件。

### 8.6 只有附件也能发

- chip 的 `clipboardText` 是文件名，非空，所以「只有 chip、没有用户文字」时发送键可用。
- 发送后消息正文只有路径 mention（一个或多个 `'@' + path`）；ui-reference 会把它渲染成文件 chip；agent 看到路径。
- 不需要伪造成「附件卡片」；见 §16 的偏差说明。

### 8.7 工作区浏览与下载

- 不新造文件浏览器：复用 DSH Web 右栏 Files 树/预览；手机窄屏是树/内容二选一，v1 接受。
- 下载复用 DSH 现有 `fileActions.save`：≤32 MiB（`workspaceFiles.readBytes`）/≤50 MiB（`/api/file`）可用；>50 MiB 明确提示「v1 不支持」，不承诺无限。
- 中文名/二进制/iOS 落点（Files/Photos/分享）列入真机验收；若 blob 下载在 iOS 不理想，用「新标签打开」兜底。
- 插件不重做预览/编辑器；只保证上传成功后的 chip 可点、可预览（依赖 ui-reference 的 `'@' + path` 渲染）。

### 8.8 登录与 401

- 手机打开 `/`：无 cookie -> Caddy 302 `/login/`；不是 DSH 的纯文本 401。
- 登录页行为见 §6.3；token 不落 localStorage/sessionStorage。
- PWA 安装可选；iOS 若 PWA 与 Safari 的 cookie jar 隔离，v1 接受留在 Safari 标签页使用。
- 任何 API/上传/commit 收到 401：回登录页；草稿、托盘、chip 尽量保留；重新登录后重试。

### 8.9 手机 UI 与可访问性

- v1 接受 DSH Web 的「桌面缩窄」：无安全区、键盘按 layout viewport、390px 中栏 <400px 是现状；插件只补自己的 sheet/tray/chip 的安全区与键盘避让，不改整体聊天壳。
- 所有 fixed 浮层 portal 到 `document.body`；sheet 底部留 `env(safe-area-inset-bottom)`；390px 无横向溢出。
- tray/chip 触摸目标 ≥44px；上传中/失败状态有 `aria-live` 文案；取消/移除/重试可键盘聚焦。
- 输入框聚焦时键盘不遮挡 chip/tray（至少不遮挡发送键）；`visualViewport` 变化时调整 sheet 高度。
- 不注册 Service Worker；不做 Share Target、后台上传、断点续传。

### 8.10 明确不做的交互

- 选完先确认后上传的确认页。
- 服务端上传历史/删除/重命名 UI（工作区文件由用户/agent 手动删）。
- 上传完成即注入上下文 / 上传即写最终路径。
- 「本次成功列表」跨刷新保留。
- 上传后自动触发 agent 或 watcher。
- 视频转码/转写/关键帧。
- >50 MiB 的流式下载入口。

---

## 9. 文件桥：协议与目录契约

### 9.1 路由总表

宿主半用 `ctx.connection.fetch.register` 注册**精确 Fetch 路由**。路由 path 必须写成包含 `/api` 前缀的绝对路径（S，`@deepseek-ai/dsh-client-connection@0.2.2-rc.5` 的 `ConnectionFetchRoute` 与 `@deepseek-ai/dsh-client-file-upload@0.2.2-rc.5` 的 `FILE_UPLOAD_PATH` 示例）；浏览器用**文档相对 URL** `api/bridge/...`（不带前导 `/`），以兼容未来挂载前缀。

| 方法 | Host 注册 path | 浏览器相对 URL | requestBody | 用途 |
|---|---|---|---|---|
| GET | `/api/bridge/capabilities` | `api/bridge/capabilities` | buffered | 能力/上限 |
| POST | `/api/bridge/upload` | `api/bridge/upload` | streaming | 流式上传到 pending |
| POST | `/api/bridge/commit` | `api/bridge/commit` | buffered | 发送时提交 |
| POST | `/api/bridge/delete` | `api/bridge/delete` | buffered | 撤 chip 删 pending |
| GET | `/api/bridge/uploads` | `api/bridge/uploads` | buffered | 对账（resultUnknown） |

**为什么 delete 是 POST 不是 DELETE**：rc.5 的 `ConnectionFetchMethod` 只允许 GET、HEAD、POST 三种方法（S）；精确路由不支持 DELETE。不要用裸 `webServer.register` 绕开，那会变成未认证路由。

**鉴权**：精确 Fetch 路由位于已认证的 `/api` 载体内，只有 owner Peer 能到达（S，`@deepseek-ai/dsh-client-connection@0.2.2-rc.5` 的 `rpc.ts` 与 README）。handler **不需要**再调 `connection.admit`；这是 #10 措辞的修正：`connection.admit` 是给裸 `webServer` 路由的，不是 exact fetch 路由的。若实现改用裸路由，必须自己 `connection.admit`，且本规格不允许。

所有响应是 JSON（上传成功也是 JSON），`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`。统一错误形：

~~~json
{ "ok": false, "error": { "code": "upload/too-large", "message": "视频超过 200 MiB" } }
~~~

### 9.2 `POST /api/bridge/upload`

请求：

~~~http
POST /api/bridge/upload?sessionId=<sessionId>&device=phone-a1b2c3d4&name=report.pdf&kind=file
Content-Type: application/octet-stream
X-Request-Id: 5f0c2b7e-9d4a-4c1e-8f3a-2b6d9e0c1a44
Content-Length: 123456
~~~

参数：

| 字段 | 必填 | 规则 |
|---|---|---|
| `sessionId` | 是 | 必须是当前 live Agent 的 session；`ctx.agents.get(sessionId)` 存在；`session.header.cwd` 规范化后必须等于 `/data/workspaces/main`，否则 403 |
| `device` | 是 | 见 §9.6 的 `phone-[0-9a-f]{8}`；客户端生成并存 localStorage |
| `name` | 是 | 原始文件名，URL 编码；≤200 字符；服务端净化 |
| `kind` | 否 | `photo`/`video`/`file`；缺省按 MIME 推断 |
| `X-Request-Id` | 是 | UUID（或 8–64 个 `[A-Za-z0-9_-]`）；同一 id 幂等 |

处理步骤（规范性）：

1. 校验 session/workspace/device/name/kind；不通过则 4xx，**不创建任何文件**。
2. 生成 pending 元数据：`{requestId, sessionId, cwd, device, kind, originalName, receivedAt, sourceMime, ...}`。
3. 流式写 `inbox/.pending/<requestId>.part`；同时 `crypto.createHash('sha256')`；**不整文件进内存**；收到 `request.signal` abort 时删除 `.part`。
4. 超过上限（照片 20 MiB / 视频或文件 200 MiB）立即 413，删除 `.part`；不要先落盘再检查。
5. 写完 `fsync` 文件；按 magic bytes 嗅探 MIME（不信任 Content-Type；表见 §9.8）。
6. 若是 HEIC/HEIF：解码并转 JPEG（§9.9），得到最终 pending 载荷与最终 sha256/mime；原 HEIC 不保留（调试开关除外）。
7. 把 `.part` 原子 rename 为 `inbox/.pending/<requestId>.<ext>`（带最终扩展名）；`fsync` 该目录。
8. 写 `inbox/.pending/<requestId>.json`（0600），内容含请求结果。
9. 写/更新 `inbox/_meta/requests/<requestId>.json`，状态 `uploaded`（保留 7 天）。
10. 返回 201（重试同 id 返回 200）与结果。

响应：

~~~json
{
  "ok": true,
  "requestId": "5f0c2b7e-9d4a-4c1e-8f3a-2b6d9e0c1a44",
  "sessionId": "session-123",
  "device": "phone-a1b2c3d4",
  "pendingPath": "inbox/.pending/5f0c2b7e-...jpg",
  "name": "IMG_0001.HEIC",
  "bytes": 3145728,
  "sha256": "9f2c...",
  "mime": "image/jpeg",
  "sourceMime": "image/heic",
  "converted": true
}
~~~

幂等：

- 同 `X-Request-Id` 且已完成：返回原结果（200），不重复写。
- 同 id 正在上传：409 `upload/in-progress`。
- 同 id 但 `Content-Length`/kind/name 不同：409 `upload/request-id-conflict`。
- 崩溃留下 `.part`：重试同 id 允许截断重写；不同 id 的旧 `.part` 由 24 h 清理。

错误码（至少）：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `upload/bad-request` | 缺参、device/name 非法、kind 非法 |
| 401 | `auth/unauthorized` | 未认证（载体层） |
| 403 | `upload/session-forbidden` | session 不存在/不是 owner/workspace 不是 v1 根 |
| 409 | `upload/in-progress` / `upload/request-id-conflict` | 同 id 并发/参数冲突 |
| 413 | `upload/too-large` | 照片 >20 MiB，视频/文件 >200 MiB |
| 415 | `upload/unsupported` | MIME/HEIC 解码/内容不可处理 |
| 507 | `upload/no-space` | 磁盘满/配额错误 |
| 500 | `upload/internal` | 未预期异常（不要泄漏路径） |

### 9.3 `POST /api/bridge/commit`

请求：

~~~json
{ "sessionId": "session-123", "requestId": "5f0c2b7e-..." }
~~~

服务端步骤：

1. 校验 `sessionId`/`requestId` 格式；读 `inbox/.pending/<requestId>.json`。
2. 不存在：
   - 若 `_meta/requests/<requestId>.json` 已是 `committed`：返回原结果（200，幂等）。
   - 否则 410 `commit/pending-gone`。
3. 校验 metadata.sessionId 与请求一致；不一致 403 `commit/session-mismatch`。
4. 计算最终目录 `inbox/YYYY/MM/DD/<device>/`（UTC 日期，取**提交时刻**）；`mkdir -p`。
5. 计算最终文件名（§9.6）；若已存在则加 `-2`/`-3`，**绝不覆盖**。
6. `fsync` pending 文件；先把 `_meta/requests/<requestId>.json` 改为 `committing` 并写入目标 `path`、`fsync`；`rename(pending, final)`（同一文件系统，原子）；`fsync` 目标目录。
7. 追加 manifest 行（`O_APPEND` + `fsync`）；写 `_meta/requests/<requestId>.json` 为 `committed`；删除 pending metadata。
8. 返回 200：

~~~json
{
  "ok": true,
  "requestId": "5f0c2b7e-...",
  "path": "inbox/2026/11/26/phone-a1b2c3d4/20261126T143005Z-3f2a9c1d-report.pdf",
  "absPath": "/data/workspaces/main/inbox/2026/11/26/phone-a1b2c3d4/20261126T143005Z-3f2a9c1d-report.pdf",
  "name": "report.pdf",
  "bytes": 12345,
  "sha256": "3f2a...",
  "mime": "application/pdf",
  "manifest": "inbox/_meta/manifest-2026-11-26.jsonl"
}
~~~

- `path` 必须是 workspace 相对路径、无前导 `/`、无 `..`；客户端返回 `'@' + path`。
- `absPath` 只用于排障，客户端不要依赖。
- 幂等：重复 commit 返回同一 path；不要重复写 manifest。
- 并发：两个并发 commit 同一 requestId，用 `_meta/requests` 的文件锁/原子创建保证只有一个 rename 成功；另一个等结果或返回已 committed。
- 失败：rename 前失败保留 pending；rename 后 manifest 前失败，由启动 sweep 补 `recovered`（§9.7）。

### 9.4 `POST /api/bridge/delete`

请求：`{ "sessionId": "...", "requestId": "..." }`。

- 只允许删 pending；payload + metadata + request 记录（状态 `deleted`）一起清理。
- 已 committed：409 `delete/already-committed`，**不删最终文件**。
- 不存在：204（幂等）。
- 成功：204，无 body。
- 不允许按 path 删除；不接受客户端路径。

### 9.5 `GET /api/bridge/capabilities` 与 `GET /api/bridge/uploads`

capabilities：

~~~json
{
  "ok": true,
  "protocol": 1,
  "maxBytes": { "photo": 20971520, "video": 209715200, "file": 209715200 },
  "maxBatch": 10,
  "concurrency": 1,
  "maxNameLength": 200,
  "devicePattern": "^phone-[0-9a-f]{8}$",
  "heic": "server-jpeg",
  "resume": false
}
~~~

uploads 对账：

`GET /api/bridge/uploads?sessionId=<id>&requestId=<uuid>` 返回：

~~~json
{ "ok": true, "state": "absent" }
{ "ok": true, "state": "pending", "bytes": 123, "sha256": "...", "mime": "...", "name": "..." }
{ "ok": true, "state": "committed", "path": "inbox/...", "bytes": 123, "sha256": "...", "mime": "..." }
~~~

- 用于网络错误/超时后的 resultUnknown 对账，避免重复上传。
- 不返回其他 session 的记录；sessionId 不匹配 403。

### 9.6 目录、命名与 manifest

目录树（v1）：

~~~text
/data/workspaces/main/
  inbox/
    _meta/
      manifest-YYYY-MM-DD.jsonl      # 只追加
      requests/<requestId>.json      # 7 天
    .pending/                        # 0700；发送前唯一落点
      <requestId>.part               # 上传中
      <requestId>.<ext>              # 上传完成、未 commit
      <requestId>.json               # 元数据
    .staging/                        # 预留；v1 不用
    YYYY/MM/DD/<device>/             # 逐级 0755
      20261126T143005Z-3f2a9c1d-report.pdf
~~~

最终文件名：

`<UTC时间>-<sha256前8位>-<净化slug>.<ext>`

- UTC 时间：提交时刻，`YYYYMMDDTHHMMSSZ`（例 `20261126T143005Z`）。
- sha8：最终存储字节的 sha256 前 8 位小写十六进制。
- slug：原文件名去扩展名，NFC，控制字符/路径分隔符（`\/:*?"<>|`）替换为 `-`，折叠连续 `-`，去首尾 `-`，≤60 字符；为空用 `upload`。
- ext：优先原扩展名（1–10 位 alnum），否则按最终 MIME 映射（jpg/png/gif/webp/pdf/mp4/mov/zip/bin）；HEIC 转 JPEG 后强制 `.jpg`。
- 冲突：`name` 存在则 `name-2`、`name-3`；不覆盖。
- 原始文件名只进 manifest，不参与最终路径。

manifest 行（`manifest-YYYY-MM-DD.jsonl`，UTF-8，一行一个 JSON，行内不换行）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | number | 1 |
| `id` / `request_id` | string | requestId |
| `received_at` | string | 上传完成时间 ISO8601 UTC |
| `committed_at` | string | 提交时间 ISO8601 UTC |
| `device` | string | `phone-xxxxxxxx` |
| `session_id` | string | 来源 session |
| `path` | string | workspace 相对路径 |
| `original_name` | string | 原始文件名（NFC） |
| `stored_name` | string | 最终文件名 |
| `mime` | string | 存储 MIME |
| `source_mime` | string | 上传声明/嗅探的 MIME |
| `bytes` | number | 存储字节数 |
| `sha256` | string | 存储字节 sha256 |
| `original_bytes` | number? | HEIC 原始字节 |
| `original_sha256` | string? | HEIC 原始 sha256 |
| `converted` | boolean | 是否转换 |
| `duplicate_of` | string? | 相同 sha256 的已有 path，仅审计 |
| `status` | string | `stored` / `recovered`（v1 不写 `removed`） |
| `source` | string | `mobile` |

- 永久保留；只追加；不重写。
- commit 时若已有同 sha256 文件，`duplicate_of` 指向最早那条 path；**不做内容去重**（照常落新文件）。
- 删除文件不删 manifest 行；v1 没有已提交删除 UI。

`_meta/requests/<requestId>.json`：

~~~json
{
  "v": 1,
  "requestId": "5f0c2b7e-...",
  "sessionId": "session-123",
  "device": "phone-a1b2c3d4",
  "kind": "file",
  "status": "uploaded | committing | committed | deleted",
  "originalName": "report.pdf",
  "pendingName": "<requestId>.pdf",
  "bytes": 12345,
  "sha256": "...",
  "mime": "application/pdf",
  "sourceMime": "application/pdf",
  "converted": false,
  "createdAt": "...",
  "updatedAt": "...",
  "path": "inbox/... (committed 时)"
}
~~~

- 保留 7 天；过期清理。
- 用于幂等、对账、崩溃恢复；不是第二份内容索引。

### 9.7 暂存、提交、恢复与清理

> 本节是 #10「文件桥架构与工作区语义」目录契约的**后续修订**：把上传落点从最终目录改为 `inbox/.pending/<requestId>`，发送时才 commit；#10 已关票不重开，实施以本节为准。

- 暂存与最终路径必须在**同一文件系统**（都在 workspace 卷内），否则 rename 不是原子的。
- 上传完成 → `.pending/<requestId>.<ext>`；发送 → rename 到最终目录。中间不存在「先写最终路径再删」的状态。
- 崩溃窗口与恢复（启动 sweep + 每小时一次）：
  1. `requests/<id>` 状态 `uploaded` 且 pending 存在：保留（等用户发送或 24 h 清理）。
  2. 状态 `committing` 且最终 path 存在、manifest 无该 id：追加 `status:"recovered"` 行，状态改 `committed`。
  3. 状态 `committing` 且最终 path 不存在、pending 存在：回 `uploaded`（可重试 commit）。
  4. 状态 `committing` 且两者都不在：标 `failed`，保留 7 天供排障。
  5. 孤儿 pending（无 request 记录）：按 mtime 24 h 清理。
  6. `.part` 超过 24 h：删除。
  7. 最终文件存在但无 manifest、也无 request 记录：**不自动删**；启动日志 warning，人工处理。
- 清理策略：
  - `.pending/` 未提交：24 h（懒清理 + 启动 sweep）。
  - `_meta/requests/`：7 天。
  - manifest：永久。
  - 最终文件：永久（v1 无自动清理/配额；运维监控）。
- 所有目录/文件属主 1000:1000；`inbox/` 0755，`_meta/` 0755，`.pending/` 0700，pending 文件 0600，最终文件 0644。

### 9.8 安全规则

- 只写 `<workspace>/inbox/`；不接受客户端路径；最终路径由服务端生成。
- 拒绝（400 `upload/bad-name`）：
  - 原始名（NFC 后、basename）等于 `AGENTS.md` / `CLAUDE.md`（大小写不敏感）、`.git`、`.dsh`、`..`、`.`。
  - 含 `/`、`\`、NUL、其他控制字符、路径分隔符、Windows 保留名（`CON`、`NUL` 等）。
  - 净化后为空或 `.`/`..`。
- 不跟随 symlink：目标目录用 `realpath` 校验必须位于 workspace 的 `inbox/` 下；写文件用 `O_CREAT|O_EXCL`（冲突改名）或临时名 + rename；不允许覆盖。
- 不写 `attachments/v1`；不修改 `.gitignore`（部署文档提示用户加 `/inbox/`）。
- MIME 嗅探优先于扩展名/Content-Type；HTML/SVG 不特殊处理（不执行、不内联预览；由 DSH 文件树决定）。
- 精确 Fetch 路由只对 owner Peer 开放；不要注册裸 `webServer` 路由。不要接受 `Authorization` 头 token。
- 单用户内网边界：DSH 的 read 是宿主级、write 受 cwd 限制；文件桥只写 `inbox/`；接受 `read-any`，不做 workspace 白名单（#10 Q4 A）。不承诺多用户隔离。
- 日志不打印原始字节/完整 token；错误信息不回显绝对路径（客户端只拿相对 path）。


MIME 嗅探表（magic bytes，按顺序匹配；不信任 Content-Type）：

| 类型 | 判据 |
|---|---|
| JPEG | 起始 FF D8 FF |
| PNG | 起始 89 50 4E 47 |
| GIF | 起始 47 49 46 38 |
| WebP | RIFF 开头，偏移 8 处为 WEBP |
| HEIC/HEIF | ftyp box 的 brand 为 heic / heix / hevc / mif1 / msf1 |
| PDF | 起始 %PDF- |
| ZIP/Office | 起始 PK 03 04 |
| MP4/MOV | ftyp box 的 brand 为 isom / mp42 / qt（两个空格） |
| 其他 | application/octet-stream |


### 9.9 HEIC/HEIF 与 MOV

- 嗅探：`ftyp` box 的 brand 为 `heic`/`heix`/`hevc`/`mif1`/`msf1` => HEIC/HEIF。
- 转换：服务端用纯 JS/WASM 的 `heic-convert`（或等价的 `libheif-js` 封装）转 JPEG，质量 0.9；长边超过 4096 时等比缩到 4096（控制 agent 读图成本）；转换后字节必须 ≤20 MiB，否则 413。
- **原 HEIC 不保留**（#10 决议）；manifest 记 `source_mime: "image/heic"`、`converted: true`、`original_bytes`/`original_sha256`。
- 转换失败：415 `upload/heic-decode`；不要让 agent 拿到不可读的 HEIC。
- MOV/其他视频：原样保存，不转码；MIME 嗅探为 `video/quicktime` 时扩展名 `.mov`。
- 依赖必须**构建期**装进 profile（例如 `heic-convert@2.x` 精确版本），运行期不装；若选择 `sharp`，必须确认 libvips 带 HEIF 读能力并锁定平台包；v1 推荐 `heic-convert` 以减少原生依赖。未在目标 Linux 实测的部分列入 §14。

---

## 10. 插件包与代码结构

### 10.1 包身份

| 项 | 值 |
|---|---|
| 包名 | `@local/dsh-file-bridge` |
| 版本 | `0.1.0`（仅追踪；镜像 tag 才是钉） |
| cordis 行 id | `file-bridge` |
| client bundle 的 `load id` | **必须等于包名** `'@local/dsh-file-bridge'` |
| 源码 | 本仓 `plugins/dsh-file-bridge/` |
| 形态 | 单包双半：宿主半 + 浏览器半；零构建纯 JS |
| 安装 | 镜像构建期 `dsh plugin --profile web add file:/opt/plugins/dsh-file-bridge --save-exact` |

### 10.2 最小清单（四件套）

~~~text
plugins/dsh-file-bridge/
  package.json
  cordis.patch.yml
  index.js          # 宿主半
  client.js         # 浏览器半（classic script）
~~~

`package.json`：

~~~json
{
  "name": "@local/dsh-file-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js"
  },
  "files": [
    "index.js",
    "client.js",
    "cordis.patch.yml"
  ],
  "dependencies": {
    "heic-convert": "<精确版本>"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-input-trigger",
        "@deepseek-ai/dsh-client-ui-renderer"
      ]
    }
  }
}
~~~

- `dsh.bundle.patch` 指向本包的 patch 文件；`dsh.plugin add` 后该包进入 profile 的 `dsh.profile.bundles`。
- 有 `dsh.client` 就**必须**有 `exports["./client"]`（S）；否则 client-modules 在启动时抛错。
- `files` 必须含 `client.js`；漏了会装不进去（#14）。
- `dsh.client.inject` 的包名确保 slot/服务先到；运行时服务通过 `ctx.get/ctx.inject`，没有权限白名单（S）。
- 依赖只允许构建期装进 profile；运行期不跑 pnpm。`heic-convert` 选纯 JS/WASM 版本；若引入原生模块，必须锁定平台包并在 Linux 构建机验证。

`cordis.patch.yml`：

~~~yaml
- insert:
    - id: file-bridge
      name: '@local/dsh-file-bridge'
~~~

- 行 id 唯一即可；不要 `disabled`；不要抢 index fallback。
- 如果未来需要改 `connection` 行，走 `--patch` overlay，不在插件 patch 里改别人的行。

### 10.3 宿主半 `index.js`

职责：注册路由、写文件、维护 manifest、确保 workspace/目录、启动 sweep；不渲染 UI。

结构建议：

~~~js
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import heicConvert from 'heic-convert'

export const name = '@local/dsh-file-bridge'
export const inject = ['connection', 'agents']

export async function apply(ctx) {
  // 1) 解析/校验工作区；失败只 warning，不抛（避免带崩 DSH）
  const root = '/data/workspaces/main'
  const registry = ctx.get('workspaceRegistry')
  try {
    const existing = await registry?.resolveByPath(root)
    if (existing === undefined) await registry?.create(root, 'main')
  } catch (error) {
    ctx.logger?.('file-bridge').warn('workspace ensure failed: %s', error)
  }

  // 2) 目录初始化（entrypoint 已做；插件再兜底，幂等）
  await mkdir(join(root, 'inbox', '.pending'), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'inbox', '_meta', 'requests'), { recursive: true, mode: 0o755 })

  // 3) 注册精确路由；全部在 ctx.effect 里，fiber 释放自动注销
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/bridge/upload', methods: ['POST'], requestBody: 'streaming',
    fetch: request => handleUpload(ctx, root, request),
  }), 'file-bridge: upload')
  // commit / delete / capabilities / uploads 同理（requestBody: 'buffered'）

  // 4) 启动 sweep + 每小时 sweep；用 ctx.setInterval 并随 fiber 释放
  ctx.setInterval(() => { void sweep(root).catch(error => log(error)) }, 3600_000)
}

async function handleUpload(ctx, root, request) {
  try {
    // 1. 校验 session/device/name/kind
    // 2. 流式写 .part + sha256；超限 413；abort 清理
    // 3. 嗅探 MIME；HEIC 转 JPEG
    // 4. fsync + rename 到 .pending/<id>.<ext>
    // 5. 写 .json + _meta/requests/<id>.json
    // 6. 返回 JSON
  } catch (error) {
    log(error)
    return json(500, { ok: false, error: { code: 'upload/internal', message: 'upload failed' } })
  }
}
~~~

实现约束：

- `apply` 顶层 try/catch；任何 handler 都必须 catch 并返回统一 JSON 500；不允许未捕获 rejection（会退出进程）。
- 不要在 import 期做 I/O；不要在 `apply` 里 fire-and-forget 没有 catch 的 Promise。
- 用 `ctx.effect` 注册 disposer；不要自己管理全局单例。
- session 解析：`ctx.agents.get(sessionId)?.session.header.cwd`；不存在或 cwd 不是 `/data/workspaces/main` -> 403。不要信任查询参数里的路径。
- 文件写：流式 + sha256 + `fsync`；rename 前不要先创建最终目录里的同名文件。
- 日志：`ctx.logger('file-bridge')` 或 console 前缀；不打印 token/完整字节。

### 10.4 浏览器半 `client.js`

形态：classic script，模块加载器注册；工厂里用 `require('react')` / `require('react-dom')`；不要打包 React。

~~~js
window.__ModuleLoader__.load({
  id: '@local/dsh-file-bridge',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { createElement: h, useEffect, useRef, useState } = React

    function apply(ctx) {
      const store = createUploadStore() // 模块内单例，按 session 分组

      // 1) reference source（只做 chip 序列化 owner；不提供 @ 菜单候选）
      const source = { /* 见 §8.4 */ }
      ctx.effect(() => ctx.inputTriggers.registerSource(source), 'file-bridge: source')

      // 2) + 按钮
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: '@local/dsh-file-bridge/plus',
        order: 50,
      }, PlusButton))

      // 3) 托盘
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: '@local/dsh-file-bridge/tray',
        order: 50,
      }, Tray))
    }

    return { apply, inject: ['slots', 'sessions', 'conversation', 'inputTriggers'] }
  },
})
~~~

约束：

- action sheet 用 `createPortal` 到 `document.body`；不要塞进 composer 卡（会被 overflow/transform 裁剪）。
- 运行时 `require` 只有平台 seed 与已到达的 boot 行（S）；不要 require 未声明的包。需要图标/按钮样式时用内联样式或自建 SVG，不依赖 primitives。
- 组件只通过标准 slot props 拿 session/inputActions/useInput；root ctx 用于服务解析（`ctx.sessions.scope`、`ctx.conversation.input.for`、`ctx.conversation.blocks`）。
- 不要把上传状态放在 React 局部 state 里（切 session/重渲染会丢）；用模块级 store + `useSyncExternalStore` 或订阅。
- 不要修改 DSH 的 DOM 结构；只渲染自己的 slot 内容与 portal。

### 10.5 失败隔离

- 宿主半：`apply`/handler 全 try/catch；返回 JSON 错误；不抛到顶层；不 fire-and-forget。
- 浏览器半：bundle 必须能被 client-modules 解析；`load id` = 包名；`exports["./client"]` 存在；文件缺失/畸形会让整机启动失败（S）。构建期必须真实起一次 DSH，并从 index 提取包含 `@local/dsh-file-bridge/client.js` 的批量 URL（rc.5 形如 `plugins/??@local/…/client.js&rev=<hash>`）发 GET 200；直接 `/plugins/<pkg>/client.js` 在 rc.5 是 404，不是正确断言。
- 容器：`restart: unless-stopped`；healthcheck 接受 401；entrypoint 断言两个插件；构建期冒烟。
- 明确接受：插件 bug 与 DSH 同生共死；v1 不做进程隔离（#14）。

### 10.6 模板与约定（实施件）

实施票应先落：

- `plugins/_template/`：四件套 + 冒烟脚本，供后续双端插件复用。
- `plugins/CONVENTIONS.md`：
  - 不用 `webServer.register` / `registerFallback`；只用 `connection.fetch`。
  - `files` 含 `client.js`；`load id` = 包名；`exports["./client"]` = 客户端入口。
  - 不打包 React；host 半优先只 import `node:` 或纯 JS 依赖。
  - 双端插件 = 宿主半 + 浏览器半，经同源 HTTP 通信，不共享内存。
  - 构建期必须过 `%TSD-Header-` 扫描与 client bundle 200 冒烟。
- 模板不是共享运行时库；不要把业务逻辑塞进模板。

## 11. 工作区、卷、迁移与运维

### 11.1 工作区

- v1 固定 `/data/workspaces/main`；插件启动时 `ctx.workspaceRegistry.resolveByPath(root)`，不存在则 `create(root, 'main')`（S，`@deepseek-ai/dsh-workspace@0.2.2-rc.5` 的 `resolveByPath`/`create`）；失败只 warning，操作员可在 Web 里手动注册。
- 会话创建时把 cwd 写进不可变 `SessionHeader.cwd`（S）。因此**容器内路径不可变**：换宿主机路径可以，换容器挂载路径会让旧会话掉出 workspace。
- 文件桥只接受 cwd 等于 v1 根的 session；其他 workspace 的 session 上传返回 403。未来多 workspace 另开 effort。
- 工作区被 agent 用于读写；inbox 是普通子目录。不要给 inbox 单独建 workspace。

### 11.2 卷与权限

| 卷 | 容器路径 | 内容 | 权限 |
|---|---|---|---|
| `dsh-home` | `/data/dsh-home` | sessions、attachments、storages、logs、profiles、`.credentials.yaml` | 1000:1000；根 0755；凭据 0600 |
| `dsh-workspace` | `/data/workspaces/main` | 项目文件 + `inbox/` | 1000:1000；inbox 0755；pending 0700 |
| `caddy-data` | `/data` | Caddy internal CA、证书 | Caddy 用户；必须备份 |
| `caddy-config` | `/config` | Caddy 配置缓存 | Caddy 用户 |

- 非 root uid/gid 1000；entrypoint 以 root 初始化根目录后 drop；不递归 chown 用户文件。
- named volume 推荐；bind mount 必须保证主机目录 1000:1000，否则 entrypoint 只改根目录，子目录仍不可写。
- 根文件系统只读；`/tmp` exec tmpfs；HOME 指向 `/data/dsh-home`。
- `.credentials.yaml` 只存 cookie 签名密钥（以及操作员选择保存的凭据）；0600，必须备份/保护；不要进镜像。
- `attachments/v1` 无 GC；卷增长是运维责任（#8）。

### 11.3 升级

- 手动触发，挑维护窗口；不跟随 npm latest。
- 构建新镜像 tag：`<DSH版本>-<git短rev>`；OCI revision label = 构建 commit。
- staging：同一 compose + 卷快照副本（或 staging 主机），跑 §12 的装配/登录/上传/下载冒烟；通过后再切。
- 升级前后各打一次整卷快照（`dsh-home` + `dsh-workspace` + `caddy-data`）。
- 本地保留最近 3 个镜像 tag；旧 tag 不删。
- profile seed 指纹变化会触发 profiles 备份并替换；旧 profiles 保留最近 3 份；替换时保留用户 `cordis.patch.yml`，所以插件启停状态跨镜像升级保留。
- 零版本豁免；升级前若临时加过豁免，升级后重评并清空。
- 不承诺 DSH 降级后的数据兼容：session 格式只向前、旧 build 遇到更高格式会拒绝；credentials 只认 `version: 1`。

### 11.4 回滚

- 回滚 = 上一个镜像 tag + 升级前整卷快照；不是只换 tag。
- 回滚后跑同一套冒烟；确认两插件都在、登录可用、上传可用、旧文件/会话在。
- 回滚不恢复已提交的新文件（在快照之后产生的）；需要的话从备份单独取。

### 11.5 备份与恢复

- 落点：宿主机 `/srv/dsh/backups`（或加密对象存储）；不要放容器卷里。
- 频率：每日增量 + 每周全量；保留 7 日 + 4 周；升级前额外全量。
- 内容：`dsh-home`、`dsh-workspace`、`caddy-data`；`.credentials.yaml` 含密钥，备份必须加密/限权。
- 参考命令（在宿主机执行）：

~~~sh
ts=$(date -u +%Y%m%dT%H%M%SZ)
docker run --rm \
  -v dsh-intranet_dsh-home:/src/home:ro \
  -v dsh-intranet_dsh-workspace:/src/ws:ro \
  -v dsh-intranet_caddy-data:/src/caddy:ro \
  -v /srv/dsh/backups:/dst \
  alpine:3.20 sh -c "cd /src && tar czf /dst/dsh-${ts}.tgz home ws caddy"
~~~

- 恢复演练：每季度在 staging 主机恢复一次，验证登录、旧会话、inbox 文件、manifest 可读；不演练等于没备份。
- Caddy `/data` 丢失 = 新根 CA = 所有手机重新装根证书；单独强调。
- 磁盘监控：卷使用率 80% 告警；inbox 无自动配额（v1），manifest 永久增长可接受但需监控。

### 11.6 日志与可观测性

- 容器日志 json-file，10 MB × 5；不集中收集也可以，但必须限制访问（含 token）。
- Caddy access log 跳过 `?token=`；DSH stdout 仍会打印启动 URL，按 §14.3 管理。
- 关键事件日志：启动两插件、workspace ensure、sweep 结果、上传拒绝原因、commit 失败、manifest 追加失败。
- 不记录文件字节、完整 token、cookie。

---

## 12. 验收清单

> 每一条都必须有可复现步骤。标注 [桌面] 的可在桌面浏览器/curl 验收；[真机] 的必须 iOS/Android 真机；[运维] 的是部署/备份演练。

### A. 装配与部署

- [ ] [桌面] 镜像构建成功；`%TSD-Header-` 扫描通过；`--dump-config` 输出包含 `@local/dsh-laser-report` 与 `@local/dsh-file-bridge` 两个 row，无 `skipping`/`did not activate`/`startup failed`。
- [ ] [桌面] 启动日志出现 `dsh web:`；未认证 `GET /` 返回 401（或 Caddy 302 到登录页）。
- [ ] [桌面] 从 index 提取包含 `@local/dsh-file-bridge/client.js` 的批量 URL（rc.5 形如 `plugins/??…client.js&rev=<hash>`），GET 返回 200；直接 `/plugins/<pkg>/client.js` 404 属预期。`load id` 等于包名。
- [ ] [桌面] DSH 端口未发布；Caddy 是唯一 80/443 入口；`docker compose ps` 只有一个对外服务。
- [ ] [桌面] profile seed 指纹刷新：改镜像 tag 重建后，`$DSH_HOME/profiles/web` 被替换且旧目录留下最多 3 份 bak；两插件仍加载。
- [ ] [桌面] `profiles/web/package.json` 两个本地插件均为精确版本，无 `^`/`~`；`compatibility.json` 为空。

### B. 认证与登录

- [ ] [桌面] 无 cookie 打开 `https://dsh.lan/` -> 302 `/login/`，不是 DSH 纯文本 401。
- [ ] [桌面] 登录页粘贴错误 token -> 401 + 页面错误提示；不跳转。
- [ ] [桌面] 正确 token -> 303 + `Set-Cookie`；cookie 含 `HttpOnly`、`SameSite=Strict`、`Path=/`、`Secure`；无 `Domain`（host-only）。
- [ ] [桌面] 登录后刷新仍登录；`/api/*` 与 WebSocket 可用；WebSocket 101；SSE 有增量。
- [ ] [桌面] token 不在 localStorage/sessionStorage；Caddy 访问日志无 `?token=`；DSH 启动日志访问受控。
- [ ] [桌面] 重启 DSH 容器：旧 cookie 仍有效；重启后新 token 能登录新设备。
- [ ] [桌面] 删除 `client-connection/browser-session` 凭据并重启：所有旧 cookie 失效；新 token 可登录。
- [ ] [真机] iOS Safari 与 Android Chrome 各完成一次 token 登录；iOS 若装 PWA，确认 PWA 内 cookie 落盘（或按 §6.3 fallback）。

### C. 文件桥协议

- [ ] [桌面] 未认证 `POST /api/bridge/upload` -> 401，`inbox/` 无新文件。
- [ ] [桌面] `GET /api/bridge/capabilities` 返回 protocol 1、上限、devicePattern、heic。
- [ ] [桌面] 上传一张 JPEG：返回 pendingPath；`inbox/.pending/<id>.*` 存在；`inbox/YYYY/...` 无文件；manifest 无新行。
- [ ] [桌面] 上传 200 MB 级视频：不 413（业务上限内）；流式写入，进程内存不随文件线性上涨。
- [ ] [桌面] 照片 >20 MB -> 413 `upload/too-large`；`.part` 被清理；无 pending。
- [ ] [桌面] 伪造 `name=../../etc/passwd`、`name=AGENTS.md`、`name=CLAUDE.md`、`device=../x` -> 400；不落盘。
- [ ] [桌面] 同 `X-Request-Id` 重试已完成上传 -> 返回原结果（200），不重复写。
- [ ] [桌面] 上传中断/网络错误 -> `GET /uploads` 对账返回 pending/committed/absent；客户端据此不重复上传。
- [ ] [桌面] commit：`POST /api/bridge/commit` -> 200；最终文件存在、pending 消失、manifest 追加一行；再 commit 同 id -> 同一 path，manifest 不重复。
- [ ] [桌面] commit 后 `path` 是 workspace 相对路径；消息里的 `@` + path 可被 ui-reference 渲染/预览。
- [ ] [桌面] `POST /api/bridge/delete` 对 pending -> 204，pending 与 metadata 消失，manifest 无行；对已 committed -> 409，最终文件仍在。
- [ ] [桌面] 崩溃恢复：手工制造 `committing` + 最终文件存在 + manifest 缺失，重启后 sweep 补 `recovered` 行；不重复。
- [ ] [桌面] 24 h 清理：把 pending mtime 改到 25 h 前，sweep 后删除；committed 文件不受影响。
- [ ] [桌面] HEIC 上传 -> 最终为 `.jpg`，`mime=image/jpeg`，manifest `source_mime=image/heic`、`converted=true`、原 HEIC 不保留。
- [ ] [桌面] MOV 上传 -> 原样 `.mov`，`mime=video/quicktime`，不转码。
- [ ] [桌面] 500/507 路径返回 JSON 错误；客户端显示可读文案；不回显绝对路径。

### D. 手机交互与发送

- [ ] [真机] `+` 打开 2×2 action sheet；拍照/相册/录像/文件四个入口都能拉起系统选择器；iOS `<input>` 不用 `display:none` 导致点不动。
- [ ] [真机] 选择即上传；托盘显示字节级进度、无 ETA；并发 1；单批 10；可取消/移除/重试；4xx 不重试。
- [ ] [真机] 上传成功后 composer 出现 chip（文件名+大小+移除）；输入框不出现路径文本。
- [ ] [真机] 发送时 chip 提交：消息正文含 `@inbox/...`；agent 同一轮读到 path/size/mime；工作区出现最终文件。
- [ ] [真机] 只有 chip、没有文字也能发送；消息只有路径 mention。
- [ ] [真机] 发送前撤 chip：pending 消失；工作区无最终文件；manifest 无行。
- [ ] [真机] 发送失败（断网/服务重启）：草稿与 chip 保留；错误提示；恢复后重试成功且不重复文件。
- [ ] [真机] 页面刷新后 chip 仍在（draft 持久化），可再次发送/删除。
- [ ] [真机] 切换 session 后上传完成，chip 插回发起 session，不插到另一个 session。
- [ ] [真机] slash 命令 + file chip：composer 被 block 并提示（或按 §8.4 的限制处理），不会静默丢路径。
- [ ] [真机] 390px 宽无横向溢出；键盘不遮挡发送键；sheet 适配 safe-area；上传中/失败有 aria-live。
- [ ] [真机] iOS 从相册选 HEIC + 从相机录 MOV；Android 从文件选择器选 PDF/大视频；各成功一次。

### E. 工作区浏览与下载

- [ ] [真机] 右栏 Files 树可浏览 `/data/workspaces/main`；inbox 当日/设备目录可见。
- [ ] [真机] 下载 PDF/图片到手机；iOS 落到 Files/Photos 或分享；中文名可用。
- [ ] [真机] ≤32 MiB（readBytes）与 ≤50 MiB（/api/file）各成功一次；>50 MiB 给出明确「v1 不支持」提示。
- [ ] [真机] 已发送消息里的 `@inbox/...` 文件 chip 可点开预览（依赖 ui-reference）。

### F. 打包、升级、回滚

- [ ] [运维] 构建期真实起一次 DSH：`dsh web:` 行、`GET /` 401、两插件 row、批量 client bundle URL 200、杀进程；脚本非零退出即失败。
- [ ] [运维] install-scripts：4 个 native 包已 approve/rebuild，`koffi`/`node-pty`/`subprocess-local` 可加载且 PTY 可用；不能只看 npm warning。
- [ ] [运维] 升级演练：新镜像 tag + staging 卷副本跑完 A–E 冒烟；切 tag 后旧会话/旧文件/旧 cookie 可用。
- [ ] [运维] 回滚演练：上一 tag + 升级前快照恢复；两插件在、上传可用、数据一致。
- [ ] [运维] 备份恢复演练：从 `/srv/dsh/backups` 恢复到 staging；登录、会话、inbox、manifest 可读。
- [ ] [运维] Caddy `/data` 备份；模拟丢失后用备份恢复，手机无需重装根证书。
- [ ] [运维] 卷使用率 80% 告警生效；日志轮转生效；token 日志访问受限。

### G. 安全

- [ ] [桌面] 只注册了 `/api/bridge/*` 精确路由；没有裸 `webServer.register`/`registerFallback`（代码审查 + `--dump-config`）。
- [ ] [桌面] 不接受客户端路径；symlink/path traversal/控制名/NUL 全部拒绝；最终路径由服务端生成。
- [ ] [桌面] 不写 `attachments/v1`；不修改 `.gitignore`。
- [ ] [桌面] 文件/目录属主 1000；`.pending` 0700；`inbox` 0755；`.credentials.yaml` 0600。
- [ ] [桌面] 无 BasicAuth/forward_auth；`/login/` 是唯一未认证静态页；`/bridge/authz` 不存在。
- [ ] [真机] 手机不信任 CA 时浏览器报错；装根证书（iOS 完全信任）后正常；HTTP/3 未启用。

---

## 13. 实施顺序与移交

### 13.1 里程碑

| 里程碑 | 交付 | 验收 |
|---|---|---|
| M0 | 本规格 + 研究笔记 + 原型链接 | 维护者复核；地图 #1 更新 |
| M1 | 镜像骨架 + Caddy + `/login/` + 空白 web profile + 卷/entrypoint；本机 Docker 先跑通 | §12 A、B；能登录、会话可用、无文件桥 |
| M2 | 文件桥宿主半：capabilities/upload/commit/delete/uploads + manifest + sweep | §12 C（除 UI）；curl 全绿 |
| M3 | 文件桥浏览器半：+ 面板/托盘/chip/source codec + 桌面浏览器 | §12 C 剩余 + D 桌面部分 |
| M4 | 手机真机：iOS/Android 四入口、HEIC/MOV、下载、窄屏 | §12 D、E 真机 |
| M5 | 升级/回滚/备份演练 | §12 F |
| M6 | 加固：Caddy Set-Cookie 复测、HEIC 依赖、安全扫描、日志/监控 | §12 G + §14 关闭项 |

### 13.2 票拆分建议

- 实施票 1：服务器镜像与 Caddy/登录（M1）。
- 实施票 2：文件桥宿主半与目录契约（M2）。
- 实施票 3：文件桥浏览器半与发送时 commit（M3）。
- 实施票 4：手机真机与下载验收（M4）。
- 实施票 5：升级/回滚/备份与构建流水线（M5）。
- 实施票 6：安全与观测加固（M6）。

每张实施票必须引用本规格的章节号与 §12 的条目；验收证据（截图/curl/日志）贴回票。

### 13.3 地图收尾

#12 关闭后：

- 地图 #1 的 **Decisions so far** 追加本规格的指针与一句话结论。
- 地图的 **Not yet specified** 中与本规格相关的项（备份/观测/配对/真机/Linux 冒烟）要么已被本规格决定，要么转为后续 effort/实施票；不要留在雾里。
- 地图可关闭：目的地（可实施规格）已交付；实现是新的 effort，不占 wayfinder 的 decision ticket。

---

## 14. 风险与未验证项

### 14.1 按严重度排序

| # | 风险 | 影响 | 缓解 | 状态 |
|---|---|---|---|---|
| R1 | rc.5 的 reference codec 是扩展点但不是稳定性承诺；升级可能改签名/调用时机 | 发送时 commit 失效 | 钉 rc.5；升级前跑 §12 D 的发送用例；关注 facade/controller 变更 | U（静态已核，未跨版本） |
| R2 | 程序化插入 chip 依赖 `sessions.scope` + `conversation.input.for`；session 未 retained 会抛 | chip 插不进 | M3 先做 spike；失败时退回手动插入；不退回草稿纯文本 | U |
| R3 | occurrence 无法区分「用户删 chip」与「发送成功清空」 | 误删已提交文件 | committedRefs + phase/sending→plain + 409 already-committed；§8.5 | D（需实测） |
| R4 | `clipboardText` 为空/与草稿投影不一致会让刷新丢整份草稿 | 草稿丢失 | 插入时用非空文件名；恢复测试；不要用空串 | S + U |
| R5 | source 改名/插件卸载后，持久化 chip 永久阻断发送 | session 卡死 | source 名冻结为 `filebridge`；升级保留；可选兜底 source | D |
| R6 | codec 无 timeout，commit 卡住会把 composer 永久留在 sending | 无法再发消息 | 客户端 15 s AbortSignal；失败保留草稿 | S + D |
| R7 | command claim 不走 codec | slash 命令丢路径 | §8.4 用 `conversation.blocks` 阻止带 chip 的命令；验收覆盖 | S + D |
| R8 | 多 chip 并发 commit，部分成功、发送失败不回滚 | 工作区留下已提交文件 | 幂等重试；manifest 记录；失败提示；v1 接受 | D |
| R9 | HEIC 解码依赖在目标 Linux 未实测 | HEIC 上传失败 | 构建期装、M2 单测；失败 415；iOS 通常已转 JPEG | U |
| R10 | Caddy `header >Set-Cookie` 正则替换/多 Set-Cookie 行为未在目标版本实测 | cookie 无 Secure 或被破坏 | 目标 Caddy 2.11 实测；只发一个 cookie；升级复测 | U |
| R11 | iOS PWA 与 Safari cookie jar 隔离；fetch 303 后 cookie 落盘 | 登录失败 | iframe fallback；Safari 标签页兜底；真机验收 | U |
| R12 | iOS 下载落点/中文名/二进制 | 下载体验差 | 新标签兜底；真机验收 | U |
| R13 | DSH Web 手机布局（安全区/键盘/390px） | 体验差 | 插件只修自己的 composer 区域；接受桌面缩窄；Q3 B 后续 | S |
| R14 | token 出现在 DSH stdout/浏览器历史 | 凭据泄露 | 限制日志访问；Caddy log_skip；重启换 token；不用 localStorage | S |
| R15 | 插件与 DSH 同进程，未捕获异常/崩溃带崩整机 | 会话中断 | apply/handler try/catch；restart；healthcheck；构建冒烟 | S |
| R16 | workspace 自动注册失败 | 上传 403 | 手动在 Web 注册；entrypoint 预建目录；日志 warning | D |
| R17 | 内部 CA/HTTP3/根证书丢失 | 手机全部重装 | 不发布 UDP/443；备份 caddy-data；文档 | S |
| R18 | `@path` 的预览/渲染依赖 ui-reference | 消息里只显示文本 | 路径仍可读；ui-reference 是默认组合的一部分；不阻断 | S |
| R19 | 服务端无法验证视频时长 | 60 s 限制可被绕过 | 客户端检查；服务端只管大小；验收用真机 | D |
| R20 | 备份/恢复未演练 | 回滚失败 | 季度演练；升级前快照 | D |
| R21 | `--patch`/`--dump-config` 参数顺序与 profile 可写在目标镜像未实测 | 启动失败 | M1 构建冒烟；失败即阻断 | U |
| R22 | named volume 初始化属主/seed 在非 root entrypoint 下行为 | 目录不可写 | entrypoint 只 chown 根；M1 冒烟；bind mount 文档 | U |
| R23 | 200 MB 文件 + HEIC 转换的内存/CPU | OOM | 流式写；HEIC 只对 ≤20 MB 照片；转换串行；M2 压测 | D |
| R24 | requestId/sessionId 含竖线时 ref 解析失败 | 发送失败 | 生成时校验；ref 编码/转义；单测 | D |
| R25 | exact fetch route 路径必须含 `/api` 前缀；挂载前缀未支持 | 路由 404 | 固定根路径；浏览器相对 URL；v1 不做子路径挂载 | S |
| R26 | 插件日志/错误泄露绝对路径 | 信息泄露 | 客户端只返回相对 path；错误统一文案 | D |
| R27 | 文件桥 v1 只支持一个 workspace | 多 workspace 403 | 明确写入范围；后续 effort | D |
| R28 | DSH 降级不兼容 | 回滚后数据不可用 | 不承诺；回滚用快照；保留旧 tag | S |

### 14.2 必须在 M1–M3 关掉的 spike

1. **M3 spike**：在 rc.5 上真实加载一个最小双端插件，验证：
   - `sessions.scope(sessionId)` + `conversation.input.for(scope).insertReference` 能插入 chip；
   - 发送时 `codec.serialize` 被调用、抛错阻断、成功返回 `'@' + path`；
   - 删除 chip 后 occurrences 变化，`conversation.blocks` 能阻止 slash + chip。
   通过标准：桌面浏览器手动走通一次；失败则按 §7.3 的备选重新评估（不要静默降级）。
2. **M2 spike**：HEIC 样本（iPhone 原图）在目标 Linux 容器里转 JPEG；记录 CPU/内存/耗时；失败则改浏览器侧转换或换解码库。
3. **M1 spike**：Caddy `header >Set-Cookie` 在目标 2.11 上给 303 响应补 Secure；用 curl -i 验证。
4. **M1 spike**：entrypoint 的 `--patch`/`--dump-config`/seed 刷新/权限在目标 Docker 上跑通。

### 14.3 token 日志的具体处置

- DSH 启动 URL 会带 token（S）；`printUrl: false` 会连操作员也拿不到 token，所以 v1 保持打印。
- 访问限制：只有运维账号能 `docker logs`/journal；容器日志轮转；不要把启动 URL 发群/截图。
- 怀疑泄露：重启 DSH（换 token）+ 删除 `client-connection/browser-session`（撤销所有 cookie）。
- Caddy 侧只保证 access log 不落 token；DSH 自身日志仍可能被 Docker 保存，这是接受的风险。

---

## 15. 明确不做

与 §1.3 一致，另列容易误入的：

- 不做 sidecar 上传服务；不做 Caddy `forward_auth`；不做 `/bridge/authz`。
- 不做裸 `webServer.register` 上传路由；不做客户端路径参数。
- 不做 DSH 原生附件库（`attachments/v1`）中转；不写附件库。
- 不做「上传即最终路径 + 撤 chip 再删文件」；不做 manifest 重写。
- 不做多用户/账号/租户/公网/原生 App/移动壳/SSO。
- 不做 >50 MiB 下载流式路由；不做视频转码/转写。
- 不做 Service Worker/Share Target/后台上传/断点续传。
- 不做已提交文件的服务端删除 UI；不做上传历史。
- 不做 DSH 本体 patch；不依赖内部 `$events` 协议。
- 不做多 workspace 上传；v1 固定 `/data/workspaces/main`。

---

## 16. 决策修正与已关票偏差

本规格在合拢时做了以下**有意的修正**；实施以本规格为准，已关票只作为背景。

| # | 早期说法 | 本规格 | 原因 |
|---|---|---|---|
| 1 | #5/#6/#10：发送时用 Host `agent.inject` 注入路径 | 发送时由 reference codec 把 `'@' + path` 放进这条消息 | 不绑定单条消息、无提交事务边界；codec 是官方提交路径且失败阻断（§7） |
| 2 | #5：输入框只放 chip，路径由 Host 注入 | 输入框只放 chip；路径在发送时序列化进消息正文 | 同一交互目标；消息里以文件 chip 渲染 |
| 3 | #10：`POST /bridge/upload`、`DELETE /bridge/upload` | `POST /api/bridge/upload`、`POST /api/bridge/delete` | exact fetch route 在 `/api` 下；rc.5 只支持 GET/HEAD/POST |
| 4 | #14：`/bridge/upload` 走 `connection.fetch`；handler 再 `connection.admit` | 路由仍在 `/api/bridge`；exact route 已由 `/api` 载体认证，handler 不再 admit | exact fetch 路由只对 owner Peer 开放（S） |
| 5 | #7：DSH 绑 127.0.0.1:3080 | DSH 绑容器自身 IPv4:3080，不发布端口 | 兼容 Compose 网络；避免共享 netns；cwd/路径不变 |
| 6 | #4 早期：HEIC 原文件保留 + JPEG 派生 | 只保留 JPEG；原 HEIC 不保留 | #10 后续决议；减少工作区噪音与存储 |
| 7 | #5：已发送气泡里的附件卡片 | 消息正文 `'@' + path`，由 ui-reference 渲染成文件 chip | 不改 DSH 消息 renderer；路径可读/可点 |
| 8 | #5：托盘在输入框上方（卡内） | 托盘在 `conversation.input.dock`（composer 卡上方全宽） | 不改 DSH 的 `conversation.input.attachments` single slot；官方 list 更稳 |
| 9 | #6 Q4 A：路径以纯文本写进草稿 | chip + 发送时序列化 | 原型二轮已改判；本规格落实 |
| 10 | #5：撤 chip 静默删工作区文件 | 撤 chip 只删 `.pending` | 采用 #5 最终选定的 pending→commit 形态；已提交文件不删 |
| 11 | #7：v1 只装一个插件 | 两个双端插件（激光 + 文件桥） | #14 补丁 |
| 12 | #2/#6：30 天 cookie | 90 天（`cookieMaxAgeDays: 90`） | #6 拍板；auth research 支持 |
| 13 | #10：永久保留、不做删除 | 最终文件永久；pending 24 h 清理；无已提交删除 UI | pending→commit 后的自然结果 |
| 14 | #12 自身：「发送钩子未核实，可能退化」 | 已核实 reference codec；无需退化方案 | 研究笔记 `rc5-composer-send-hook` |

---

## 17. 证据与链接

### 17.1 票与地图

- 地图：[#1 DSH 内网服务器与手机客户端 v1](https://github.com/Ar1-s/dsh_dev/issues/1)
- 范围与验收：[#4](https://github.com/Ar1-s/dsh_dev/issues/4)、[#6](https://github.com/Ar1-s/dsh_dev/issues/6)
- 服务器：[#7](https://github.com/Ar1-s/dsh_dev/issues/7)、[#9](https://github.com/Ar1-s/dsh_dev/issues/9)、[#11](https://github.com/Ar1-s/dsh_dev/issues/11)
- 文件：[#8](https://github.com/Ar1-s/dsh_dev/issues/8)、[#10](https://github.com/Ar1-s/dsh_dev/issues/10)、[#14](https://github.com/Ar1-s/dsh_dev/issues/14)
- 认证：[#2](https://github.com/Ar1-s/dsh_dev/issues/2)
- 手机能力：[#3](https://github.com/Ar1-s/dsh_dev/issues/3)
- 原型：[#5](https://github.com/Ar1-s/dsh_dev/issues/5)
- 参考架构：[#13](https://github.com/Ar1-s/dsh_dev/issues/13)

### 17.2 研究笔记（分支 + 文件）

- [intranet-https-auth](https://github.com/Ar1-s/dsh_dev/blob/research/intranet-https-auth/research/intranet-https-auth.md)：Caddy/HTTPS/cookie/Secure。
- [mobile-pwa-capture](https://github.com/Ar1-s/dsh_dev/blob/research/mobile-pwa-capture/research/mobile-pwa-capture.md)：四入口、无 SW、HEIC/MOV。
- [dsh-file-model](https://github.com/Ar1-s/dsh_dev/blob/research/dsh-file-model/research/dsh-file-model.md)：workspace 注册表、附件库、inbox。
- [plugin-headless](https://github.com/Ar1-s/dsh_dev/blob/research/plugin-headless/research/plugin-headless.md)：web profile、插件故障。
- [dsh-web-container](https://github.com/Ar1-s/dsh_dev/blob/research/dsh-web-container/research/dsh-web-container.md)：npm 薄镜像 + Caddy。
- [pinning-upgrade](https://github.com/Ar1-s/dsh_dev/blob/research/pinning-upgrade/research/pinning-upgrade.md)：钉住/seed/回滚。
- [mobile-dsh-client](https://github.com/Ar1-s/dsh_dev/blob/research/mobile-dsh-client/research/mobile-dsh-client.md)：插件槽位/连接/下载。
- [dsh-auth-modes](https://github.com/Ar1-s/dsh_dev/blob/research/dsh-auth-modes/research/dsh-auth-modes.md)：token/cookie/ITP/SSO 接缝。
- [agents-anywhere](https://github.com/Ar1-s/dsh_dev/blob/research/agents-anywhere/research/agents-anywhere.md)：只借鉴，不采用。
- [file-bridge-packaging](https://github.com/Ar1-s/dsh_dev/blob/research/file-bridge-packaging/research/file-bridge-packaging.md)：双端包/加载/失败。
- **[rc5-composer-send-hook](https://github.com/Ar1-s/dsh_dev/blob/research/rc5-composer-send-hook/research/rc5-composer-send-hook.md)**：本规格新增；发送时 codec 的逐行证据、插入路径、装配契约、边界。commit `088aedf`。

### 17.3 原型

- [#5 定版](https://github.com/Ar1-s/dsh_dev/issues/5)：`prototype/mobile-file-bridge` @ `1f453f9`；[index.html](https://github.com/Ar1-s/dsh_dev/blob/prototype/mobile-file-bridge/prototype/mobile-file-bridge/index.html)、[README](https://github.com/Ar1-s/dsh_dev/blob/prototype/mobile-file-bridge/prototype/mobile-file-bridge/README.md)。
- 原型是交互参考，不是实现；托盘位置/已发送气泡的偏差见 §16。

### 17.4 DSH 0.2.2-rc.5 一手材料

安装包内（`app.asar` 的 `dsh/node_modules/@deepseek-ai/...`）：

- `dsh-client-ui-conversation/src/client/input/facade.ts`、`src/client/input/prompt.ts`、`src/client/contract/input.ts`、`src/client/contract/draft-editor.ts`、`src/client/contract/slots.ts`、`src/client/skeleton/InputBar.tsx`。
- `dsh-client-ui-input-trigger/src/types.ts`、`src/client/controller.ts`、`src/client/service.ts`。
- `dsh-client-connection/src/rpc.ts`、`README.zh.md`（exact fetch routes / admit / cookie）。
- `dsh-client-file-upload/src/index.ts`、`src/protocol.ts`（`/api/session/uploadFileBinary` 示例）。
- `dsh-api-session-controller/src/client/contract/sessions.ts`（`scope`/`binding`）。
- `dsh-workspace/src/index.ts`（`resolveByPath`/`create`）。
- `dsh-web-app/cordis.patch.yml`（connection/web-runtime 行）、`README.zh.md`、`dsh/docs/user/guide/public-deployments.zh.md`、`dsh/docs/config-catalog.zh.md`（`cookieMaxAgeDays`）。

### 17.5 证据等级说明

- **S**：本轮直接读源码/文档核对；研究笔记中有行号。
- **D**：本规格的设计取舍；实施票可按 §16 修改，但必须记录原因。
- **U**：未在目标环境验证；M1–M4 的 spike/验收必须关掉，不能口头通过。

---

## 18. 下一步（规格之外）

1. 维护者复核本规格；确认 §16 的 14 条修正没有异议。
2. 立实施票（§13.2），从 M1 开始；每张票引用本规格章节。
3. M3 前完成 reference codec spike；M2 前完成 HEIC Linux spike；M1 前完成 Caddy Secure/entrypoint spike。
4. 目标 Linux 主机 + iOS/Android 真机验收；证据贴回实施票。
5. 全部通过后关闭地图 #1；手机移动壳/多设备/公网/SSO 另开 effort。

---

## 19. 生产 smoke 记录（2026-11-26，隔离测试容器）

> 注意：按 AGENTS.md 的本地优先规则，后续容器构建与调试先在本机 Docker 跑通，再到生产测试机联调；本轮是在规则落档前的例外。

> 目的：在不碰生产容器/服务的前提下，验证 rc.5 能启动、认证可用、90 天补丁与 client bundle 路由。不是完整 M1。

- 宿主：Ubuntu 22.04.5，Docker 29.2.1，20 核 / 31 GiB，/data 738G 可用；现有 4 个容器（postgres_db、node01/02/03）与 8081/18090 两个服务未动。
- 隔离：/data/dsh-test；专用 bridge 网络 dsh-test-net；容器 dsh-test-20261126；仅发布 127.0.0.1:13080->3080；uid 1000；6 GiB/2 CPU/pids 256；no-new-privileges。
- 运行时：node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530（Node 24.22.3）；npm 11.19.1；DSH 0.2.2-rc.5；npm install 671 包；启动日志出现 dsh web:。
- 认证：未认证 GET / = 401；token GET /?token=... = 303 + Set-Cookie；默认 Max-Age=2592000（30 天）；加 --patch connection.yml 后 Max-Age=7776000（90 天）；cookie 有 HttpOnly/SameSite=Strict；带 cookie GET / = 200。
- client bundle：index 用的是**批量** URL plugins/??<pkg>/client.js,...&rev=<hash>；带 rev GET = 200（25,885 B），不带 rev = 404；直接 /plugins/<pkg>/client.js = 404。**规格已据此修正验收断言。**
- npm scripts：npm 11 把 @deepseek-ai/dsh-subprocess-local、koffi、node-pty、protobufjs 的脚本标为 pending；本次 koffi/node-pty/subprocess-local 的 require 仍 OK，但 PTY/终端端到端未验。构建必须显式 approve/rebuild 或做同等冒烟，不能只看 warning。
- 网络：DockerHub 直连不可达；配置的 mirror 首次拉 node 镜像约 8 分钟后成功；Caddy 2.11 镜像拉取 7+ 分钟未完成，已取消；npm registry、nodejs.org 可达；github.com 在本机 curl 超时。
- 未验证：Caddy/TLS/Set-Cookie Secure（镜像拉取超时）、文件桥五条路由（插件未构建）、手机真机、PTY/终端端到端、升级回滚/备份。
- 清理：测试容器、专用网络、node 镜像与 `/data/dsh-test` 已删除；生产 4 个容器未动。

---

## 20. 插件启停管理（2026-11-26 补充）

### 20.1 范围

v1.2 只做**全局**插件启用/禁用：一个 profile，所有客户端看到同一张 Host 插件图。不做 per-user/per-device，不做移动端专用插件表，不做运行时 install/remove。

### 20.2 管理面

- 原生 Web 侧栏「插件」页就是管理界面；它调用 `ctx.pluginManager` 的 `listPlugins` / `listBundles` / `setPluginEnabled` / `setBundleEnabled`，写 `profiles/web/cordis.patch.yml` 与 `dsh.profile.bundles`。
- 如果要独立管理员 API，做一个薄插件：`ctx.inject(['connection','pluginManager'], ...)`，注册 `/api/admin/plugins` 精确 Fetch 路由，只封装 list/toggle；加独立管理员鉴权/审计；不要 import 内部实现。只做启停不需要 pnpm。
- 管理类插件与预设行可能只读（`management-required` / `unaddressable`）；不要试图绕过。

### 20.3 客户端同步

- `dsh-client-hmr` + `dsh-client-modules`：已打开的页面跟随 Host 图；启用加载 client bundle，禁用卸载并回收 slot/样式；客户端不需要安装。
- 同一 release 下不需要刷新页面；没有 HMR、需要 Host 重启或 release 变化时，按 `restart-required` 或刷新页面处理。
- 设置里的插件列表是只读投影；同步失败可在该页重试，不改变 Host 启用状态。

### 20.4 影响面

- 只停/启被点名的插件行（以及 Cordis 服务依赖方）；会话、其他插件、工作区/连接状态保留。
- 被停插件的 UI 会卸载，组件内未保存状态丢失；正在使用该插件的 tool call 可能失败。
- 切换 bundle 会影响该 bundle 的所有行；install/remove 与镜像升级影响更大，放维护窗口。
- 不要在工作时段切换 core/management 插件；leaf UI 插件启停可在工作时段做，但建议窗口。

### 20.5 持久化与升级

- 插件启停写在 `profiles/web/cordis.patch.yml`；entrypoint 的 seed 刷新必须保留/合并这个用户 patch，否则镜像升级后启停状态回到 seed（§5.3 已按此修）。
- `package.json` / `node_modules` 的运行时安装不在 v1；官方插件安装走构建期/CI，客户端自动加载。运行时 install/remove 需要 pnpm 运行时与 profile 作为事实源，另开 effort。

### 20.6 维护窗口

插件表很少变；简单 leaf UI 插件启停可在工作时段做，但建议窗口；bundle install/remove、core/management、DSH 镜像升级必须窗口。变更前备份 profile；变更后按 §12 验证。
