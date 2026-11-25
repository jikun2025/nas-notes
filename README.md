# 轻签 · NasNotes

一个为个人 NAS 设计的轻量加密便签：单容器后端 + PWA 前端，浏览器和安卓手机都能读写、离线编辑与同步，全文搜索在本地明文内存中完成。服务端与手机缓存只保存 AES-GCM 密文，不保存明文，也不保存加密口令。

适合记录账号、密码提示、配置片段、临时备忘等短文本，可在正文中插入图片并附带语音。**它不是多用户协作知识库，也没有版本历史和多级文件夹；富文本模式覆盖标题、加粗、列表、引用、表格、图片等常用排版，不做精细字处理。**

## 功能

- **NAS Web UI**：三区布局（分类栏 / 便签列表 / 编辑预览区，借鉴 Joplin 的信息层级）；四种视图可随时切换——**富文本**（默认，直接看排版，不显示 Markdown 符号）/ 源码 / 分栏 / 预览。
- **便签快捷操作**：列表项右键（手机长按）可打开、调整分类或删除；分类可新建/改名/删除。
- **编辑区头部**：标题框内嵌字数计数（`n/200`），右侧「✓ 保存」可立即加密落盘并触发一次同步；分类以胶囊标签显示，便于一眼看清归档位置。
- **编辑工具栏**：桌面两行分组——上行「段落 / 字号」下拉加加粗、斜体、删除线、列表、待办、引用、代码、链接，下行插入图片/录音、表格与行列调整、分隔线；手机上合并为一行，可左右滑动（右缘渐隐提示）。
- **编辑工具栏行为**：富文本下点「B」就是真加粗、选「段落：标题 2」就是真标题，正文里不会冒出 `**` `#`；源码模式下则是 Markdown 快捷排版。表格一键插入并可在富文本里直接增删行列（不依赖弹窗），编辑区字号即时切换，源码与渲染结果分栏时滚动联动。
- **设置与主题**：两级设置（账户 / 同步 / 外观与编辑 / 数据与备份 / 关于）；浅色/深色主题与编辑字号只存本机。
- **安卓端**：PWA「添加到主屏幕」后像 App 一样使用；首次在线打开并完成一次同步后即可离线读写。
- **端到端加密**：PBKDF2-HMAC-SHA256（310,000 次迭代）派生密钥，AES-256-GCM 加密标题+正文；每条便签独立随机 IV。
- **离线优先**：离线修改写入 IndexedDB（密文）并进入待同步队列；可选自动或手动同步，服务端与客户端均用「最后写入时间 + 设备标识」做确定性冲突裁决。
- **图片与录音**：图片直接插入正文光标位置（自适应压缩、点击放大、可单独删除），录音以低码率单声道 Opus 加密片段显示在正文下方；两者与正文一起 AES-GCM 加密，服务端只收到密文。设置中可选三档压缩强度，NAS 与手机端共用同一套逻辑。
- **全局搜索**：解锁后在本地明文内存里匹配标题、正文和图片文件名，断网同样可用；服务端不提供明文搜索接口。
- **加密备份**：Web UI 一键导出/导入加密 JSON 备份，备份文件不含明文（包含正文图片与录音密文）。
- **零运行时依赖**：后端只用 Python 标准库，前端无框架、无 CDN、无第三方脚本。

## 快速开始（Docker / 飞牛 NAS）

1. 复制本仓库到 NAS，例如 `/vol1/1000/docker/nas-notes`。
2. 启动：

   ```bash
   docker compose up -d --build
   ```

3. 浏览器打开 `http://NAS_IP:28080`，像普通服务一样用默认账户名 **admin**、密码 **admin** 登录（可在 `.env` 里用 `NOTES_USER` / `NOTES_PASS` 指定初始账户，仅首次建库时生效）。登录后立即在「设置」里修改账户名和密码——密码同时用于解锁加密库。（宿主端口为 28080——NAS 上 8080 已被 reader 容器占用；容器内仍是 8080。）
4. 首次进入会要求创建加密库（或自动迁移旧版加密库），确认后即可使用。

