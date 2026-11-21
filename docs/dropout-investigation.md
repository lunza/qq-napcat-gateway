# 掉线问题排查与修复（NapCat + macOS + QQ 7.x）

> 日期：2026-11-12｜账号：1000000001（示例bot）｜环境：macOS 14.6.1 / Intel / QQ 7.0.3-54395 / NapCat 4.18.42

## 一、结论

**你之前"经常掉线"，主因不是 QQ 自己断网，而是 NapCat 的重连链路存在断点，加上旧安装方式已经失效。** 两个问题都已在本次修复：

1. **入口失效（旧安装方式的问题）**：QQ 热更到 7.x 后，由 `app_launcher`（原生 QQEXDOC）接管启动，直接加载热更包，
   2025-07 那套"改基础包 main + Documents/loadNapCat.js"的注入在新版 QQ 上根本不生效 —— 表现就是"看起来在跑，其实没有协议端"。
2. **重启丢快速登录参数（框架自身链路的问题，源码已核实）**：NapCat 检测到 `KickedOffLine` / `SelfOffline`
   后重启 Worker 时，调用的是 `startWorker(false)`，**刻意不传** `-q <uin>`。
   重启后的 Worker 只能读 `NAPCAT_QUICK_ACCOUNT` 或 WebUI 的 `autoLoginAccount`；若两者都没有，就退回"出二维码等人扫"。
   无人扫码 → 进程在跑但账号未登录 → 你看到的就是"掉线了"。

## 二、源码证据（NapCat 4.18.42）

| 位置 | 证据 |
|---|---|
| `packages/napcat-core/helper/offline-recovery.ts` | `kickedDelayMs=3500`、`selfOfflineDelayMs=60000`，静默离线先给 60 秒自恢复机会，再重启 |
| `packages/napcat-shell/base.ts` | `on('KickedOffLine', tips => handleOffline(tips,false))`、`on('SelfOffline', ...)`；`restart` 调 `requestRestartProcess()` |
| `packages/napcat-shell/napcat.ts` | `restartWorker()` 第 5 步注释写明：**"启动新进程（重启模式不传递快速登录参数，传递密钥和端口）"** → `startWorker(false, ...)` |
| `packages/napcat-shell/napcat.ts` | Worker 异常退出 > 3 次 / 10 秒 → 主进程 `process.exit(1)`（整进程退出） |
| `packages/napcat-webui-backend/index.ts` | 自动登录顺序：`NAPCAT_QUICK_ACCOUNT` → WebUI `autoLoginAccount` → `NAPCAT_QUICK_PASSWORD(_MD5)` 回退 |
| 构建产物 `napcat.mjs` | 已内联 `createOfflineRecovery` 与 `SelfOffline` 处理（新版**确实**有自动恢复，老版 4.8.x 没有） |

## 三、本次修复项

1. **换用最新的 macOS 安装路径**：镜像实例 + 官方入口注入（见 `launcher/start-parallel.sh`）。
   旧目录 `Documents/napcat` 里的 4.8.94 是 **Windows 版包**，已整体备份到 `Documents/napcat-old-20261112`。
2. **`config/.env` 设置 `NAPCAT_QUICK_ACCOUNT=1000000001`**：让任何时机的快速登录都拿得到账号（覆盖 Worker 重启不传 `-q` 的断点）。
3. **`NAPCAT_DISABLE_MULTIPROCESSING=1`**：关闭 NapCat 自己的多进程 Worker，避免它"重启 Workers 时丢参数"和"10 秒 3 次崩溃就整进程退出"这两条路径；
   改由我们自己的看护（`monitor-daemon.sh`）单进程托管，控制权在 harness 侧。
4. **独立看护进程** `monitor-daemon.sh`：NapCat 进程没了就拉起；gateway 报告持续离线 > 3 分钟就重启实例。
5. **持续掉线量化**：gateway 每 30 秒探活一次，把在线状态写成时间线，`--report` 可出 uptime 报表。

## 四、验证证据（本次实测）

| 时间 | 事件 | 证据 |
|---|---|---|
| 10:04:56 | 快速登录成功 | 日志 `[NapCat] [WebUi] 自动快速登录成功: 1000000001` |
| 10:06:53 | OneBot 就绪 | `HTTP服务: 127.0.0.1:3000 已启动`、`WebSocket服务: 127.0.0.1:3001 已启动` |
| 10:07:37 | 探活 | `{"ok":true,"online":true,"uin":"1000000001","nickname":"示例bot"}` |
| 10:08:16 → 10:25:04 | 持续在线 | `--report`：`uptimeRatio 100%`、`offlineDrops 0`、`heartbeatBeats 114` |

