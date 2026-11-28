# 版本记录

轻签（NasNotes）的本地版本史。每个版本对应一次提交，并在 git 里打了同名附注标签（`git tag -n` 可看摘要）。
APK 的 `versionCode` / `versionName` 与此处版本号同步；PWA 只需强刷让 Service Worker 换缓存。

## v3.1 — 2026-11-28

鸿蒙壳录音权限修复：v3.0 首版把 `onPermissionRequest` 的放行名单写错了资源名，真机/模拟器上点录音仍会立刻失败。

- **根因**：ArkWeb 的 `event.request.getAccessibleResource()` 在 API 26 返回 `["TYPE_AUDIO_CAPTURE"]`，而代码按 `ohos.permission.MICROPHONE` 比对，永远不匹配 → 走 `deny()` → `getUserMedia` 抛 `NotAllowedError`（界面提示「无法录音：Permission denied」）。系统层权限其实是给了的：桥 `requestMic()` 实测已返回 `granted`，`checkAccessTokenSync` 为 0。
- **修法**：`MIC` 常量改为 `TYPE_AUDIO_CAPTURE`，判断同时接受包含 `AUDIO_CAPTURE` 的资源名；`methodList`、桥方法、前端手势时窗逻辑均不变。
- **模拟器实测**（Pura X View / HarmonyOS 7.0.0.107 / API 26）：修前 `permission allow=0` + `getUserMedia` 立即失败；修后录 4 s 生成 13 KB 加密音频附件、可内联播放、强杀重启后仍在（便签列表显示 🎤 2）。
- **回归**：`tools/test_harmony_shell.js` 新增断言——必须在 `onPermissionRequest` 里出现 `TYPE_AUDIO_CAPTURE`，防止再退回按权限名比对。
- **产物级复验**（版本号已升到 `3000001 / 3.1.0` 后的测试签名包，卸载重装 = 审核员首次使用场景）：启动即免密直入空库 → 新建 → 点录音弹出系统「允许"轻签"访问你的麦克风？」并附引导提示 → 点允许后**自动开始录音**（按钮变「⏹ 停止 Ns」）→ 停止生成 `录音-…webm`，`12s · 43 KB`，底部「1 段录音 / 已存本机」→ 内联播放走到 0:08 → 保存后列表显示 `🎤1` → 强杀重启仍免密直入且数据在位。
- **签名两套并存（勿混）**：提审用 DevEco 自动签名（p7b 绑真机 UDID，模拟器装不上，`9568332/9568257`）；模拟器验证用 `tools/build-hap.ps1` 的 OpenHarmony 测试证书自签。两者签名不同**不能互相覆盖安装**，换签必须 `hdc uninstall` 后重装（会清空应用数据）。
- 版本：鸿蒙 HAP `3000001 / 3.1.0`；APK 与 SW 无改动（仍 `30 / 3.0`、`nas-notes-v32`）。

## v3.0 — 2026-11-28

应用内不再有密码（门禁交给系统锁屏/指纹/人脸）、连接服务器集中到设置、随包零内网 IP；并修复华为上架审核报的「录音失败」「设置弹窗关不掉」。

