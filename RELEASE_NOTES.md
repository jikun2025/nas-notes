# 轻签 · NasNotes v3.0

轻量端到端加密便签：单容器 Python 标准库后端 + 零依赖 PWA 前端，另带安卓 APK 壳与鸿蒙 HAP 壳。服务端与手机缓存只保存 AES-GCM 密文。

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

## 应用内不再有密码

| 形态 | 进入方式 | 本机加密库由谁包裹 |
| --- | --- | --- |
| 安卓 / 鸿蒙壳 | 系统锁屏、指纹、人脸（鸿蒙可再叠加「应用锁」） | 原生设备密钥（安卓 `SecureRandom` / 鸿蒙 `createRandom`，只存原生沙箱） |
| 浏览器 PWA | 密码锁屏 | 密码（PBKDF2 310k） |
| v2.9 及以前的壳 | 首次启动输一次旧密码 | 迁移为设备密钥包裹，数据不丢 |

设备密钥不落网页存储：网页侧只在内存里缓存一次，绝不写 IndexedDB / localStorage。上行的永远只有「账户密码包裹层」，设备密钥那一层不出本机。

## 连接服务器

只在「设置 → 连接服务器」填四项：**服务器地址、用户名、密码、CA 证书**。

- 地址与账户密码只存原生沙箱，网页存储不落密码。
- HTTPS 两条路：导入自家 NAS 的 CA（叠加系统根），或走系统默认信任（Let's Encrypt 等公开证书直连）。
- 包内不再内置任何证书、也不 pin 任何主机，因此别人装这个包能连他们自己的 NAS。

## 清除既有账户与数据

按需要的彻底程度三选一：

1. **只清空便签与密钥包裹（保留账户）**：网页「设置 → 数据与备份 → 清空数据」，输入「清空数据」确认；等同 `DELETE /api/vault` 带 `{"confirm":"RESET"}`。会删除 `vault` 与全部便签，`accounts` 表保留，`epoch + 1` 让各客户端下次同步自动全量对齐。
2. **连账户一起重置（回到出厂）**：停容器后删除 `data/notes.db`（含 `-wal` / `-shm`）再启动，服务端会重建空库并重新创建默认账户 admin/admin。**不可恢复，删前先导出加密备份。**
3. **换设备 / 重装壳**：手机端在「设置 → 数据与备份」里清空本机库，或卸载重装（本机库靠设备密钥包裹，卸载即丢）；NAS 上的密文不受影响，重装后在「设置 → 连接服务器」重新填一次即可拉回。

> 升级已有实例（已有 `data/notes.db`）**不会**被重置成 admin/admin——账户与数据原样保留。

## 本版内容

- **壳内免密直入**：判据只看原生桥有没有设备密钥能力（`DEVICE_KEY_OK` = `NasNative.getDeviceSecret`）。boot 直接走 `shellAutoUnlock()`——首次启动用设备密钥现建本机加密库（`dev: true`），之后每次启动自动解库，应用内不出现任何密码输入。旧库（密码包裹）兜底面板输一次旧密码 → `migrateLocalVaultToDevice()` 换包裹层。
- **「设置 → 连接服务器」集中四项**：`window.NnConnectServer({server,username,password})` → 登录 → 对齐加密库（远端空 / 同 salt / 异 salt 三条路径）→ 首轮同步。
- **随包零内网地址与零内置证书**：删除 `static/ca.crt` 与鸿蒙 `rawfile/ca.crt`，退场内置 pin / `OWN_HOST` / `buildPinnedTrust` / 旧地址迁移；新增 `tools/test_no_private_ip.js` 守住这条线（随包文件不含内网地址、三处证书均不存在）。
- **修复「点击录音提示无法录音」**：鸿蒙 `ohos.permission.MICROPHONE` 是 user_grant——`module.json5` 声明只是「允许申请」，ArkWeb 的 `onPermissionRequest` 也只放行网页层，缺系统层授权时 `getUserMedia` 直接 `NotAllowedError`。新增桥方法 `requestMic()` / `micState()`（`checkAccessTokenSync` + `requestPermissionsFromUser`）；网页侧在点击的手势窗口内同步查状态——已授权直接开录（`getUserMedia` 前不插 `await`，否则丢手势激活态），未授权先弹系统框、点「允许」后自动续录。
- **修复「设置里取消/保存无响应、关不掉弹窗」**：ArkWeb 把 `<dialog>` 放进 top layer 后，弹窗能画但内部按钮命中测试失效（弹窗外按钮正常）。`openDialog()` 改为只用 `open` 属性 + 普通 fixed 层（z-index 420 / 遮罩 410），不再调用 `showModal()` / `show()`；CSS 补 `dialog:not([open]) { display: none !important; }`；提示条 z-index 提到 460。所有弹窗同时受益。
- **增量同步 / 内存全文索引 / 鸿蒙兼容**（v2.6 起沿用）：`GET /api/notes?since=<rev>` 只回变更并按 `rev` 分页（400 条 / 约 4 MB），删除以墓碑保留；索引只在内存构建、锁定即销毁，不落盘不上行。

## 升级

- **NAS / Docker**：`server.py` 打在镜像里，必须 `docker compose build && docker compose up -d`，只 `restart` 不会换代码；建议先备份 `data/notes.db`。
- **浏览器 PWA**：下次打开自动换到 Service Worker `nas-notes-v32`；界面没变就强刷一次。
- **安卓 APK**：装本页附带的 `nas-notes-shell-v3.0.apk`；旧版 APK 连新服务端仍能同步（自动退回全量），只是不省流量。
- **鸿蒙 HAP**：本地用 DevEco 构建（自动签名绑定设备 UDID，不便分发），`3000000 / 3.0.0`。

## 附件

| 文件 | 说明 |
| --- | --- |
| `nas-notes-shell-v3.0.apk` | 安卓壳，versionCode 30 / versionName 3.0，134,712 B；SHA-256 `3242a472e2f9f6c4f6356b709dc49bfe89c10c8cbfe0ca0ecf1e3751295cda66` |

APK 只加载本机 assets 并走原生转发；浏览器 PWA 仍需要 HTTPS（WebCrypto / Service Worker / 麦克风的硬条件）。

## 质量

18 套零依赖桩测全绿：离线双流程 44、手机版式 36（含审核回归 6 项：弹窗不进模态层、取消/保存/× 三个出口都在命中测试最上层且真能关掉）、鸿蒙壳静态回归 10、客户端增量同步 28、账户与服务端 37、增量协议 31、富文本 11、壳页面 6、UI 21、搜索索引 13、随包隐私 3 等。CI 在 GitHub Actions 上跑不需要浏览器的 7 套。

## 已知限制

- 单条明文 ≤ 8 MB、密文 ≤ 12 MB、请求体 ≤ 14 MB，单条最多 20 段录音。
- 换设备首次同步仍需分页拉全量并逐条解密；日常同步已增量。
- 冲突策略是 last-write-wins（时间戳相同按设备标识字典序），`rev` 不参与裁决。
- 不是多用户协作工具：单实例单账户体系，没有共享、评论、版本历史。
- **git 历史与已推送的远程仓库仍含作者旧内网地址**（源码文本层面已清干净，但历史提交里还在）。彻底清除需重写历史并强推，属破坏性操作，建议顺带更换 CA 并重签服务器证书。
