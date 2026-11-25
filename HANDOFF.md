# 交接说明（本地接手用）

轻签 / NasNotes：为飞牛 NAS 写的轻量端到端加密便签。后端只有 Python 标准库 + SQLite；前端无框架 PWA（WebCrypto + IndexedDB + Service Worker），NAS 浏览器和安卓主屏共用同一套代码。支持离线读写、正文内联加密图片、低码率录音、本地全文搜索、加密备份导出/导入、手动/自动同步（间隔可配）。另有 `android/` 原生 APK 壳（纯 Java 零依赖：WebView 挂 https 虚拟域加载同一份 static/，`_bridge.js` 把 /api/* 原生转发到可配置的 NAS 地址，APK 路线不要求 NAS 上 HTTPS）。

## 仓库状态

- `main` 分支，工作区干净；本地无 remote，**未推送 GitHub**。
- 提交作者仍是占位符 `NasNotes <nasnotes@local.invalid>`，正式推送前先改。
- `data/`、`.env` 已被忽略，仓库里没有真实数据；本机未构建过 Docker 镜像，部署由 NAS 端 Compose 构建（`deploy/deploy.sh` 一键脚本）。
- APK 构建环境：JDK 17（**必须**，`JAVA_HOME` 指向 JDK 8 会让 sdkmanager/AGP 报 JNI 或版本错误）+ `C:/Android/android-sdk`（platforms;android-35、build-tools;35.0.0）+ 本机 Gradle 9.4.1（AGP 8.13.0）。`android/keystore.properties` 与 `*.jks` 为本地产物已 gitignore，丢失签名则无法升级安装。

## 本地启动

Windows Git Bash，在仓库根目录执行：

```bash
PORT=18767 DATA_DIR=/tmp/nas-notes-local STATIC_DIR="$PWD/static" python server.py
```

`server.py` 默认 `DATA_DIR=/data`，本地必须覆盖。默认账户名 admin、密码 admin（`NOTES_USER`/`NOTES_PASS` 可覆盖初始账户，仅首次建库生效）；登录就是普通账户名+密码，首次登录后可在网页「设置」中改名改密码，密码同时用于解锁加密库。

## 接手提示词

> 接手本仓库（轻签 NasNotes）。先读 `README.md` 的「功能」「双端同步」「已知限制」和 `SECURITY.md`，再动代码。改动先本地验证再提交到 `main`；不要引入依赖、不要外泄明文、不要主动推 GitHub。

## 硬约束

1. 服务端和 IndexedDB 只存 AES-256-GCM 密文；明文只能在浏览器内存，锁定/刷新即清除，不写数据库、localStorage 或日志。
2. HTTPS 是 PWA、WebCrypto 和麦克风的硬条件，不要退回 `http://NAS_IP:端口` 的浏览器直连假设（安卓 APK 壳是例外：虚拟 https 域 + 原生转发，见 `android/`）。
3. 后端保持零依赖；前端不引入框架、CDN、外链资源。
4. 冲突策略是 last-write-wins（时间戳相同按设备标识裁决），两端必须一致。
5. 改前端后更新 `static/sw.js` 里的 `const CACHE` 版本号，否则手机端拿不到新界面。

## 验证清单

```bash
python -m py_compile server.py
node --check static/app.js && node --check static/sw.js && node --check static/cryptofb.js
curl -s http://127.0.0.1:18767/api/health

python tools/test_auth_api.py          # 账户/会话/改密/限速/穿越 37 项
node tools/test_cryptofb.js            # crypto 兜底层字节级互操作 49 项
node tools/test_legacy_migration.js    # 旧库→wkey 包裹 端到端迁移 16 项
node tools/test_md_table_fs.js         # Markdown 表格/字号渲染 22 项
node tools/test_login_ui.js            # 登录页隐藏字段/清库警示 7 项
node tools/test_ui_overhaul.js         # 两级设置/右键菜单/字号/表格 7 项
```

再测登录（账户名+密码）、`/api/meta` 初始化、便签密文写入读回、设置里改名改密、锁定/解锁后搜索；UI 改动另需浏览器实测：两级设置切换、右键/长按菜单改分类与删除、字号即时生效、表格弹窗插入。详细文档见 `README.md` 与 `SECURITY.md`。
