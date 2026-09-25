# 日志与排障

ReaderX 的日志只有一个出口：Rust 侧的 `readerx-log`（`src-tauri/crates/readerx-log`）。
App、书源引擎（`readerx-source`）、独立二进制 `readerx-source`、以及 WebView 里的前端，
写出来的记录都进同一套日志文件 —— 同一次运行的前后端记录交织在一份文件里，
用户报问题时一份文件就能看全前后端。

## 日志在哪

| 运行形态                         | 日志文件                                                             |
| -------------------------------- | -------------------------------------------------------------------- |
| App（Android / Linux / Windows） | `<应用数据目录>/logs/<日期>/readerx-<时刻>.log`                  |
| 独立二进制 `readerx-source`      | `<数据目录>/logs/<日期>/readerx-source-<时刻>.log`               |

独立二进制的数据目录来自 `--data-dir`（或 `READERX_DATA_DIR`），未指定时为 `~/.local/share/readerx-source/`。
应用数据目录按平台由 Tauri 决定（Linux 通常为 `~/.local/share/<bundle id>`，Android 在应用私有目录下）。
在应用内看日志不必去找文件：**设置 → 调试 → 应用日志**，可直接按级别筛选、切换文件、复制与清空。

## 文件怎么分

**一天一个目录、一次启动一个文件**：

```text
<数据目录>/logs/
  2026-09-26/                  本地日期
    readerx-091502.log         这份文件从 09:15:02 开始写：现在正在写
    readerx-091502.log.1       同一次运行内写满 2 MB 后轮转（数字越大越旧）
    readerx-081233.log         同一天更早的一次启动
  2026-09-25/
    readerx-215530.log
```

日期在目录名上、时刻在文件名上：路径本身就是排序键，看日志的人先关心「哪天」，
再关心「哪一次启动」。文件名里的时刻是**这一份文件开始写的时刻**（不跨天时就是启动时刻），
跨天时会接着开新目录、新文件（挂在后台过零点的长进程也一样），
而每条记录落在哪一天由它自己的本地时间决定，不会出现「记录写着 25 日、文件在 26 日」的错位。

保留与轮转：

- 单文件超过 **2 MB** 在本次运行内轮转一次（`.log` → `.log.1` → `.log.2`），
  同一次运行最多留 **3** 份历史；
- 每个应用各自保留最近 **7 天**（含今天），并且它自己的日志总量不超过 **32 MB** ——
  超了从最旧的开始删。详细级别下一天能写出几十兆，只按天淘汰挡不住这种量；
  这两条在每次启动与跨天时检查一次，因此检查之间可能短暂超出一点；
- 正在写的这一份永远不会被淘汰。

（`logs/` 目录由 App 与独立二进制共用，但两边的日志各算各的：App 只清理 `readerx-*`，
CLI 只清理 `readerx-source-*`，谁都不会去动对方的文件。）

升级安装（旧版本日志是扁平的 `logs/readerx.log`）后的首次启动会把老文件**按修改时间**
搬进对应的日期目录，之后与其它日志一样受保留策略约束；搬不动的（权限、那一天同一秒已有
同名日志）会留在原处，下次启动再试——「清空日志」也会把它一起删掉。

## 看日志

```
2026-09-25 15:04:05.123 INFO  readerx_source::host: http GET https://example.com/api?token=*** → 200 12.3 KB 480 ms
```

固定列：本地时间（含毫秒） · 级别（5 字符宽） · 记录来源（target） · 正文。
多行消息的续行以 4 空格缩进，因此「一行一条记录」的列结构不会被破坏。
target 是排错时最有用的一列：`readerx::storage` 是本地书库，`readerx_source::host` 是书源请求层，
`web` 是前端（正文里的 `[模块名]` 是前端各模块自己的 scope）。

## 级别

| 级别    | 什么时候用                                                            |
| ------- | --------------------------------------------------------------------- |
| `error` | 不该发生、且用户会看到的异常（未捕获异常、引擎执行失败）              |
| `warn`  | 可恢复的失败 / 降级（单章拉取失败、图片下载失败、读取失败退回默认值） |
| `info`  | 用户可感知的完整动作（导入一本书、一批章节拉完、登录结束、应用启动）  |
| `debug` | 细节（每个 HTTP 请求、每章拉取、每次会话创建）                        |
| `trace` | 目前仅在按模块单独开启时使用                                          |

默认级别：release 为 `info`，debug 构建为 `debug`。

### 在应用里切换

**设置 → 调试 → 应用日志 → 级别**：

- **常规**（`info`）：默认，只记用户动作与失败；
- **详细**（`debug`）：连每个请求 / 每章拉取都记，让用户复现一次就能拿到完整链路。

选择会存进 `readerx.logLevel`，重启后仍生效；前端的最低级别跟着一起放开
（否则 WebView 侧的 `debug` 根本不会回传）。

### 环境变量与过滤规则

`READERX_LOG` 覆盖一切（含界面上的选择），排障时不用改配置：

