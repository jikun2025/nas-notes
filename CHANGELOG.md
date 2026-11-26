# 版本记录

轻签（NasNotes）的本地版本史。每个版本对应一次提交，并在 git 里打了同名附注标签（`git tag -n` 可看摘要）。
APK 的 `versionCode` / `versionName` 与此处版本号同步；PWA 只需强刷让 Service Worker 换缓存。

## v2.6 — 2026-11-26

增量同步、内存全文索引、鸿蒙 7.0 / 卓易通兼容加固。

- **增量同步**：服务端给每次写入/删除分配单调递增 `rev`（`sync_state.notes_rev`），`GET /api/notes?since=<rev>` 只回变更并按 `rev` 分页（400 条 / 约 4 MB 一页）；删除以墓碑保留，增量也能拉到。`GET /api/meta` 附 `epoch` 代际，RESET 后客户端自动强制全量。客户端把 `{rev, epoch, salt}` 游标存本机 IndexedDB，salt/epoch 变化即全量；老服务端无 `rev` 时自动退化为一次全量不写游标。冲突裁决仍是 LWW + device 字典序，`rev` 不参与裁决（双端一致）。
- 实测 416 条便签：全量响应 89,402 B，无变更增量响应 **115 B**；5000 条库的日常同步不再搬运 10.7 MB。
- **全文索引**：新增 `static/nn-index.js`（零依赖 ES5），解锁后在内存构建中文 bigram + 单字倒排表与分类倒排表；搜索先取候选集再按原字段 `includes()` 精确校验，语义与全量扫描完全一致（1000 条 / 200 组随机查询对照零漏检）。索引随单条增删改增量维护，锁定/清库立即销毁，**明文绝不落盘**；`idbPutMany()` 用单事务批量写优化导入与拉取。
- **鸿蒙 7.0 / 卓易通**：新增 `static/compat.js` ES5 能力垫片（TextEncoder/TextDecoder、closest、NodeList.forEach、Object.assign、Array.from、Blob.text 等）与 `window.__NN_CAPS__` 诊断；WebView 新旧两版 `shouldInterceptRequest` 都转发同一判定，安全区 insets 不回调时用系统 dimen 兜底；`_bridge.js` 补 fetch/Response/FileReader 降级；CSS 对 dvh/env 做双降级；清理 `globalThis`。原生鸿蒙（ArkWeb）版可直接复用 `static/`，只需重写壳层。
- 测试：新增 `test_incremental_sync.py`(31) / `test_search_index.js`(13) / `test_harmony_compat.js`(17) / `test_client_sync.js`(28，真实浏览器端到端)；旧测试 `test_ui_overhaul` 断言随搜索实现更新，全套 18 套回归全绿。
- 新增 `tools/verify_deploy.py`（部署后冒烟 25 项）：对着真实实例验证登录→写入→`since` 增量→墓碑→LWW 拒绝→游标边界→流量比→静态资源版本；用于确认「镜像里跑的确实是这份代码」。
- 已部署到飞牛 NAS 实机验证：升级前备份 `data/notes.db.bak-preincremental-*`，重建镜像后容器 healthy；线上密文与 `vault` 与备份逐字节一致，`rev` 回填 1–3，`epoch=1`。临时实例实测：41 条库全量 15,073 B、空增量 113 B（0.7%）。
- SW 缓存 v28；APK `versionCode 26 / 2.6`。

## v2.5 — 2026-11-26

大规模数据性能：压测、分批渲染与搜索防抖。

- 新增 `tools/test_scale.js`：真实 Chromium（CDP）+ 真实 `server.py`，造 100/500/1000/3000 条密文便签，量化启动解密、列表渲染、搜索、单条保存、全量同步拉取的耗时；同时跑 5 项回归断言。
- 实测发现瓶颈不在加密/存储，而在**列表全量重建 DOM + 搜索每敲一字重渲染**：3000 条时列表 136 ms、搜索 173 ms、DOM 12018 节点。
- 优化：列表默认只渲染前 200 条（底部「显示全部」可展开，数据一条不少）；搜索输入 120 ms 防抖；正文→纯文本延迟解析并在搜索时缓存；无搜索时不再遍历 `notesInActiveFolder()` 两遍。3000 条列表 136→9 ms、搜索 173→30 ms、DOM 12018→819、连打 10 字只渲染 1 次；单条保存仍恒定 0.5 ms。
- 文档新增「容量与性能边界（实测）」；`test_ui_overhaul` 18→21 项。
- SW 缓存 v27；APK `versionCode 25 / 2.5`。

## v2.4 — 2026-11-26

编辑区固定头 + 设置长面板可滚动。