- **壳内免密直入**：判据只看原生桥有没有设备密钥能力（`DEVICE_KEY_OK` = `NasNative.getDeviceSecret`）。boot 直接走 `shellAutoUnlock()`——首次启动用设备密钥现建本机加密库（`createLocalVault('', { dev: true })`，标记 `dev: true`），之后每次启动自动解库，应用内不出现任何密码输入；开门禁完全由手机锁屏/指纹/人脸（鸿蒙可再叠加「应用锁」）负责。PWA 与旧壳（没有该桥方法）仍是密码锁屏。
- **旧库一次性迁移**：v2.9 及以前用密码包裹的本机库，兜底面板输一次旧密码 → `migrateLocalVaultToDevice()` 把本机包裹层换成设备密钥包裹，其余字段不动；解不开（清过数据/换机）只能清空重建，NAS 上的数据不受影响。
- **设备密钥只在原生侧**：安卓 `SecureRandom` 32 字节→64 hex 存 SharedPreferences，鸿蒙 `cryptoFramework.createRandom().generateRandomSync(32)` 存 Preferences；网页侧只在内存 `devSecretMemo` 缓存一次，绝不写 IndexedDB / localStorage（回归里有逐字节检查）。
- **「设置 → 连接服务器」集中四项**：服务器地址、账户、密码、CA 证书。`window.NnConnectServer({server,username,password})` → 登录 → 对齐加密库（远端空 / 同 salt / 异 salt 三条路径）→ 首轮同步；账户与密码只存原生沙箱，网页存储不落密码。上行的只有「账户密码包裹层」（`serverWrapped`），设备密钥那层永不上行——推上去等于挂一把谁都打不开的锁。
- **随包不再内置证书与内网地址**：删除 `static/ca.crt`、鸿蒙 `rawfile/ca.crt`，退场内置 pin / `OWN_HOST` / `buildPinnedTrust` / 旧地址迁移；HTTPS 只剩两条路——用户导入自家 CA（叠加系统根）或系统默认信任。新增 `tools/test_no_private_ip.js`（随包文件里不含任何内网地址、三处证书均不存在、`sync-assets.js` 不再同步 `ca.crt`）。**注意：git 历史与已推送的远程仍含旧地址，彻底清除需重写历史后强推。**
- **修复审核问题①「点击录音提示无法录音」**：鸿蒙的 `ohos.permission.MICROPHONE` 是 user_grant——`module.json5` 声明只是「允许申请」，ArkWeb 的 `onPermissionRequest` 也只放行网页层，缺系统层授权时 `getUserMedia` 直接 NotAllowedError。新增桥方法 `requestMic()` / `micState()`（Native 侧 `checkAccessTokenSync` + `requestPermissionsFromUser`），网页 `ensureMicPermission()` 在录音前调用并等用户点「允许」（最多 15 秒）；被拒时明确提示去「设置 → 应用和元服务 → 轻签 → 权限」开启麦克风。`methodList` 扩到 13 项。
- **修复审核问题②「设置里取消/保存无响应、关不掉弹窗」**：ArkWeb 把 `<dialog>` 放进 top layer（模态层）后，弹窗能画出来但内部按钮命中测试失效——弹窗外的按钮（☰/新建/设置入口）全部正常。`openDialog()` 改为**只用 `open` 属性 + 普通 fixed 层**（z-index 420，遮罩 410），不再调用 `showModal()` / `show()`；CSS 补 `dialog:not([open]) { display: none !important; }`（`.settings-dialog` 的 `display:flex` 会盖掉 UA 规则），提示条 z-index 提到 460 以免被遮罩压住。所有弹窗（设置/分类/输入/确认/连接 NAS）同时受益。
- 测试：新增审核回归 6 项（`test_mobile_layout.js`：弹窗不进模态层、取消/保存/× 三个出口都在命中测试最上层且真能关掉）、鸿蒙壳新增 2 项（麦克风三道齐备、弹窗不走 top layer）、离线流程重写为双流程（A 旧壳密码建库 17 项 / B 新壳免密直入 13 项）；全套 18 套桩测通过（离线 44、手机版式 36、鸿蒙壳 10、客户端端到端 28、富文本 11、壳页面 6…）。
- SW 缓存 v32；APK `versionCode 30 / 3.0`；鸿蒙 HAP `3000000 / 3.0.0`（DevEco 自动签名，真机直装）。

## v2.9 — 2026-11-28

本机优先的上架形态 + 「设置 → 同步」里连接 NAS 与导入自家 CA 证书。