飞牛 NAS 用户也可以使用图形界面：Docker → Compose → 新增项目 → 项目路径选择该目录 → 创建项目。

### 手机端（安卓）

1. **必须先配置 HTTPS**。`http://NAS_IP:28080` 下 Service Worker 和 WebCrypto 不可用，PWA 无法离线。推荐用飞牛自带反向代理 + 域名证书，或 Nginx Proxy Manager / Caddy，把 HTTPS 域名反代到容器 `8080` 端口（即宿主 `28080`）。
2. 安卓 Chrome 打开 HTTPS 域名，菜单 →「添加到主屏幕」。
3. 首次在线打开，用与 NAS 端相同的账户口令登录并解锁加密库，完成一次同步。
4. 之后断网也能打开、编辑、搜索；自动模式下恢复网络后会同步，手动模式下点「同步」按钮即可。

> iOS 同样支持添加到主屏幕，但本文只验证了安卓路径。

### 安卓 APK 壳（`android/` 目录，免 HTTPS）

不想给 NAS 配 HTTPS 反代时，可以用仓库自带的原生 APK 壳（`android/`，纯 Java、零第三方依赖、仅平台内置 API）：

- 前端与 PWA **共用同一份 `static/`**（Gradle 直接把仓库根目录的 `static/` 挂为 assets），代码零复制零改动；壳里仅额外注入一个 `assets/_bridge.js`（劫持 `fetch('/api/*')` → 原生转发、blob 下载 → 原生保存、设置页注入服务器地址行）。
- 页面挂在 WebView 虚拟安全域 `https://appassets.androidplatform.net/` 下，`crypto.subtle`、IndexedDB、localStorage 全部可用——**APK 不要求 NAS 提供 HTTPS**；原生层只转发密文，不接触明文。
- NAS 地址在 App 内「设置 → NAS 服务器」里配置（存原生 SharedPreferences），默认 `http://192.168.5.10:28080`，带连接测试按钮；换端口/域名不必重新打包。
- 加密备份导出改存到系统「下载/NasNotes」目录；文件选择（插图/导入）与录音麦克风权限走原生桥接。

构建（需 JDK 17 + Android SDK platform 35 / build-tools 35.0.0，注意 `JAVA_HOME` 必须指向 JDK 17）：