- 标题、分类、排版工具栏移出滚动容器，做成固定条：正文滚到中段仍能直接点加粗/标题/表格；只有正文滚动区在滚，滚动时固定条浮起一层淡投影。
- 修复设置对话框内容被裁：之前只给 shell 一个 `max-height`，列的 flex 子项按内容撑开，超出部分被 `overflow:hidden` 直接切掉。现在对话框按可视区（含安全区）限制高度、`display:flex` 收紧，内容区独立滚动，标题栏与「保存设置」常驻。
- 手机端设置底部留出手势条安全区；面板切换回到顶部。
- 测试：`test_ui_overhaul` 16→18 项（固定条结构、设置滚动链路），`test_mobile_layout` 21→30 项（390×844 真实浏览器：长正文下滑后工具栏仍在视口内、设置面板滚到底且保存条不被顶走）。
- SW 缓存 v26；APK `versionCode 24 / 2.4`。

## v2.3 — 2026-11-26

手机端 UI 修正（`a3b303b`）。

- 分类栏在 ≤1180px 不再是 `display:none`，改为可滑出抽屉：列表头「☰」打开，点遮罩/×/Esc/选中分类/进入便签收起；抽屉保留分类清单与底部同步、锁定、设置三个入口。
- 安卓 `targetSdk 35` 强制 edge-to-edge 导致顶部被状态栏压住：原生把真实 insets 写成 CSS 变量 `--nn-safe-*`，页面在各自头部/底部消费，浏览器直连退化为 `env(safe-area-inset-*)`。
- 新增 `test_mobile_layout.js`（真实浏览器出图）；SW v25；APK `versionCode 23 / 2.3`。

## v2.2 — 2026-11-26

修复壳内 502（`ec35ab7`）。

- 根因：虚拟域加载路径的首页由 `assetResponse()` 原样返回，没有注入 `__NN_SHELL__` 与 `_bridge.js`，`fetch('/api/*')` 落到拦截器得到 `502 Bridge Unavailable`，且 `IS_SHELL=false` 使同步退回「自动」。
- 抽出 `injectShellScripts()`，两条加载路径共用；前端对「桥接缺失 / 502」给出可操作提示。
- `test_shell_page` 改为虚拟域 + 内联降级双路径（6 项）；SW v24；APK `versionCode 22 / 2.2`。

## v2.1 — 2026-11-26

离线优先与登录页填地址（`a279ad3`）。

- APK 变成本机为主库：断网可建库、读写、搜索、离线解锁；同步默认「手动」，点列表顶部状态胶囊才连 NAS。
- 登录页新增「NAS 地址」（仅壳内显示，可只填 `IP:端口`，带 `/api/health` 测试按钮）；点登录先落盘再发请求，留空沿用上次地址。
- 新增「仅在本机使用」（`local_only` 本机库）；同步前校验两端 salt，不一致就停手，绝不覆盖。
- 新增 `test_offline_mode`(29) / `test_offline_sync`(10) / `test_login_server`(8)；SW v23；APK `versionCode 21 / 2.1`。

## v2.0 — 2026-11-26

修复 APK 白屏（`752012c`）。

- `WebResourceResponse` 第二参应为字符编码，之前误传 MIME 子类型，首页被当纯文本 → 白屏。
- 加载分两层：虚拟域 `loadUrl`，主文档失败或首屏 2.2s 仍空白则降级为全内联页 + `loadDataWithBaseURL`；真白屏时屏幕上摊开诊断信息（WebView 包名版本、UA、控制台错误）。
- 原生桥 headers 需 `JSON.parse`；`/api/` 一律走桥；壳内不注册 Service Worker。
- 新增 `test_shell_assets`(6) / `test_shell_page`(3)；APK `versionCode 20 / 2.0`。

## v1.7 — 2026-11-26

富文本与界面重构（`24bdf2e`、`456f739`、`39fb334`、`ab50eaf`、`2971493`）。

- 新增零依赖富文本（WYSIWYG）模式：`contenteditable` 承载 `md.js` 渲染的 DOM，保存时由 `html2md.js` 序列化回 Markdown；四视图 = 富文本 / 源码 / 分栏 / 预览。
- Joplin 三区布局；编辑器头部重做（标题框内嵌 `n/200` 计数、「✓ 保存」、分类胶囊）；工具栏桌面两行、手机一行横滑。
- 分类清单 `folderRegistry`（wkey 加密存 IndexedDB），修复「新建分类会覆盖旧分类」；空分类可改名/删除。
- 表格直接插入不依赖弹窗；所有 `confirm`/`prompt` 换成应用内 dialog 并带老 WebView 降级。

## v1.0 — 2026-11-25

首个可部署版本（`6950fca` 打标签）。

- 单容器 Python 标准库后端 + 零依赖 PWA；端到端加密（PBKDF2 310k + AES-256-GCM，wkey 包裹）；离线优先 + outbox 队列 + 确定性冲突裁决；图片/录音附件；加密备份导入导出；安卓 WebView 壳。