> **说明**：100% 只代表本次 17 分钟的观察窗口，不等于"长期必不掉线"。要看"新版是否还掉线"，
> 需要让它在真实使用下跑一段时间，再用 `npm run report` 读取 `offlineDrops` 与每次 `outages` 的时长。

## 五、如何自己看掉线情况

```bash
cd ~/Documents/deepseek-harness/default-workspace/qq-bot
node --experimental-strip-types gateway/src/main.ts --report   # uptime / 掉线次数 / 每次掉线时长
cat state/health.json                                          # 当前在线状态（每 30 秒刷新）
tail -f logs/watchdog.log                                      # 看护动作
```

如果掉线仍频繁，按以下顺序定位：

1. `state/outages` 里每次掉线都在：说明是真实的账号侧掉线（被踢/静默离线）→ 看 NapCat 日志里是 `KickedOffLine` 还是 `SelfOffline`。
2. 掉线期间 NapCat 进程还在但 `online=false`：快速登录没成功 → 检查 `.env` 的 `NAPCAT_QUICK_ACCOUNT` 是否被覆盖。
3. NapCat 进程整个消失：被系统回收或崩溃 → 看 `logs/parallel-start.log` 与 `parallel.out.log` 尾部。

## 六、已知边界

- QQ 强制更新后（例如再热更一个次版本），镜像 `QQNapCat.app` 需要重建：删除 `~/Library/Application Support/QQParallel/QQNapCat.app` 后重新运行 `launcher/start-parallel.sh`。
- 协议端属于非官方实现，**无法保证永不触发风控**；本次无法消除账号被封的风险。
- 同一 QQ 号同时只能被一个实例持有登录态：本方案下由 NapCat 实例持有，**日常主 QQ 需要关闭**（或接受它的登录态被 NapCat 接管）。

---

## 七、多实例互抢：登录页「点登录卡死」的根因与治理（2026-11-12 补充）

### 现象
QQ 登录窗口显示账号「示例bot」，点「登录」后界面卡住、无反应。

### 根因
QQ 同一时刻只允许**一个实例**持有某账号的登录态。本次出现的是**两个 NapCat 镜像实例**：

```
10:45:05  手动 start-parallel.sh 启动实例 A(PID 97082)
10:45:09  watchdog 也判断"进程不存在"，再启动实例 B(PID 97106)
          B 启动晚 4 秒 → 登录态已被 A 占用 → B 停在登录页
```

此外，直接打开 `/Applications/QQ.app`（主 QQ）也会与镜像实例抢同一账号，同样表现为登录卡死。

### 治理措施
| 措施 | 实现 | 效果 |
|---|---|---|
| 启动锁 | `start-parallel.sh` 用 `mkdir` 原子锁 + 已有实例检查 | 同一时刻只允许一次启动 |
| 单实例守卫 | `launcher/guard.sh --loop`，每 5 秒检查 | 镜像实例重复时保留**最早启动**那个（它持有登录态），其余结束；有镜像实例时结束主 QQ |
| 开机自启 | LaunchAgent `com.shaorune.qqbot.autostart` | 登录后幂等拉起 守卫 / NapCat / 看护 / gateway |
| 后台常驻 | `nohup ... & disown`（macOS 无 setsid） | 脱离父 shell，不被连带结束 |

### 实测证据
```
[2026-11-12 10:56:27] [guard] 发现 2 个镜像实例, 保留最早启动的 PID=97082
[2026-11-12 10:56:27] [guard] 已结束重复镜像实例 PID=98228
```

### 注意
- 守卫**不做** gateway/看护的去重：`pgrep -f` 会匹配到 `bash -c` 包装进程与守卫自身，据此去重会误杀唯一实例。
  这两者的幂等交给 autostart 脚本的 `running()` 判断与启动锁。

---

## 八、2026-11-12 14:03 真实断连事故复盘

