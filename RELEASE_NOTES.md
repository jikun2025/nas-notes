# 轻签 · NasNotes v2.6

轻量端到端加密便签：单容器 Python 标准库后端 + 零依赖 PWA 前端，另带一个纯 Java 的安卓 APK 壳。服务端与手机缓存只保存 AES-GCM 密文。

> **本次发布是全新安装体验：仓库与发布产物里没有任何现有账户、便签、备份或密钥。** 首次启动时服务端会建一个空库，并自动创建默认账户 **admin / admin**。

## 默认账户

| 项 | 值 |
| --- | --- |
| 账户名 | `admin` |
| 口令 | `admin` |
| 生效时机 | 仅首次建库（`data/notes.db` 不存在时） |
| 覆盖方式 | `.env` 里的 `NOTES_USER` / `NOTES_PASS`（同样只对首次建库有效） |

首次启动日志会打印：

```
NOTICE: 已创建默认账户 admin / admin —— 请首次登录后在「设置」中修改口令。
```

**登录后请立刻在「设置 → 账户」里改账户名和口令。** 口令同时用于包裹加密库密钥（wkey，PBKDF2 310k + AES-GCM）；改密会在同一个事务里重包裹，旧口令立刻失效。如果一直用 admin/admin，任何能访问到这个端口的人都能解开你的库。

## 清除既有账户与数据

按需要的彻底程度三选一：

1. **只清空便签与密钥包裹（保留账户）**：网页「设置 → 数据与备份 → 清空数据」，输入「清空数据」确认；等同 `DELETE /api/vault` 带 `{"confirm":"RESET"}`。会删除 `vault` 与全部便签，`accounts` 表保留，`epoch + 1` 让各客户端下次同步自动全量对齐。
2. **连账户一起重置（回到出厂）**：停容器后删除 `data/notes.db`（含 `-wal` / `-shm`）再启动，服务端会重建空库并重新创建默认账户 admin/admin。**不可恢复，删前先导出加密备份。**
3. **换设备 / 重装 APK**：手机端在「设置 → 数据与备份」里清空本机库，或卸载重装；本机 IndexedDB 与 NAS 上的密文互不影响。

> 升级已有实例（已有 `data/notes.db`）**不会**被重置成 admin/admin——账户与数据原样保留。

## 本版内容

- **增量同步**：服务端为每次写入/删除分配单调递增 `rev`，`GET /api/notes?since=<rev>` 只回变更并按 `rev` 分页（400 条 / 约 4 MB），删除以墓碑保留；`epoch` 代际保证 RESET 后客户端强制全量。客户端游标只存 `{rev, epoch, salt}`。实测 416 条库：全量 89,402 B → 无变更增量 **115 B**。
- **内存态全文索引**：解锁后构建中文 bigram + 单字倒排表与分类倒排表，搜索先取候选再精确校验，语义与全量扫描一致（1000 条 / 200 组查询零漏检）；**明文索引只在内存，锁定即销毁，不落盘、不上行**。
- **鸿蒙 7.0 / 卓易通兼容**：新增纯 ES5 能力垫片 `compat.js` 与 `__NN_CAPS__` 诊断；WebView 新旧两版 `shouldInterceptRequest` 都转发；安全区 insets 不回调时用系统 dimen 兜底；`_bridge.js` 补 fetch/Response/FileReader 降级；CSS 对 `dvh` / `env()` 双降级。
- **部署可验证**：新增 `tools/verify_deploy.py`，对真实实例跑 25 项增量协议冒烟（登录、写入、`since` 增量、墓碑、LWW 拒绝、游标边界、流量比、静态资源版本）。

## 升级

- **NAS / Docker**：`server.py` 打在镜像里，必须 `docker compose build && docker compose up -d`，只 `restart` 不会换代码。升级会自动给 `notes` 表补 `rev` 列并回填历史条目，数据与 `vault` 不变；建议先备份 `data/notes.db`。
- **浏览器 PWA**：下次打开会自动换到 Service Worker v28；界面没变就强刷一次。
- **安卓 APK**：装本页附带的 `nas-notes-shell-v2.6.apk`。旧版 APK 连新服务端仍能同步（自动退回全量），只是不省流量。

## 附件

| 文件 | 说明 |
| --- | --- |
| `nas-notes-shell-v2.6.apk` | 安卓壳，versionCode 26 / versionName 2.6，119,348 B，内含 `compat.js` / `nn-index.js`；登录页填自己的 `NAS_IP:端口` |

APK 只加载本机 assets 并走原生转发，**不需要 NAS 上配 HTTPS**；浏览器 PWA 仍需要 HTTPS（WebCrypto / Service Worker / 麦克风的硬条件）。

## 质量

18 套桩测 / 350 项断言全绿：服务端账户与增量协议、加密互操作、富文本往返、离线读写与同步、手机布局与安全区、鸿蒙兼容静态回归、全文索引等价性（真实浏览器 CDP + 真实 `server.py`）。CI 在 GitHub Actions 上跑不需要浏览器的 7 套。

## 已知限制

- 单条明文 ≤ 8 MB、密文 ≤ 12 MB、请求体 ≤ 14 MB，单条最多 20 段录音。
- 换设备首次同步仍需分页拉全量并逐条解密；日常同步已增量。
- 冲突策略是 last-write-wins（时间戳相同按设备标识字典序），`rev` 不参与裁决。
- 不是多用户协作工具：单实例单账户体系，没有共享、评论、版本历史。