```bash
cd android
sdkmanager "platforms;android-35" "build-tools;35.0.0"   # 已装可跳过
keytool -genkeypair -keystore nasnotes-release.jks -alias nasnotes -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass <密码> -keypass <密码> -dname "CN=NasNotes Shell, OU=local, O=nas-notes, C=CN"
# 生成 keystore.properties（storeFile/storePassword/keyAlias/keyPassword 四行）
gradle assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

把 APK 传到手机安装即可（自签名，需允许「安装未知应用」）。`keystore.properties` 与 `*.jks` 已被 gitignore，密钥请自行备份——丢失后无法用同一签名升级。

## 安全模型

| 位置 | 保存内容 |
| --- | --- |
| NAS SQLite (`data/notes.db`) | 仅 IV + AES-GCM 密文（正文 HTML 内嵌图片、录音片段）、时间戳、设备标识、删除标记；账户表只存登录凭证的 PBKDF2 哈希与盐，无明文口令；无 `title` / `body` 列 |
| 浏览器 IndexedDB | 仅密文便签（含图片/录音密文）、待同步队列、加密库 salt/wrapped（wkey 的密文包裹） |
| localStorage | 会话令牌（服务端签发、重启失效）、设备标识、压缩档位、同步方式与间隔（不存口令） |
| 浏览器内存 | 解锁期间的 wkey/CryptoKey 与明文便签 Map；锁定/刷新/关闭页面即清除 |

- **普通账户登录**：登录框只有账户名和密码（默认 admin/admin），不依赖 WebCrypto 或弹窗，局域网 HTTP 与安卓 WebView 下都能稳定登录。服务端把密码用 PBKDF2（200,000 次迭代 + 随机盐）哈希后入库，明文不落盘、不进日志。
- 加密库用随机 wkey（AES-256-GCM）加密便签；wkey 由 `AES-GCM(KDF(密码, salt, 310k), wkey)` 包裹存入 vault.wrapped。修改密码只换包裹层，wkey 不变、笔记密文无需重加密。服务端解不开 wkey，就无法解密任何笔记。
- 密码丢失且无备份时无法自行恢复。登录页「忘记密码？」只是一个逃生口：展开后会明确提示**将永久删除服务器和本机上的全部便签、图片和录音**，必须手动输入「清空数据」才会执行；它**不会修改账户名和密码**，执行后重新登录会创建新的空加密库。也可用加密备份恢复数据。
- 登录失败按 IP 限速（60 秒内 8 次失败即临时封禁 429）；改名/改密后旧会话令牌全部撤销。
- **密码丢失且无备份时无法恢复数据**；请写入密码管理器并单独保存加密备份。
- 从「口令直加密」的旧版加密库升级时，首次解锁会尝试用登录密码静默迁移：本机解密全部便签、生成随机 wkey 重加密、原子替换服务端 vault 包裹；迁移不弹 `window.prompt`（安卓 WebView 默认不支持）。升级时还会自动删除旧版可能存过明文的 SQLite 表并打印警告。

### 图片与录音

- 图片：点「🖼 在正文中插入图片」选图，会插入到正文光标位置，不再堆在便签底部。浏览器内优先编码为 WebP（不支持时回退 JPEG），按「缩放边长 × 质量」迭代压缩到目标体积，结果比固定质量更省空间。支持 JPG/PNG/WebP/GIF；GIF 无法无损保帧压缩，限制 2 MB。
- 文字保护：会粗略识别文字/截图类图片（大面积纯色 + 高频边缘），这类图片强制保留至少 1280 px 边长和更高质量，避免小字糊掉。
- 压缩档位（设置里选，仅影响之后新增的附件）：

  | 档位 | 图片目标体积 | 最长边 | 录音码率 |
  | --- | --- | --- | --- |
  | 清晰 | ≤ 700 KB | 1920 px | 64 kbps |
  | 均衡（默认） | ≤ 320 KB | 1440 px | 32 kbps |
  | 极小 | ≤ 140 KB | 1024 px | 20 kbps |

- 图片预览/删除：点击正文图片放大查看，右上角 `✕` 删除单张；图片文件名纳入全局搜索。
- 录音：强制单声道 + 回声消除/降噪，按所选码率用 MediaRecorder 录制 Opus/webm（兼容 mp4/ogg），单条最长 5 分钟。插入后提示压缩后大小，音频卡片也显示实际体积。
- 图片和录音都以 base64 随正文 JSON 一起加密，单条便签明文上限 8 MB，服务端密文上限 12 MB（请求体 14 MB），单条便签最多 20 段录音。
- 旧版便签中作为底部附件存在的图片，在解锁时会自动迁移为正文内联图片并在下次保存时落盘，无需手工处理。
- 预览/播放使用 `data:` URL，明文只在解锁后的浏览器内存中；锁定、刷新或关闭页面即清除，Service Worker 不缓存 API 响应。

### 双端同步

两端是同一套 PWA 前端，逻辑相同：本地先写密文，再按需与 NAS 对齐。

1. **本地写入**：编辑后先在浏览器内加密，写入 IndexedDB 的 `notes`，同时向 `outbox` 追加一条操作（新增/删除）；明文只进入内存缓存。
2. **推送**：按入队顺序把 `outbox` 逐条提交到服务端。服务端用「最后写入时间 + 设备标识」裁决，返回最终版本；客户端用返回结果覆盖本地、解密进内存并清除该条队列。
3. **拉取**：`GET /api/notes` 取回全部便签（含墓碑），跳过仍有本地待推送操作的条目，只在服务端版本更新时覆盖本地并解密。
4. **冲突**：时间相同按设备标识字典序裁决；冲突时以服务端版本为准并提示。没有字段级合并，同一条便签并发编辑会有一方被覆盖。

同步方式在「设置」里选，配置只保存在当前设备：

| 模式 | 触发时机 | 状态提示 |
| --- | --- | --- |
| 自动（默认） | 解锁、编辑后 0.3 秒、恢复联网、页面回到前台，以及按自定义间隔定时触发 | 同步中 / 已同步 / 离线 |
| 手动 | **只有**点击左侧「同步」按钮 | 手动模式 / 待同步 N |

- 自动间隔可填 10～86400 秒（默认 60 秒），超出范围会提示并自动收敛；定时触发在锁定、离线或页面隐藏时跳过。
- 手动模式下修改不会主动上传，徽标显示待同步条数，即使恢复联网也需点「同步」；切回自动或点按钮后会立即推送。
- 两种模式的加密、冲突裁决和备份完全相同；差异仅在「什么时候发起同步」。
- 启动读取加密库元信息、以及从备份导入时直接写服务端，不受同步模式影响。

### 已知限制

- 单用户设计：一个账户、无注册系统（默认 admin/admin，登录后在「设置」中改名改密）。不要把服务直接暴露公网，建议配合 HTTPS 反代 + 访问控制。
- 冲突采用 last-write-wins，多端同一时间修改同一条便签会有一方被覆盖（时间相同按设备标识裁决）。
- PWA 不是原生 APK，离线能力依赖浏览器；HTTPS 是硬要求。
- 正文是受限的轻量 HTML（仅用于内联图片和换行），不是完整富文本编辑器；没有版本历史、标签/文件夹。
- 便签正文 + 图片 + 录音上限 8 MB（加密前），服务端密文上限 12 MB；单条便签最多 20 段录音，不适合存长视频或大量原图。压缩档位只影响之后新增的附件，已有便签不会被重新压缩；GIF 动画不压缩。
- 不对图片做 OCR、不对录音做语音转文字；搜索匹配标题、正文文字与正文图片文件名。
- 录音依赖浏览器 MediaRecorder 与麦克风权限，必须在 HTTPS 或 localhost 下使用；iOS Safari 支持情况因版本而异。

## 加密备份

Web UI →「设置」→「加密备份」：

- **导出**：下载 `nas-notes-backup-YYYY-MM-DD.json`，包含格式标记、KDF 参数、salt、wkey 密文包裹（wrapped）和全部便签密文，不含明文。
- **导入**：选择备份文件；先用当前口令解密一条便签验证口令一致，再逐条以密文恢复。导入需要在线（已登录会话），且要求当前加密库为空或口令一致。
- 数据目录只需备份 `data/notes.db`（可用 SQLite 的 `.backup` API 热备份）；导出的 JSON 备份可跨实例恢复。

## API

除 `/api/health` 与登录相关接口外，所有接口都需要在 `X-Token` 请求头或 `Bearer` 中携带登录后的会话令牌（401 时响应带 `code:"session"`，前端会自动回到登录页）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（无需令牌） |
| GET | `/api/login-salt?username=` | 取登录盐与迭代数（无需令牌；未知账户返回随机盐防枚举） |
| POST | `/api/login` | `{username, password}` 登录，返回会话令牌（24h TTL，服务重启失效；仍兼容旧版 `credential` 字段） |
| POST | `/api/logout` | 注销当前会话 |
| GET | `/api/account` | 当前账户名 |
| PUT | `/api/account` | 改名/改密（`current_password` + 可选 `new_password` + 改密时必带重包裹 `vault`，同事务原子替换，成功后撤销全部旧会话；仍兼容旧版 credential 字段） |
| GET | `/api/meta` | 读取加密库参数（salt/wrapped/iterations/version） |
| PUT | `/api/meta` | 初始化加密库（只允许一次，已初始化返回 409；`replace:true` 用于旧库迁移替换） |
| DELETE | `/api/vault` | `{"confirm":"RESET"}` 清空加密库与全部密文（口令丢失逃生口） |
| GET | `/api/notes` | 拉取全部便签（含墓碑） |
| PUT | `/api/notes/{id}` | 写入/更新密文便签（旧时间戳会被拒绝） |
| DELETE | `/api/notes/{id}` | 软删除（保留密文墓碑） |

登录失败按 IP 限速：60 秒内 ≥8 次失败返回 429。

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `DATA_DIR` | `/data` | 数据库目录 |
| `STATIC_DIR` | 同级 `static/` | 前端静态文件目录 |
| `NOTES_USER` | `admin` | 初始账户名（仅首次建库时生效） |
| `NOTES_PASS` | `admin` | 初始密码（仅首次建库时生效，登录后请立即在「设置」中修改） |

## 开发与测试

```bash
# 本地直接运行（需 Python 3.9+；默认账户 admin/admin）
PORT=8080 DATA_DIR=./data python server.py