### 时间线
| 时间 | 事件 |
|---|---|
| 14:03:10 | `账号状态变更为离线`（SelfOffline：服务端会话失效，**无任何通知**） |
| 14:04:10 | NapCat 尝试恢复，结果 `{"result":false,"message":"重启功能未初始化"}` |
| 14:04 ~ 14:20 | 账号持续离线 **17 分钟**，但监控一直显示"在线"，无人察觉 |
| 14:20 之后 | 用户察觉，开始排查 |

### 根因一：我关掉了唯一的恢复路径
`.env` 里设了 `NAPCAT_DISABLE_MULTIPROCESSING=1`（本意是规避 Worker 重启丢 `-q` 参数），
副作用是 `WebUiDataRuntime.setRestartProcessCall` 只在 Worker 进程里注册；
单进程模式下没有 Worker，`requestRestartProcess()` 直接返回 **"重启功能未初始化"**，
登录服务无法重建 → 掉线后永远起不来。

**修复**：移除该设置，恢复多进程；用 `NAPCAT_QUICK_ACCOUNT` 补上重启后的自动登录。
登录日志确认恢复有效：`[NapCat] [Fork] Worker进程已登录成功，切换到正常重试策略`。

### 根因二：监控探活永远返回"在线"
`gateway/src/onebot.ts` 原代码：
```ts
const online = status.data?.online === true || login.status === 'ok';
```
`get_login_info` 在账号**离线时依然返回 ok**（它只是查资料），所以 `||` 后半段恒真，
`online` 永远为 true。后果：
- 掉线不写 `alerts.jsonl`
- 看护进程读 `health.json` 看到 `online: true`，不触发重启
- 监控彻底失效

**修复**：只认 `get_status` 的 `online` 字段：
```ts
const online = status.status === 'ok' && status.data?.online === true;
```
回归测试 `tests/probe.ts`（4/4 通过）覆盖离线、无 online 字段等场景。

### 根因三：三方并发拉起实例
看护（`monitor-daemon.sh`）、守卫（`guard.sh`）、LaunchAgent（`qq-bot-autostart.sh`）都会启动实例。
排查过程中反复出现双实例互抢登录态，导致扫码二维码被后启动的实例刷新失效。

**处理**：排查阶段已全部停用；确认稳定后改为**单一入口**启动。
`launcher/start-parallel.sh` 保留原子锁，`guard.sh` 只做 NapCat 重复实例去重。

### 服务端会话残留
实例被强杀后，QQ 服务端仍认为账号在线，表现为 `当前账号(1000000001)已登录,无法重复登录`。
**必须由用户在手机 QQ「登录设备管理」里踢掉该设备**，之后重新扫码登录才能恢复。

---

## 九、自动恢复体系（2026-11-12 落地）

### 设计：单一入口 + 分层恢复
```
LaunchAgent (开机一次, KeepAlive)
        │
        ▼
qq-bot-autostart.sh  ← 唯一入口，只确保下面两个常驻
        ├──► supervisor.sh --loop   ← 唯一的实例管理与恢复执行者
        │       ├─ L1 NapCat 自带：SelfOffline/KickedOffLine → Worker 重启 → 自动快速登录
        │       ├─ L2 进程不存在 → 拉起实例（受 20s 启动冷却保护）
        │       ├─ L3 离线 > 150s → 结束实例 + 清端口 + 重启
        │       └─ L4 gateway 崩溃 → 自动拉起
        └──► gateway（消息收发 + harness 调用）
```

### 关键修复（都来自真实演练暴露的问题）
| 问题 | 根因 | 修复 |
|---|---|---|
| 重启后端口被占 `EADDRINUSE` | 进程处于 `T`（SIGSTOP 冻结）状态，`kill -9` 无效，端口不清 | 先 `SIGCONT` 解冻再 `kill -9`，多轮重试，再 `wait_port_free` |
| 只杀 `Contents/MacOS/QQ` 清不掉端口 | OneBot 端口由 **QQ Helper** 子进程持有 | 主进程清理后，若端口仍在则兜底清理全部 app 进程 |
| 把 Helper 当成"多余实例"杀掉 | `nap_count` 统计全 app 进程（8 个） | 区分 `main_pids`（判断实例数）与 `nap_pids`（兜底清理） |
| 启动瞬间产生双实例 | `pgrep` 有 1~3 秒延迟，两个并发调用都能通过 | `start-parallel.sh` 加 20 秒启动冷却戳 |
| gateway 不被拉起 | `pgrep -f` 匹配到 `bash -c` 包装进程 | `gateway_alive()` 用 `ps -o comm=` 只认 node 进程 |
| supervisor 启动即退出 | `( ... nohup ... & disown )` 子 shell 退出带走进程 | 去掉子 shell 包裹，直接 `nohup ... & disown` |