- **壳内首次启动 = 纯本机**：上架包不再有任何 NAS 概念——首次锁屏只让设「本机密码」（至少 8 位），全程零联网、不出现地址行与账户名；本机库照常随机 wkey + PBKDF2 + AES-GCM 加密。已配过 NAS 地址的老装机升级后仍保留「解锁 / 在线登录」两条路（`LOCAL_FIRST` 按原生 `getServer()` 是否为空判定）。
- **NAS 连接挪进「设置 → 同步」**：壳内 `_bridge.js` 在同步面板注入「NAS 地址」行（保存进原生 Preferences，可测试连接）；`app.js` 每次打开设置派发 `nn:settings-open`，桥按原生真值回填，别处改过配置打开即见当前值。同步默认手动，点列表顶部状态胶囊才连。
- **导入本地 CA 证书**（安卓 `MainActivity.setCa/getCa/clearCa` + 鸿蒙 `NasBridge` 同名桥方法，语义与中文提示逐字一致）：同步面板出现文件选择行（.crt/.pem/.cer，≤256KB，须含 `-----BEGIN CERTIFICATE-----`），PEM 文本存原生 Preferences（鸿蒙再落盘沙箱文件供 `caPath`），只存本机、绝不上行；带「清除」与已导入张数状态。
- **HTTPS 信任按主机三分**（双端对齐，修复「内置 pin 独占 caPath 导致别人连不上自家 NAS」）：连作者自家 NAS（按主机名判定）仍用内置 pin（与用户导入证书并存时合并 bundle）；他人 NAS 用导入的 CA（叠加系统根）；没导入则走系统信任（Let's Encrypt 等公开证书直接可用）。鸿蒙侧 `CaBundle.pathFor(host)` + `NasHttp.hostOf(url)` 实现；安卓侧 `applyNasTls` 同款分支。（该 pin 已在 v3.0 整体移除，见下。）
- **原生桥缺地址不出网**：`apiAsync` 空 server 直接回 `{"error":"no server configured"}`，本机模式下任何 `/api/` 都不会拨号。
- 双壳共用一份 `_bridge.js`（安卓 assets 为母本，`E:\HarmonyOS\nas-notes-harmony\tools\sync-assets.js` 同步到鸿蒙 rawfile）；鸿蒙桥方法须登记在 `Index.ets` 的 `javaScriptProxy.methodList`。
- 测试：新增 `tools/test_harmony_shell.js`（7 项静态回归：桥三方法/methodList/NasPrefs CA 存取清/OWN_HOST 三分/caPath 按 host/版本下限）；`test_harmony_compat` SW 断言改下限（≥28）免每次升版改测试；全套 17 套桩测通过。
- SW 缓存 v31；APK `versionCode 29 / 2.9`；鸿蒙 HAP `2900000 / 2.9.0`（DevEco 自动签名，真机直装）。

## v2.8 — 2026-11-27

自签场景浏览体验修复。

- 自签证书下撤销 HSTS（浏览器对自签证书启用 HSTS 会硬拒站点）；旧默认 `http://…:28080` 自动升级 `https://…:28443`；地址缺协议时默认补 https；caddy 开访问日志。
- SW 缓存 v30；APK `versionCode 28 / 2.8`。

## v2.7 — 2026-11-27

NAS HTTPS 反代 + 壳内 pin：免装手机证书直连自签 NAS。

- `deploy/caddy/` 新增 HTTPS 反代（28443，自签 CA 链签发服务器证书），`docker-compose.yml` 挂载证书并把 28080 明文端口收紧为仅回环。
- 原生桥内置 NAS 自签 `ca.crt`（assets），HTTPS 转发注入 trust manager，只信任这条 CA 链；手机不需要安装证书即可连 `https://…:28443`。
- 默认地址切 `https://…:28443`；登录页 NAS 地址块仅壳内显示、可只填 IP:端口自动补协议、「测试连接」走 `/api/health`。
- SW 缓存 v29；APK `versionCode 27 / 2.7`。

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