# 语法检查
node --check static/app.js
node --check static/md.js
node --check static/html2md.js
node --check static/sw.js

# 桩测（零依赖，全部本地跑）
python tools/test_auth_api.py          # 账户/会话/改密/限速/穿越 37 项
node tools/test_cryptofb.js            # crypto 兜底层与 Node 字节级互操作 49 项
node tools/test_legacy_migration.js    # 旧库→wkey 包裹结构端到端迁移 16 项
node tools/test_md_table_fs.js         # Markdown 表格/字号渲染 22 项
node tools/test_login_ui.js            # 登录页隐藏字段/清库警示静态回归 7 项
node tools/test_ui_overhaul.js         # 三区布局/工具栏两行与手机横滑/标题计数与保存/两级设置/右键菜单 12 项
node tools/test_rich_editor.js         # 富文本模式结构 + HTML→Markdown 往返稳定 11 项（含真实浏览器）
```

`test_rich_editor.js` 会启动一个临时本地静态服务，再用系统自带 Edge/Chrome 的 headless 模式跑 `tools/rich-fixture.html`：把 16 组 Markdown 渲染成 DOM，序列化回 Markdown，再渲染一遍，要求两次 HTML 完全一致（含代码块、表格、任务列表、图片占位、字号包裹）。找不到浏览器时该用例自动跳过。

后端 API 测试覆盖：登录/会话、密文读写、冲突裁决、软删除、改密原子性与旧会话撤销、登录限速、静态穿越；前端用 Node 内置 `crypto` 验证 AES-GCM 往返与错误口令拒绝。

## 与同类项目的区别

发布前调研了 GitHub 上的同类方案（数据截至 2026-11-25）：

| 项目 | 特点 | 与本项目的差异 |
| --- | --- | --- |
| [Vaultwarden](https://github.com/dani-garcia/vaultwarden) | Bitwarden 兼容密码库，功能完整 | 客户端离线只读，定位是密码库而非便签 |
| [Standard Notes](https://github.com/standardnotes/server) | 老牌 E2EE 笔记，多端成熟 | 服务端为多容器架构，部署与资源占用明显更重 |
| [reapps](https://github.com/fundacja-reborn/reapps) | E2EE 零知识笔记 + 任务，离线优先 PWA | 使用 PostgreSQL + SvelteKit/Nx，部署栈复杂 |
| [OpenNotas](https://github.com/tonghoai/opennotas) | PWA 笔记，AES 加密同步到 Turso | 同步依赖自建 Turso + S3，不是单容器 NAS 方案 |
| [FastMemo Server](https://github.com/ontech7/fastmemo-server) | 单容器 E2EE 同步服务 | 新项目，配套客户端，Web 端仅 HTTPS，功能边界不同 |
| [Memos](https://github.com/usememos/memos) | 轻量自托管速记 | 服务端明文存储，无端到端加密 |
| [Joplin](https://github.com/laurent22/joplin) | 成熟笔记 + 原生安卓端 | 需要 PostgreSQL，Web 编辑为 Beta，体量大 |

本项目的定位是：**一个单容器、零框架依赖、NAS 上一装即用的极简加密便签**，把「密码本式短文本 + 双端离线可写 + 本地搜索」做到最小可用，而不是通用笔记系统。

## 许可证

AGPL-3.0，详见 [LICENSE](LICENSE)。安全问题的披露方式见 [SECURITY.md](SECURITY.md)。