```bash
READERX_LOG=debug pnpm tauri dev          # 全开
READERX_LOG=info,readerx_source=debug     # 只让书源引擎记详单
READERX_LOG=off                           # 全关
```

规格语法：逗号分隔，`级别` 或 `target=级别`；target 按 `::` 分段前缀匹配，最长前缀优先，
不带级别的 target 视为该模块 `trace`。级别名支持 `off/error/warn/info/debug/trace`。

## 代码里怎么写

**Rust**（App、引擎、CLI 都是同一套）：

```rust
log::info!("书籍导入完成 format={format} chapters={n} 耗时={}ms", started.elapsed().as_millis());
log::warn!("章节拉取失败 chapter={title}: {error}");
```

**前端**（`src/lib/logger.ts`）：

```ts
const log = createLogger("books"); // scope 会写进每条记录：[books] …
log.info("书籍导入完成", { format, chapters, n, ms });
log.warn("章节拉取失败", error);
```

前端记录经 `readerx_log_write` 攒批回传（400 ms 一批、最多 200 条待发，发不出去就丢），
**永远不会阻塞界面**；纯浏览器开发环境没有后端，只输出控制台。

日志点怎么选：一个动作出问题时，日志里必须能还原「谁在什么时候、对什么、做了什么、结果如何」。
系统命令入口（`src-tauri/src/commands.rs` 的 `blocking`）已经统一记了成功耗时与失败原因，
所以业务代码只需补**内部**事件（迁移、淘汰、解析失败、降级分支）。

## 什么绝不能写进日志

日志会被用户复制、贴进 issue、上传到公开仓库，**泄了收不回来**：

- Cookie、token、密码、Authorization / 请求头取值、localStorage / sessionStorage / IndexedDB 快照内容；
- 书籍正文、章节文本、剪贴板内容。

凭据只记**数量**或长度；URL 用 `readerx_log::redact::url()`（去掉 `user:pass@`、
把 `token` / `sign` / `password` 等查询参数的值换成 `***`），敏感值用 `redact::secret()`
（只留前 4 个字符与总长度）。书籍标题、章节名、搜索关键词、书源 id、地址属于排错必需，可以记。

## 排障流程

1. 设置 → 调试 → 应用日志 → 级别切到**详细**；
2. 让用户复现一次问题；
3. 回到应用日志 → 按「警告 / 错误」筛选，或直接**复制**整段日志；
   界面顶部默认显示**本次运行正在写的那一份**，左边一行文件选择器可以切到更早的文件
   （`09-26 09:15:02` 这样的标签是那一份文件开始写的时刻，注有「本次」的是当前这一份）；
4. 排障结束后切回**常规**（详细日志增长快得多）。

崩溃现场：Rust 的 panic hook 会先写一条 `ERROR`（含文件:行:列）再弹出提示条，
因此闪退 / 内部异常在日志文件里一定有对应记录。App 崩溃重启后，崩溃那一次的日志是
文件选择器里的上一份（不是「本次」那一份）。Android 上还可以实时看：

```bash
adb logcat -s readerx        # App 的实时日志（logcat 目标）
```

## 相关代码

| 位置                                                             | 作用                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src-tauri/crates/readerx-log/src/layout.rs`                     | 目录布局与文件命名（日期目录、`<app>-<时刻>.log`、轮转序号）               |
| `src-tauri/crates/readerx-log/src/file.rs`                       | 文件目标：跨天换文件、按体积轮转、`FileLimits`（体积 / 份数 / 天数 / 总量） |
| `src-tauri/crates/readerx-log/src/retention.rs`                  | 目录扫描、保留策略淘汰、旧版扁平日志迁移、运行列表                          |
| `src-tauri/crates/readerx-log/src/read.rs`                       | 读一份日志（主文件 + 轮转备份、级别过滤、续行跟随记录）                     |
| `src-tauri/crates/readerx-log/src/{lib,filter,record,redact}.rs` | logger 本体与级别过滤、行格式化、脱敏                                       |
| `src-tauri/src/logging.rs`                                       | App 侧接线：数据目录、用户级别偏好、前端读写日志的 command                  |
| `src-tauri/src/lib.rs`                                           | 启动顺序（先装日志再装 panic hook）与 panic hook                            |
| `src-tauri/crates/readerx-source/src/bin/readerx_source/main.rs` | 独立二进制的日志初始化（`--verbose` = 详细）                                |
| `src/lib/logger.ts`                                              | 前端日志入口（scope、级别、回传）                                           |
| `src/lib/logs.ts` / `src/components/LogSheet.tsx`                | 「设置 → 调试 → 应用日志」查看器（含文件选择器）                            |

独立二进制的 `--verbose` 除了打印书源 `console` 日志，也会把日志级别切到 `debug`；
日志文件与 App 同规则（见上表），因此「App 里出的问题，用 CLI 带同一份数据目录复现」
时两边记录能对上。
