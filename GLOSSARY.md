# DSH 内网服务器与手机客户端

本仓规划「在 x86_64 Linux 内网主机上用 Docker 运行 DSH Web，并给手机端一个 DSH 客户端」的 v1 规格。文中 Host / Client 指 DSH 的宿主进程与浏览器端，不是 Docker 的「主机」，也不是独立客户端 App。

## Language

**宿主半 (host half)**:
插件在 DSH 宿主进程（Node）里的那部分代码，经包主入口 `exports["."]` 与 `cordis.patch.yml` 的一行装配；能写文件、注册工具与路由，但没有界面。
_Avoid_: 服务端, host 服务, 后端

**浏览器半 (client half)**:
插件在 DSH Web 页面里的那部分代码，由 `dsh.client.platform: "web"` 声明、`exports["./client"]` 提供；页面把它当 classic script 加载并注册成 Cordis 插件，只能渲染槽位 UI 与调用宿主提供的同源路由。
_Avoid_: 前端, 客户端（单独使用时）

**双端插件 (dual-half plugin)**:
同一个包名、同一个版本里同时提供宿主半与浏览器半的插件；「一个包」只是打包/发布单位，两侧不共享内存，只经同源 HTTPS 通信。
_Avoid_: 全栈插件, 前后端服务