### 演练结果（均通过）
| 演练 | 操作 | 结果 |
|---|---|---|
| D1 进程消失 | `kill -9` 主进程 | 巡检 45s 内拉起，自动登录，online=true |
| D2 服务僵死 | 冻结全部进程（`SIGSTOP`） | 识别"探活无响应"，解冻+清理+重启，恢复 online |
| D3 gateway 崩溃 | `kill` gateway | supervisor 下轮巡检自动拉起 |
| D4 整机重启 | LaunchAgent `RunAtLoad` | 开机自动拉起全套 |

### 阈值与退避
- 离线 150 秒触发重启
- 连续失败退避：30s → 90s → 300s → 900s，避免疯狂重启触发风控

### 仍然存在的边界（必须知道）
1. **服务端残留会话**：实例被强杀后 QQ 服务端可能仍认为账号在线，表现为 `已登录,无法重复登录`。
   这种情况只能由用户在**手机 QQ「登录设备管理」踢掉设备**，再扫码。自动化到不了这一步。
2. **二维码兜底**：若登录态彻底失效，NapCat 会出二维码等扫码，同样需要人工。
3. 阈值 150 秒内的小抖动靠 NapCat 自带的 60 秒静默自恢复处理，不触发重启。

---

## 十、消除人工兜底（2026-11-12 晚）

目标：把"只能人工处理"的两类场景自动化。

### 场景一：登录态失效需扫码 → **已完全自动化** ✅
配置 `NAPCAT_QUICK_PASSWORD` 后，NapCat 自动走密码回退登录：

```
快速登录失败: 登录态已失效  →  正在密码登录 1000000001  →  自动密码回退登录成功
```

**实测证据（15:45:22）**：手动清空 `auth/login.enc` 的 `loginList`（模拟登录态失效），
重启后 NapCat 自动完成密码登录，`online: True`，**全程无人工**。

凭证优先级（源码 `napcat-webui-backend/index.ts` + `napcat-shell/base.ts`）：
`快速登录 → NAPCAT_QUICK_PASSWORD → 二维码（最后兜底）`

### 场景二：服务端残留会话（`已登录,无法重复登录`）→ **已从源头消除** ✅
关键发现：**残留会话是"强杀进程"直接造成的**，不是独立故障。

实测对比：
| 停止方式 | 结果 |
|---|---|
| `kill -9` 强杀 | 服务端会话残留，下次登录报"无法重复登录"，**必须人工踢设备** |
| `SIGTERM` 优雅退出 | 实例自行注销，**立即重新登录成功**（15:47 实测） |

**修复**：
1. `supervisor.sh` 的 `kill_all_instances` 改为**优先 SIGTERM 优雅退出**（等最多 25 秒），
   强杀降级为"优雅退出超时后的最后手段"，并打日志警告。
2. 离线恢复增加**软恢复优先**：先尝试 NapCat 自带的 Worker 重启（优雅重建登录服务），
   软恢复无效才走硬重启，进一步减少强杀次数。

### 极端场景实测（登录态失效 + 进程冻结）
```
15:59:34  离线 154s 超过阈值 → 重启实例
15:59:34  优雅停止（进程被冻结，超时后强制结束）
16:00:05  拉起 NetCat 实例
16:00:11  协议适配器就绪，开始接收消息
          → online: True
```
**全程无人工介入。**

### 仍无法自动化的极少数情况（如实说明）
| 情况 | 原因 | 发生条件 |
|---|---|---|
| QQ 要求**短信验证码** | 腾讯风控，需真人接收短信 | 异地登录、新设备、频繁登录 |
| **新设备验证** | 同上 | 上述条件 |
| 进程被冻结且优雅退出超时 | 只能强杀，可能残留 | 极少见（系统级卡死） |

这三类都不是"框架选择"能解决的 —— 任何协议端（包括 LLB/Lagrange）都绕不开腾讯的账号风控。
把密码配置好 + 优雅退出后，它们从"必然遇到"降为"极端异常时的极小概率"。
