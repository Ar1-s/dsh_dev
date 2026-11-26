# 手机浏览器 / PWA 采集与上传能力

> 研究票：#3「手机浏览器/PWA 采集与上传能力」（map #1「DSH 内网服务器与手机上传 v1」）
> 研究时间：2026-11-26。范围：iOS Safari（iOS 26/27 时代）与 Android Chrome 上，采集照片/视频并上传到 DSH 内网 inbox 的浏览器能力。
> 来源口径：只采信一手来源——WebKit 源码/Bugzilla、WebKit/Chrome 官方文档、MDN/浏览器兼容数据（BCD）、WHATWG/W3C 规范、Apple 官方文档。无法确认的写「未证实」，不把二手文章当结论。

## TL;DR

1. **v1 不需要 PWA 安装、不需要 Service Worker、也不需要 getUserMedia。** 一个 HTTPS 页面加三四个 `<input type="file">`（拍照 / 相册 / 录像 / 文件）就能覆盖「手机采集 → 上传 inbox」；`input type=file` 本身不要求安全上下文，但 PWA 安装、`getUserMedia`、Web Share Target 都要求 HTTPS。
2. **iOS 与 Android 的交互形态不同。** iOS 的 `capture` 会跳过系统菜单直接进相机；不带 `capture` 时是系统菜单（Photo Library / Take Photo / Choose File）。Android 的 `capture` 也直接进相机，但不带 `capture` 的新版 Chrome 走 Photo Picker / 系统文件选择器，Android 14 起有「没有相机入口」的现实问题——所以「拍照」和「从相册选」应做成两个按钮。
3. **格式不能假设。** iOS 相机照片会被固定转成 JPEG（0.8，文件名 `image.jpg`）；相册默认走 PHPicker 的 Compatible 表示，HEIC 通常被转成 JPEG，但 Files App、Android、第三方来源仍可能给 HEIC/HEIF。iOS 相机视频是 QuickTime `.mov`，WebKit 还有显式的 `.MOV` 转码路径。服务端必须归一化（HEIC→JPEG、MOV→MP4），不能只看扩展名。
4. **当前最大的坑是 iOS 26.5.x 的 WebKit 回归 [319985](https://bugs.webkit.org/show_bug.cgi?id=319985)：页面被 Service Worker 控制时，`fetch`/XHR 直接发送 `File` 会变成空 body（Content-Length: 0）。** 该 bug 已于 2026-10-10 合入 WebKit main（[323318@main](https://commits.webkit.org/323318@main)），2026-10-17 合入 safari 分支；截至本笔记没有确认进入哪个已发布 iOS。**v1 不上 Service Worker 就能完全绕开**；若上 SW，iOS 端必须把文件读成内存 Blob 再发，大视频会爆内存。
5. **Web Share Target（从相册/微信分享到 PWA）iOS 完全不支持，Android 支持但依赖「已安装的 PWA + Service Worker + POST multipart」，近期还有 Chromium 文件被丢弃的公开 issue。** v1 不做，列为 v1.1 可选项。
6. **后台/断点续传：iOS 没有 Background Sync / Background Fetch，切后台页面会被挂起。** 大文件上传必须前台完成；v1 用「前台分片 + 服务端 offset」即可，进度条用 XHR（`fetch` 没有上传进度事件）。Android 虽有 Background Sync/Fetch，但两者都不适合几十 MB 以上的文件上传。

## 能力矩阵（结论速览）

| 能力 | iOS Safari（iOS 26/27） | Android Chrome | 依据 |
| --- | --- | --- | --- |
| 选择照片/视频（相册） | ✅ 系统菜单 Photo Library | ✅ Photo Picker | [WebKit 布局测试](https://github.com/WebKit/WebKit/blob/main/LayoutTests/fast/forms/ios/file-upload-panel.html) |
| 选择「文件」App / 下载目录里的文件 | ✅ 系统文档选择器（Files） | ✅ 系统文件选择器（SAF） | [WebKit 源码](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm)、[MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file) |
| `capture` 直接调相机（拍照/录像） | ✅ 跳过菜单直接进相机 | ✅ 直接启动系统相机 | [WebKit 源码 L538-552](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm)、[web.dev](https://web.dev/articles/media-capturing-images) |
| 不写 `capture` 时的相机入口 | ✅ 菜单里有 Take Photo/Video | ⚠️ 新版 Photo Picker 可能没有相机入口（未证实官方说明） | [布局测试](https://github.com/WebKit/WebKit/blob/main/LayoutTests/fast/forms/ios/file-upload-panel.html)、[Odoo 修复 PR](https://github.com/odoo/odoo/pull/266395) |
| 相册多选 | ✅ 当前 WebKit 支持（`multiple` → Choose Files） | ✅ | [WebKit 源码 L960-963](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm)、[布局测试](https://github.com/WebKit/WebKit/blob/main/LayoutTests/fast/forms/ios/file-upload-panel.html) |
| 视频采集 | ✅ 输出 QuickTime `.mov` | ✅（容器/编码由相机 App 决定） | [WebKit 源码 L297-304、L1320-1330](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm) |
| `getUserMedia`（页内相机） | ✅ 需 HTTPS；standalone 自 iOS 13.4 起可用 | ✅ 需 HTTPS | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[WebKit bug 185448](https://bugs.webkit.org/show_bug.cgi?id=185448) |
| 安装到主屏（PWA） | ✅ 手动「分享 → 添加到主屏幕」；iOS 26 起任何站点都可作为 Web App | ✅ 菜单安装；满足条件时弹安装提示 | [WebKit Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)、[web.dev 安装条件](https://web.dev/articles/install-criteria) |
| `beforeinstallprompt` | ❌ 无（只能手动安装） | ✅/⚠️ 满足条件才触发；菜单安装不依赖 SW | [web.dev](https://web.dev/articles/install-criteria)、[Chrome 博客](https://developer.chrome.com/blog/update-install-criteria) |
| Web Share Target（文本/URL） | ❌ | ✅（已安装 PWA） | [BCD](https://github.com/mdn/browser-compat-data/blob/main/manifests/webapp/share_target.json)、[Chrome 文档](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target) |
| Web Share Target（文件） | ❌ | ✅/⚠️（需 SW + POST multipart；近期有文件丢失 issue） | [web.dev](https://web.dev/articles/files/receive-shared-files)、[Chromium issue 561685220](https://issues.chromium.org/issues/561685220) |
| Background Sync | ❌ | ✅ Chrome 49+（需 SW） | [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/SyncManager.json)、[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API) |
| Background Fetch | ❌ | ⚠️ Chrome 74+，实验性、偏下载 | [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/BackgroundFetchManager.json)、[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API) |
| 切后台继续上传 | ❌（页面被挂起） | ⚠️ 仅经 SW 的 Background Sync/Fetch，不适合大文件 | 同上 |
| 屏幕常亮 Wake Lock | ⚠️ iOS 16.4+；但在 standalone Web App 中 18.4 才可用 | ✅ | [BCD WakeLock](https://github.com/mdn/browser-compat-data/blob/main/api/WakeLock.json)、[WebKit bug 254545](https://webkit.org/b/254545) |
| 拿到文件真实路径 | ❌（`C:\fakepath\...`） | ❌ | [MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file) |
| HEIC/HEIF 原样上传 | ⚠️ 默认转 JPEG；不能保证 | ⚠️ 可能原样 | [WebKit bug 270470](https://bugs.webkit.org/show_bug.cgi?id=270470)、[WebKit 源码](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm) |
| 几十 MB～百 MB 视频 | ⚠️ 前台、慢、内存敏感 | ✅/⚠️ 前台更稳 | 见 F6/F7 |

## Findings

### F1. 安全上下文：HTTPS 是「相机 / PWA / Share Target」的门槛，不是文件选择器的门槛

- **`getUserMedia()` 只在安全上下文可用。** MDN 明确标注该 API 仅安全上下文（HTTPS）可用；非 HTTPS 下 `navigator.mediaDevices` 为 `undefined`，调用会失败。来源：[MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。
- **安全上下文的判定：** HTTPS、`http://localhost`、`file://` 等「potentially trustworthy」来源算安全；普通 `http://192.168.x.x` 不算。来源：[MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)。这直接意味着：手机通过内网 IP 走 HTTP 打开页面时，`getUserMedia` 不可用；要上 HTTPS（证书信任问题属于 #2「内网 HTTPS 与单令牌认证」）。
- **PWA 安装要求 HTTPS**（Chrome 的安装条件之一），Service Worker 也只在安全上下文注册。来源：[web.dev 安装条件](https://web.dev/articles/install-criteria)、[MDN Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)。
- **`<input type="file">` 不是 secure-context-only 特性**：MDN 的 input/file 页面没有安全上下文限制标注，不需要 HTTPS 也能弹系统选择器。因此「只在 HTTP 内网用文件选择器上传」在规范层面可行，但会同时失去相机 API、PWA 安装和 Share Target；且 iOS/Chrome 对非安全来源的相机行为并不值得依赖。**建议 v1 统一走 HTTPS**，与 #2 对齐。
- 注意混合内容：HTTPS 页面里不能再向 `http://` 上传端点发请求；上传端点必须同源或 HTTPS。

### F2. iOS Safari：菜单、capture、HEIC、MOV、Files App

**F2.1 不带 `capture` 时的系统菜单是固定的，WebKit 有测试用例直接钉死行为。**
[WebKit 布局测试 `file-upload-panel.html`](https://github.com/WebKit/WebKit/blob/main/LayoutTests/fast/forms/ios/file-upload-panel.html) 明确断言：

- `accept=""` / `*/*` → `["Photo Library", "Take Photo or Video", "Choose File"]`
- `accept="image/*"` → `["Photo Library", "Take Photo", "Choose File"]`
- `accept="video/*"` → `["Photo Library", "Take Video", "Choose File"]`
- `accept=".TXT"` / `.PDF` → 只有 `["Choose File"]`
- 加 `multiple` 后按钮名变 `Choose Files`（L76-77）

这解释了为什么 iOS 上一个 `accept="image/*"` 的 input 能同时提供「相册、拍照、文件」三条路；但也意味着用户可以选择非相机来源，**不能把「点了 input」当成「一定走相机」**。

**F2.2 加了 `capture` 就跳过菜单，直接进相机。**
[WebKit 源码](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm) L538-552：从 `parameters->mediaCaptureType()` 拿到 capture 类型；只要 `_shouldMediaCaptureOpenMediaDevice` 为真就直接 `_showCamera`，不再走 `showDocumentPickerMenu`。所以：

- `accept="image/*" capture="environment"` → 直接进后置相机拍照；
- `accept="video/*" capture="environment"` → 直接进录像模式；
- 代价是用户失去「从相册选」的入口。**这就是需要两个按钮的原因。**

**F2.3 相机照片固定变成 JPEG，文件名固定 `image.jpg`。**
[WebKit 源码 L1291-1311](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm)：相机拍照没有 `UIImagePickerControllerImageURL`，回退到 `UIImageJPEGRepresentation(image, 0.8)`，文件名 `image.jpg`，注释里还写着「Should EXIF data be maintained?」。也就是说：

- 照片质量被压到 0.8，EXIF 方向/元数据是否有保证未证实；
- 服务端不能依赖原始文件名做去重/命名，必须自己生成 inbox 文件名；
- 上传大小通常比原图小，但不能据此假设上限。

**F2.4 相册走 PHPicker：支持多选、可能被系统缩小、默认「Compatible」表示（HEIC→JPEG）。**
同文件 L960-963：`selectionLimit = _allowMultipleFiles ? 0 : 1`（0 = 不限），`_setAllowsDownscaling:YES`。L690-704 决定 `preferredAssetRepresentationMode`：默认 `Compatible`，只有宿主（Safari/WKWebView）声明「偏好原图」且 accept 允许时才可能用 `Current`。[WebKit bug 270470](https://bugs.webkit.org/show_bug.cgi?id=270470) 的摘要直接写明：iOS 在 compatible 情况下仍然会 transcode 成 JPEG。结论：

- 相册选 HEIC，**默认会得到 JPEG**（未在本机真机复验，但 WebKit 代码 + bug 说明一致）；
- **不能保证绝对没有 HEIC**：Files App、其他 App 分享、Android 设备仍可能给 HEIC；服务端必须接受 HEIC 并归一化；
- 系统可能先降分辨率/缩图，不要假设拿到的是原图；
- 多选在**当前** WebKit 可用；早期 iOS 版本的多选支持情况未逐一核实，v1 以当前 iOS 26/27 为准即可。

**F2.5 iOS 视频：QuickTime `.mov`，且 WebKit 有显式转码路径。**
同文件 L297-304：当需要转码时，用 `AVAssetExportSession` + `AVAssetExportPresetHighestQuality` 导出 `AVFileTypeQuickTimeMovie`，文件名扩展名用 `UTTypeQuickTimeMovie`（`.MOV`）。L1320-1330：相机/相册视频的 `UIImagePickerControllerMediaURL` 是文件 URL，直接作为 `_WKVideoFileUploadItem`。L1073-1076：PHPicker 结果在非 Compatible 模式下会走 `_uploadMediaItemsTranscodingVideo`。结论：

- iOS 相机视频**很可能**是 `.mov`；相册视频在转码分支会被显式导出为 `.MOV`，Compatible 分支由系统给「兼容表示」，容器不保证一定是 MP4；
- 网页拿不到分辨率/码率/时长控制参数，`capture` 也没有约束能力；
- 服务端必须能解 MOV（ffmpeg 等），不能只按 `.mp4` 处理。

**F2.6 Files App / iCloud / 第三方文件提供方：能选，但拿不到路径，且是 import 副本。**
[WebKit 源码 L882-884](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm)：`UIDocumentPickerViewController`，`UIDocumentPickerModeImport`，`setAllowsMultipleSelection:_allowMultipleFiles`。Apple 对该控制器的定义是「提供访问 app sandbox 之外文档或目的地的视图控制器」：[Apple UIDocumentPickerViewController](https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller)。实践含义：

- iOS 的「Choose File」可以进 Files App（iCloud Drive、On My iPhone、第三方 File Provider），但走的是**导入副本**，不是原地引用；
- 网页只能拿到 `File` 对象，拿不到真实路径；`input.value` 是 `C:\fakepath\...`（[MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file)）；
- 超大视频从 Files App 导入会先复制，耗时和临时空间都要计入风险。

### F3. Android Chrome：capture 直进相机，不带 capture 走系统选择器

- **`capture` 在 Android 上直接启动系统相机，且不再提供「选已有图片」选项。** web.dev 官方文章写得很明确：“on Android this means that the user will no longer have the option of choosing an existing picture. The system camera app will be started directly, instead.” 来源：[web.dev Capture images](https://web.dev/articles/media-capturing-images)。
- **不带 `capture` 时**，Chrome 走系统选择器：图片通常进 Android Photo Picker，其他文件走 Storage Access Framework（SAF）文档选择器；用户可以在系统 UI 里浏览 Downloads 等位置，但网页只拿到副本。路径同样是不可见的（`C:\fakepath\...`，[MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file)）。Android 侧系统选择器的官方说明见 [Android SAF 文档](https://developer.android.com/guide/topics/providers/document-provider)。
- **Android 14 起的现实问题：** 多个项目报告不带 `capture` 的 `<input accept="image/*">` 在 Android Chrome 里不再出现「相机」入口（因为改用了 Photo Picker）。Odoo 的修复 PR 明确写「Since Android 14 we don't have option to take a photo on clicking on file input in Chrome」并为相机单独加了 `capture` 按钮：[odoo/odoo#266395](https://github.com/odoo/odoo/pull/266395)。这不是 Chromium 官方文档的承诺，**标记为未证实官方口径**，但足以支撑「两个按钮」的设计。
- **Android Photo Picker 的可靠性问题（公开 issue，状态未逐一核实）：**
  - [Chromium 586133901](https://issues.chromium.org/issues/586133901)：Android Photo Picker 中「未修改的文件」可能变得不可读（`ERR_UPLOAD_FILE_CHANGED`，mtime 不稳定）；
  - [Chromium 543660460](https://issues.chromium.org/issues/543660460)：Photo Picker 文件在系统冻结/网络撤销 Google Photos provider 后不可读；
  - [Chromium 451866221](https://issues.chromium.org/issues/451866221)：HTML file input 的内存泄漏（移动端拍照/录像场景）。
  这些 issue 的标题本身就是风险信号；v1 应在 Android 真机上做「选完立即上传」的稳定性测试，并处理「读取 file 失败」的兜底提示。
- **视频容器/编码不做保证**：由系统相机 App 决定，服务端应按 MIME/魔数探测，不能假设固定 MP4。

### F4. PWA 安装条件与 iOS 限制

**Chrome / Android：**

- 安装条件（会触发 `beforeinstallprompt` 的那套）：HTTPS；manifest 含 `name` 或 `short_name`、192px 与 512px 图标、`start_url`、`display`（fullscreen/standalone/minimal-ui/window-controls-overlay）、`prefer_related_applications` 不为 true；再加用户互动启发式（至少点击过一次、累计停留 ≥30s）。来源：[web.dev 安装条件](https://web.dev/articles/install-criteria)。
- **Service Worker 的 fetch handler 已不是「菜单安装」的硬条件**：Chrome 108（移动）/112（桌面）起移除了该要求；但文章同时说「安装提示算法目前仍要求 fetch handler」。来源：[Chrome 博客 Revisiting installability criteria](https://developer.chrome.com/blog/update-install-criteria)。这条有时效性，2026 年的当前行为**未重新确认**；v1 不要把 `beforeinstallprompt` 当唯一入口，页面里直接写「浏览器菜单 → 安装/添加到主屏幕」的指引即可。
- 用户即使不满足安装条件也可以手动安装（Chrome 的说明）：[web.dev](https://web.dev/articles/install-criteria)。

**iOS / Safari：**

- **iOS 26 / iPadOS 26 起，Apple 把「可安装性」门槛降到了零。** WebKit 官方博客原文：默认情况下「every website added to the Home Screen opens as a web app」；添加时可关闭 “Open as Web App” 改为书签；manifest 仍然有用（图标、名称等），但不再是成为 Web App 的前提；“there are now zero requirements for ‘installability’ in Safari”。来源：[WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)。
- 安装入口是 Safari 分享菜单 → 添加到主屏幕（Apple 支持文档：[Turn a website into an app in Safari on iPhone](https://support.apple.com/guide/iphone/iphea86e5236/26/ios/26)）。
- **iOS 没有 `beforeinstallprompt`**，不能做「点一下弹安装」；只能在页面上教用户走分享菜单。iOS 16.4 起第三方浏览器也能提供「添加到主屏幕」：[WebKit Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)。
- 旧的 `apple-mobile-web-app-capable` + `navigator.standalone` 仍然存在（Apple 归档文档：[Configuring Web Applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html)）；但 iOS 26 后不必依赖它，manifest 的 `display` 更通用。
- **iOS 26 的「Open as Web App」开关意味着用户可能把它加成书签而不是 Web App**：页面应检测 `display-mode: standalone` / `navigator.standalone`，给出「当前在浏览器中，建议添加到主屏幕」的提示，但不要阻断上传。
- iOS 16.4+ 的 Web Push 只对「添加到主屏幕的 Web App」生效，且需要用户手势授权；v1 不需要推送，可作为上传完成通知的后续增强：[WebKit Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)。

### F5. Web Share Target：iOS 不可行，Android 可用但 v1 不建议

- **iOS 完全不支持。** BCD 中 `manifest.share_target` 的 `safari` 为 `false`，并指向 [WebKit bug 194593](https://bugs.webkit.org/show_bug.cgi?id=194593)；WebKit 的标准立场 issue 也只是在讨论阶段（[WebKit standards-positions #11](https://github.com/WebKit/standards-positions/issues/11)）。这意味着：

  - 从 iOS 相册「分享」到 PWA：**不可行**；
  - 从微信分享到 PWA：**不可行**（iOS 分享面板里根本没有 web app 目标）；
  - iOS 上唯一路径是：Safari 打开页面 → 手动选文件/拍照。

- **Android Chrome 支持，但前提很硬：** 必须是**已安装的 PWA**，manifest 里声明 `share_target`；文件分享必须 `method: "POST"`、`enctype: "multipart/form-data"`、`params.files` 数组；请求由 **Service Worker 的 `fetch` 事件**接收，文件先落到 SW 的 media cache，再重定向回页面消费。来源：[Chrome 官方 Web Share Target 文档](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target)、[web.dev 接收共享文件](https://web.dev/articles/files/receive-shared-files)。基础支持版本：Chrome Android 76+、桌面 Chrome 89+（BCD 也记录 Chrome Android 76 / Chrome 89）。
- **近期风险（公开 issue，未核实状态/影响版本）：**
  - [Chromium 561685220](https://issues.chromium.org/issues/561685220)：Android 上已安装 PWA 的 Web Share Target 丢文件，文本仍能到；
  - [Chromium 563089597](https://issues.chromium.org/issues/563089597)：M153 的 URI 权限校验修复后，共享文件被静默丢弃。
- **微信 → Android PWA** 是否出现在微信的分享目标列表里，取决于微信是否走系统分享 Intent；**未证实**，不要写进 v1 验收。
- 结论：**v1 不做 Web Share Target。** 它要求 SW（与 iOS 26.5 的空 body 回归冲突）、只覆盖 Android、且当前有文件丢失风险。v1.1 若做，单独做 Android 灰度并加「分享失败」兜底。

### F6. 后台、断点续传、内存与存储

- **iOS 没有 Background Sync / Background Fetch。** BCD 中 `SyncManager`、`BackgroundFetchManager` 的 `safari` 均为 `false`：[SyncManager BCD](https://github.com/mdn/browser-compat-data/blob/main/api/SyncManager.json)、[BackgroundFetchManager BCD](https://github.com/mdn/browser-compat-data/blob/main/api/BackgroundFetchManager.json)。iOS 切后台后页面 JS 会被挂起，上传不能假设继续。
- **Android 有，但不适合大文件。** Background Sync 自 Chrome 49、Background Fetch 自 Chrome 74；后者 MDN 明确是实验性、面向「下载」的 API（“managing downloads”）：[MDN Background Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API)。用 SW 在后台重放大文件上传既不保证时长，也受配额/电量策略影响；v1 不要依赖。
- **iOS 26.5.x 回归 319985（本笔记最重要的运行时风险）。** Bug 摘要：Safari/iOS 26.5.x 起，页面被 Service Worker 控制时，把 `<input type=file>` 得到的 `File` 作为 XHR/fetch body 发送，服务端收到 `Content-Length: 0` 的空请求；`file.arrayBuffer()` 正常，重新包成 `new Blob([await file.arrayBuffer()])` 可绕过；SW 不需要调用 `respondWith`，只要页面被控制就触发。已在 2026-10-10 合入 main（[323318@main](https://commits.webkit.org/323318@main)），2026-10-17 合入 safari 分支（321067.424）；**截至 2026-11-26 没有确认进入哪个已发布 iOS**。来源：[WebKit bug 319985](https://bugs.webkit.org/show_bug.cgi?id=319985)。
  - 影响：如果 v1 的页面注册了 SW（哪怕只是为了「可安装」或 share target），iOS 26.5.x 用户上传可能**静默收到 0 字节**；照片重新包 Blob 还能救，大视频会把整个文件读进内存，风险很高。
  - 规避：**v1 不注册 SW**（iOS 安装不需要 SW，见 F4；Android 菜单安装也不强制 SW）；若必须 SW，上传前把 File 读成 Blob，并对视频设大小上限/跳过 SW 控制的上传页（后者是否有效**未证实**，需真机验证）。
- **进度条用 XHR，不用 fetch。** `XMLHttpRequest.upload` 暴露上传进度事件；`fetch` 没有上传进度（[MDN XMLHttpRequest.upload](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/upload)）。同源请求无需担心 CORS 预检。
- **`keepalive` / `sendBeacon` 不适合文件。** 它们用于页面卸载前的小数据；`sendBeacon` 明确是「small amount of data」（[MDN sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon)），`keepalive` 也用于 analytics 类小请求（[MDN Request.keepalive](https://developer.mozilla.org/en-US/docs/Web/API/Request/keepalive)）。不要用它们传文件。
- **大文件本身不一定要进内存**：`File` 是磁盘支持的 Blob，`fetch`/XHR 直接发 `File`/`FormData` 时由浏览器流式读取；但一旦 `arrayBuffer()`/`FileReader` 就会整体载入。v1 的正常路径不要读整个文件；只有 319985 的绕行方案需要读。客户端也不要在浏览器里对视频做 SHA-256（`crypto.subtle.digest` 需要完整 BufferSource），去重/校验交给服务端。
- **Wake Lock**：上传期间请求屏幕常亮可降低「锁屏挂起」风险。iOS 16.4+ 支持，但在 standalone Web App 中 18.4 才可用（BCD 注记 [WebKit bug 254545](https://webkit.org/b/254545)）；Android Chrome 支持。失败时降级为页面提示「上传期间请保持屏幕常亮、不要切后台」。
- **iOS 存储策略**：Safari 17 起，浏览器 App 的总体配额最高为磁盘 80%，其他 App 20%；Home Screen Web App 的配额与浏览器相同，不是无限。ITP 会在「7 天无用户交互」后删除脚本可写存储（IndexedDB/LocalStorage/Cache/SW 注册等）；**但 Home Screen Web App 的首方域被豁免**。来源：[WebKit 存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/)、[WebKit Tracking Prevention](https://webkit.org/tracking-prevention/)。含义：不要把「待上传队列」当成可靠存储；上传成功即清，失败提示用户重选。单令牌也不要只存 localStorage（7 天规则/清缓存会丢；且属于 #6 的认证设计）。
- **断点续传**：v1 若做，用「分片 POST + 服务端记录 offset」即可；协议可参考 [tus 1.0](https://tus.io/protocols/resumable-upload)，但不必引入完整 tus。分片用 `file.slice(start, end)`，每片独立请求，失败重试同一 offset；服务端返回已接收字节数。iOS 前台 + 4G/内网下，20–50 MB 视频通常无需分片；100 MB 以上建议分片。

### F7. 文件大小、视频与格式归一化

- **规范层面没有「单文件大小上限」**；限制来自浏览器内存/临时空间、系统选择器导入、网络超时和服务端 body limit。不要承诺「支持任意大小」。
- **iOS 视频的隐性成本**：相机录制时长/分辨率不可控；从 Files App 选择是 import 副本；相册视频可能被转码。一个几分钟的 4K 视频达到数百 MB 是常见量级（具体取决于机型/设置，**未证实精确上限**）。v1 应自设上限（例如视频 ≤ 60s / ≤ 200MB，照片 ≤ 20MB），前端先提示、服务端再硬校验；超限返回 413 并给出可读错误。
- **服务端必须做格式归一化**，因为浏览器侧无法保证：
  - HEIC/HEIF → JPEG：可用 libheif（[libheif](https://github.com/strukturag/libheif)）或带 HEIC delegate 的 ImageMagick；
  - MOV/HEVC → MP4/H.264：用 ffmpeg（[ffmpeg 文档](https://ffmpeg.org/ffmpeg.html)）；
  - 统一剥离/保留 EXIF 方向，生成 inbox 用的安全文件名（不要用客户端文件名）。
  这块的实现归属 #8「DSH 文件、附件与工作区模型」，本票只给约束：**上传契约必须接受 image/heic、image/heif、video/quicktime，并允许服务端转码后再进 inbox。**
- **反向代理 body limit**：Caddy 的 `request_body { max_size ... }` 会在 Content-Length 超限时直接 413（[Caddy 文档](https://caddyserver.com/docs/caddyfile/directives/request_body)）；部署层（#2/#11）必须显式放行预期大小，否则前端怎么改都没用。DSH 自身上传端点是否有 body limit，属于 #10 待确认。

## 方案对比

| 方案 | 覆盖能力 | 优点 | 缺点 / 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **A. `<input type=file>` + `capture`** | 拍照、录像、相册、Files/Downloads | 零权限 API、零 SW、兼容面最广；iOS/Android 都能用；不依赖 getUserMedia | 不能控制分辨率/时长；iOS 输出 JPEG/MOV；Android Photo Picker 有相机入口/文件可读性坑；拿不到路径 | **v1 采用** |
| **B. `getUserMedia` + `MediaRecorder`** | 页内相机/录像，可约束分辨率、可限时 | 可控制视频大小/时长；预览体验好；可做「按住录像」 | 必须 HTTPS；要处理权限拒绝；iOS MediaRecorder 14+；编码/内存/发热；录制格式兼容性因浏览器而异 | v1.1 可选增强（尤其视频限时） |
| **C. Web Share Target** | 从相册/文件 App/其他 App 分享进 PWA | Android 上体验最好（少点几步） | iOS 完全不支持；必须安装 + SW；近期 Chromium 文件丢失 issue；微信是否支持未证实 | **v1 不做**，v1.1 Android 灰度 |
| **D. iOS 快捷指令 / 原生 App** | 系统级分享、后台上传 | 能力最全 | 超出「PWA」范围，维护成本高 | 不在本 v1 范围 |

## 推荐（v1 可实施规格）

### 交互

页面提供 4 个入口（同一页面，不做 PWA 强制安装）：

~~~html
<!-- 1. 拍照：iOS/Android 都直接进相机 -->
<input id="take-photo" type="file" accept="image/*" capture="environment">

<!-- 2. 相册：iOS 系统菜单；Android Photo Picker（可多选） -->
<input id="pick-photos" type="file" accept="image/*" multiple>

<!-- 3. 录像：直接进相机；不保证时长/分辨率 -->
<input id="take-video" type="file" accept="video/*" capture="environment">

<!-- 4. 文件：Files App / 下载目录；不限制类型时用 */* -->
<input id="pick-files" type="file" multiple>
~~~

实现要点：

1. 每次 `change` 后把 `input.value = ""` 清空，否则同一文件二次选择不触发 `change`。
2. 用 `URL.createObjectURL(file)` 做缩略图/视频预览，用完 `revokeObjectURL`；不要为了预览把视频读进内存。
3. 选择后展示：文件名、大小、MIME、来源（camera/gallery/files）。对 HEIC/MOV 显示「将转换为 JPEG/MP4」的提示（如果服务端会转）。
4. **顺序上传**（一次一个），避免 iOS 内存/网络竞争；每个文件独立进度和重试。
5. 进度用 `XMLHttpRequest.upload.onprogress`；失败重试 2–3 次（指数退避）；4xx（413/415）不重试，直接提示。
6. 上传期间请求 Wake Lock；`visibilitychange` 到 hidden 时提示「请保持页面在前台」；回到前台后若请求已断，按服务端 offset 续传或重传。
7. 不注册 Service Worker（v1）。若要「安装」体验，只提供 manifest（名称/图标/`start_url`/`display: standalone`）+ 手动安装指引；iOS 26 起不加 manifest 也能添加，但图标/名称会差。
8. 页面文案区分 iOS/Android：
   - iOS：「分享 → 添加到主屏幕」；若看到 “Open as Web App” 保持开启。
   - Android：「浏览器菜单 → 安装应用 / 添加到主屏幕」。

### 上传契约（给 #10 的最小约束）

- 同源 `POST /inbox/upload`，`multipart/form-data`；字段：`file`、`clientId`（随机 UUID，幂等用）、`capturedAt`、`source`（camera/gallery/files）、可选 `durationMs`。
- 返回：`{ id, name, size, mime, converted: bool, inboxPath }`；错误用 4xx + JSON `{ code, message }`。
- 必须接受：`image/jpeg`、`image/png`、`image/webp`、`image/heic`、`image/heif`、`video/mp4`、`video/quicktime`。
- 建议设 `maxSize`（如照片 20MB / 视频 200MB），超限 413；服务端转码后入库。
- 如果做分片：`POST /inbox/upload/{uploadId}?offset=N`（或 `Content-Range`），返回 `{ received }`；`DELETE` 取消。前端不需要知道总大小以外的信息。
- 认证：单令牌放 `Authorization` header（不要放 URL，避免日志/Referer 泄漏）；具体方案归 #6。

### 明确不可行 / 不要承诺

- ❌ iOS 上「从相册/微信直接分享到 PWA」：Web Share Target 不支持（F5）。
- ❌ iOS 上「锁屏/切后台继续上传」：无 Background Sync/Fetch，页面会被挂起（F6）。
- ❌ 通过网页直接访问「文件」App / 下载目录的真实路径：只能经系统选择器拿副本，`fakepath`（F2.6/F3）。
- ❌ 用 `capture` 控制相机分辨率、时长、码率、格式：接口没有约束；iOS 视频可能是 `.mov`（F2.5）。
- ❌ 保证 HEIC 原图上传：iOS 默认转 JPEG；服务端必须兼容 HEIC（F2.4）。
- ❌ 在 HTTP 内网 IP 上使用 `getUserMedia` / 安装 PWA / Share Target：非安全上下文（F1）。
- ❌ 在 iOS 上靠 `beforeinstallprompt` 引导安装：Safari 没这个 API（F4）。
- ❌ 在 iOS 26.5.x 上让 SW 控制的页面上传大 `File`：319985 空 body；除非已确认修复进入目标 iOS 版本（F6）。
- ❌ 用 `sendBeacon`/`keepalive` 传文件：只适合小数据（F6）。

## 风险与未解问题

1. **319985 的修复版本未知（最高风险）。** 已进 WebKit main 与 safari 分支，但截至 2026-11-26 没有已发布 iOS 的确认。需要在 iPhone（iOS 26.5.x / 26.6 / 27）上验证「无 SW / 有 SW / 重新包 Blob」三条路径；在修复落地前，v1 必须坚持无 SW。
2. **Android Photo Picker 的相机入口与文件可读性**：Odoo 的 workaround 只证明社区修复，不是官方保证；Chromium issue 586133901/543660460 的状态和影响版本未核实。需要在 Android 14/15/16 真机上验证「不带 capture 是否有相机」「选完立即上传是否 100% 可读」。
3. **HEIC 行为依赖 accept 与宿主**：WebKit 默认 Compatible→JPEG，但 Safari 是否在某些 `accept` 下请求原图未完全证实；Files App/Android 仍可能给 HEIC。服务端按「一定可能收到 HEIC」设计即可，不要在前端做格式白名单。
4. **MOV 预览与转码**：iOS 给的 `.mov` 在非 Safari 浏览器/桌面可能无法直接播放；v1 服务端转 MP4 后再给预览，前端不要依赖 `<video>` 直接播 `.mov`。
5. **大视频的前台约束**：没有后台续传；100MB+ 视频在弱网/锁屏下失败率高。建议 v1 限制时长/大小，并在 UI 上明确「需保持页面打开」。
6. **Share Target 的 Android 现状**：文件丢失 issue 可能影响 v1.1；微信分享是否走系统分享面板未证实；iOS 永远不支持。不要把「从相册分享」写进 v1 验收。
7. **DSH 上传端点契约未定**（#10）：body limit、分片、幂等、转码后入库位置都需要 #10/#8 确认；本票只能给浏览器侧约束。
8. **HTTPS 证书信任**（#2）：iOS 需要安装并信任根证书；Android Chrome 对用户 CA 的策略也要确认；否则 secure context 不成立。
9. **iOS 26「Open as Web App」开关**：用户可能加成书签；页面应检测 standalone 并提示，但不能阻断上传。
10. **单令牌在 PWA 中的存储**（#6）：localStorage 可能被清（7 天规则/用户清缓存）；不要放 URL；考虑 HttpOnly cookie 或每次输入。
11. **iOS 多选的起始版本**：当前 WebKit 源码/测试支持，但老 iOS 的差异未逐版核实；v1 对多选做「逐个上传」即可，不依赖一次性全选。
12. **SW scope 规避 319985 的假设未证实**：把上传页放在 SW scope 之外是否真的绕过，需要在真机上验证；不要把它当既定方案。

## 一手来源索引

- WebKit 源码：`WKFileUploadPanel.mm` <https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm>
- WebKit 布局测试：`file-upload-panel.html` <https://github.com/WebKit/WebKit/blob/main/LayoutTests/fast/forms/ios/file-upload-panel.html>
- WebKit bug 319985（SW 空 body 回归）<https://bugs.webkit.org/show_bug.cgi?id=319985>
- WebKit bug 270470（accept 与 HEIC 转码）<https://bugs.webkit.org/show_bug.cgi?id=270470>
- WebKit bug 185448（standalone getUserMedia）<https://bugs.webkit.org/show_bug.cgi?id=185448>
- WebKit bug 194593（Web Share Target）<https://bugs.webkit.org/show_bug.cgi?id=194593>
- WebKit Safari 26.0 <https://webkit.org/blog/17333/webkit-features-in-safari-26-0/>
- WebKit Safari 16.4 <https://webkit.org/blog/13966/webkit-features-in-safari-16-4/>
- WebKit 存储策略 <https://webkit.org/blog/14403/updates-to-storage-policy/>
- WebKit Tracking Prevention（7 天规则/Home Screen 豁免）<https://webkit.org/tracking-prevention/>
- MDN `<input type=file>` <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file>
- MDN `getUserMedia()` <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia>
- MDN Secure Contexts <https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts>
- MDN Background Synchronization API <https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API>
- MDN Background Fetch API <https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API>
- MDN XMLHttpRequest.upload <https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/upload>
- MDN Navigator.sendBeacon <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon>
- BCD: input <https://github.com/mdn/browser-compat-data/blob/main/html/elements/input.json>
- BCD: share_target <https://github.com/mdn/browser-compat-data/blob/main/manifests/webapp/share_target.json>
- BCD: SyncManager <https://github.com/mdn/browser-compat-data/blob/main/api/SyncManager.json>
- BCD: BackgroundFetchManager <https://github.com/mdn/browser-compat-data/blob/main/api/BackgroundFetchManager.json>
- BCD: WakeLock <https://github.com/mdn/browser-compat-data/blob/main/api/WakeLock.json>
- web.dev 安装条件 <https://web.dev/articles/install-criteria>
- web.dev 接收共享文件 <https://web.dev/articles/files/receive-shared-files>
- web.dev 拍照/采集 <https://web.dev/articles/media-capturing-images>
- Chrome 安装条件变更 <https://developer.chrome.com/blog/update-install-criteria>
- Chrome Web Share Target <https://developer.chrome.com/docs/capabilities/web-apis/web-share-target>
- Apple UIDocumentPickerViewController <https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller>
- Apple 支持：把网站变成 App <https://support.apple.com/guide/iphone/iphea86e5236/26/ios/26>
- Caddy request_body <https://caddyserver.com/docs/caddyfile/directives/request_body>
- tus 1.0 <https://tus.io/protocols/resumable-upload>
