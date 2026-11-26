# 手机上传流程原型 v1

票：[#5 手机上传流程原型](https://github.com/Ar1-s/dsh_dev/issues/5)（map [#1](https://github.com/Ar1-s/dsh_dev/issues/1)）。
上游依据：#3 手机采集与上传能力、#4 v1 范围与验收边界、#8 DSH 文件与附件模型。

零依赖单文件静态页：真的能选文件（`<input type=file>`），**上传是本地模拟**（定时器推进度，不发任何请求）。
用途是与维护者逐屏拍板手机端交互，不是实现，不接真接口。

## 打开

双击 `index.html`；或用静态服务：

```
python -m http.server 8765 --directory prototype/mobile-upload-flow
```

本机开 http://127.0.0.1:8765/index.html 。手机同一网段开 `http://<本机IP>:8765/index.html`。
桌面宽屏下是一个 390×844 的手机壳，右侧列出各状态深链；窄屏（≤760px）自动全屏。

## 变体轴（两个旋钮，可自由组合）

| 旋钮 | 取值 | 含义 |
|---|---|---|
| `entries` | `4` | 四宫格：拍照 / 相册 / 录像 / 文件 |
| | `2` | 两按钮：拍摄（capture，图+视频）/ 从手机选 |
| | `22` | 2 大 + 2 小：拍照、相册为主，录像、选文件为次要行 |
| `confirm` | `1` | 先确认后上传（多一页预览，可移除） |
| | `0` | 即选即传（直接进上传页） |

## 状态与演示参数

| 状态 | 参数 |
|---|---|
| 空态 | `?entries=4&confirm=1&demo=pick` |
| 预览确认 | `?entries=4&confirm=1&demo=review` |
| 待上传（只在从确认页返回后出现） | `?entries=2&confirm=1&demo=pending` |
| 上传中（定格 42%） | `?entries=4&confirm=1&demo=uploading` |
| 弱网 | `?entries=4&confirm=1&demo=uploading&speed=weak` |
| 成功 / 断网 / 413 三分支 | `?entries=4&confirm=1&demo=failed` |
| 完成与本次记录 | `?entries=4&confirm=1&demo=done` |
| 令牌门 | `?demo=gate` |
| 截图模式（390×844，无外壳） | 追加 `&shot=1` |

`speed=fast|std|weak`，`fail=none|second|413|415|401`。
右上角「调试」可切变体、速度、注入失败、跳状态、复制当前参数。

## 已经写进原型的既定约束（来自已关闭的票）

- 原生 `<input type=file>`：拍照 / 录像用 `capture`，相册 / 文件多选；不注册 Service Worker、不做 Share Target（#3）。
- 上限：照片 20MB、视频 200MB 且 ≤60 秒、单批 10、并发 1、无断点续传（#4）。
- 失败分支：413 / 415 / 401 / 网络中断各有文案，4xx 不提供重试（#3 给出的契约建议）；弱网提示「保持前台、别锁屏」。
- 落点展示：`inbox/YYYY/MM/DD/<设备>/<时间戳>-<短哈希>-<slug>.<ext>`，可复制路径（#8）。
- 本次列表：只保留当前页面里的记录，关掉就清空（#4 的「只做本次」）。

## 仍然待定，不要当结论

- 令牌怎么输入与记忆归 #6；上传接口、错误码、body limit 归 #10。
- 失败项一旦离开页面就必须重选文件（不注册 SW 的直接后果）；这个代价是否接受，由本票拍板。
- 「录像」「选文件」在 v1 是否保留、入口怎么排布，由本票拍板。

## 版本

`v1 · 2026-11-26`。同一版以 commit + 上表参数为准；后续改动落在 `prototype/mobile-upload-flow` 分支的新 commit 上。
