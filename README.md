# 轻签 · NasNotes

一个为个人 NAS 设计的轻量加密便签：单容器后端 + PWA 前端，浏览器和安卓手机都能读写、离线编辑与同步，全文搜索在本地明文内存中完成。服务端与手机缓存只保存 AES-GCM 密文，不保存明文，也不保存加密口令。

适合记录账号、密码提示、配置片段、临时备忘等短文本。**它不是多用户协作知识库，也没有附件、版本历史和文件夹。**

## 功能

- **NAS Web UI**：浏览器直接新建、编辑、删除、搜索便签。
- **安卓端**：PWA「添加到主屏幕」后像 App 一样使用；首次在线打开并完成一次同步后即可离线读写。
- **端到端加密**：PBKDF2-HMAC-SHA256（310,000 次迭代）派生密钥，AES-256-GCM 加密标题+正文；每条便签独立随机 IV。
- **离线优先**：离线修改写入 IndexedDB（密文）并进入待同步队列，联网后自动推送；服务端与客户端均用「最后写入时间 + 设备标识」做确定性冲突裁决。
- **全局搜索**：解锁后在本地明文内存里匹配标题和正文，断网同样可用；服务端不提供明文搜索接口。
- **加密备份**：Web UI 一键导出/导入加密 JSON 备份，备份文件不含明文。
- **零运行时依赖**：后端只用 Python 标准库，前端无框架、无 CDN、无第三方脚本。

## 快速开始（Docker / 飞牛 NAS）

1. 复制本仓库到 NAS，例如 `/vol1/1000/docker/nas-notes`。
2. 生成随机访问令牌：

   ```bash
   openssl rand -hex 24
   ```

   在项目目录创建 `.env` 文件：

   ```env
   NOTES_TOKEN=上一步生成的随机字符串
   ```

3. 启动：

   ```bash
   docker compose up -d --build
   ```

4. 浏览器打开 `http://NAS_IP:8080`，首次进入会要求创建加密库。设置至少 8 位的加密口令，确认后即可使用。
5. 页面右下角「设置」中填入第 2 步的 `NOTES_TOKEN` 并保存（同一令牌只需在每个浏览器/设备填一次）。

飞牛 NAS 用户也可以使用图形界面：Docker → Compose → 新增项目 → 项目路径选择该目录 → 创建项目。`NOTES_TOKEN` 可直接写在 compose 文件里，或通过 `.env` 提供。

### 手机端（安卓）

1. **必须先配置 HTTPS**。`http://NAS_IP:8080` 下 Service Worker 和 WebCrypto 不可用，PWA 无法离线。推荐用飞牛自带反向代理 + 域名证书，或 Nginx Proxy Manager / Caddy，把 HTTPS 域名反代到容器 `8080` 端口。
2. 安卓 Chrome 打开 HTTPS 域名，菜单 →「添加到主屏幕」。
3. 首次在线打开，输入与 NAS 端相同的加密口令并完成同步。
4. 之后断网也能打开、编辑、搜索；恢复网络后自动同步。

> iOS 同样支持添加到主屏幕，但本文只验证了安卓路径。

## 安全模型

| 位置 | 保存内容 |
| --- | --- |
| NAS SQLite (`data/notes.db`) | 仅 IV + AES-GCM 密文、时间戳、设备标识、删除标记；无 `title` / `body` 列 |
| 浏览器 IndexedDB | 仅密文便签、待同步队列、加密库 salt/verifier |
| localStorage | API 访问令牌、设备标识（不存加密口令） |
| 浏览器内存 | 解锁期间的 CryptoKey 与明文便签 Map；锁定/刷新/关闭页面即清除 |

- 加密口令不上传、不写盘；服务端只保存加固定校验串（verifier）用于校验口令，不保存口令或派生密钥。
- 升级时会自动删除旧版可能存过明文的 SQLite 表和浏览器 IndexedDB，并在服务端日志打印警告。旧版明文数据不会自动迁移。
- `NOTES_TOKEN` 与加密口令是两套独立凭据：前者只保护 API，后者加密内容。两者都应妥善保管。
- **加密口令丢失无法恢复数据**；请写入密码管理器并单独保存加密备份。

### 已知限制

- 单用户设计，没有注册/登录系统；API 令牌是唯一访问控制手段。不要把服务直接暴露公网，建议配合 HTTPS 反代 + 访问控制。
- 冲突采用 last-write-wins，多端同一时间修改同一条便签会有一方被覆盖（时间相同按设备标识裁决）。
- PWA 不是原生 APK，离线能力依赖浏览器；HTTPS 是硬要求。
- 没有附件、富文本、版本历史、标签/文件夹。
- 便签正文长度上限约 600 KB（base64 后），适合短文本。

## 加密备份

Web UI →「设置」→「加密备份」：

- **导出**：下载 `nas-notes-backup-YYYY-MM-DD.json`，包含格式标记、KDF 参数、salt、校验串和全部便签密文，不含明文。
- **导入**：选择备份文件；先用当前口令解密一条便签验证口令一致，再逐条以密文恢复。导入需要在线，且要求当前加密库为空或口令一致。
- 数据目录只需备份 `data/notes.db`（可用 SQLite 的 `.backup` API 热备份）；导出的 JSON 备份可跨实例恢复。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（无需令牌） |
| GET | `/api/meta` | 读取加密库参数 |
| PUT | `/api/meta` | 初始化加密库（只允许一次，返回 409 表示已初始化） |
| GET | `/api/notes` | 拉取全部便签（含墓碑） |
| PUT | `/api/notes/{id}` | 写入/更新密文便签（旧时间戳会被拒绝） |
| DELETE | `/api/notes/{id}` | 软删除（保留密文墓碑） |

除了 `/api/health`，所有接口在设置 `NOTES_TOKEN` 后都需要 `X-Token` 请求头或 `Bearer` 令牌。

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `DATA_DIR` | `/data` | 数据库目录 |
| `STATIC_DIR` | 同级 `static/` | 前端静态文件目录 |
| `NOTES_TOKEN` | 空（不鉴权） | API 访问令牌，强烈建议设置 |

## 开发与测试

```bash
# 本地直接运行（需 Python 3.9+）
PORT=8080 DATA_DIR=./data python server.py

# 语法检查
node --check static/app.js
node --check static/sw.js
```

后端 API 测试覆盖：初始化、密文读写、冲突裁决、软删除、令牌鉴权、旧明文表清理、Service Worker 缓存头；前端使用 Node 内置 `crypto` 验证 AES-GCM 往返与错误口令拒绝。

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
