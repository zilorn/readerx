# 书源引擎独立二进制（readerx-source）

不启动 App，直接跑书源规则：离线调试、批量验证站点、带登录态 / 浏览器 Cookie 复现线上问题。

引擎与 App **是同一份代码**（`src-tauri/crates/readerx-source` 的 `engine` / `host`），
所以这里跑通的结果与 App 内书源编辑页的「测试」面板一致——差别只在于宿主能力：

| 能力 | App | readerx-source |
| --- | --- | --- |
| Boa 引擎 / `http` / `html` / `util` / `base64` / `cryptoUtil` / `console` | ✅ | ✅ |
| 书源文件与登录 Cookie 目录 | 应用数据目录 | `--data-dir`（可与 App 指向同一目录） |
| 网页登录 / 自动过 Cloudflare | Android 应用内 WebView | `auth webkit`（本机 WebKit 内核）/ `auth cdp`（连已有 Chrome） |
| 章节插图落盘 / `readerx-img` 协议 | ✅ | ❌（CLI 只跑规则，不涉及阅读排版） |

## 构建

```bash
# 只要引擎（不含浏览器认证后端，不需要 webkit2gtk 开发包）
cargo build --release -p readerx-source --features cli --no-default-features

# 完整版（含 webkit 内核认证；Linux 需要 webkit2gtk-4.1 与 gtk3 开发包）
cargo build --release -p readerx-source --features "cli webkit"
# 产物：src-tauri/target/release/readerx-source
```

## 命令一览

```text
readerx-source [全局参数] <命令> [命令参数]

sources                          列出已安装书源
call   <函数> [参数JSON]          调用一个书源入口函数
run    <关键词>                   端到端：搜索 → 目录 → 正文
test                             冒烟测试：结构 / JS 语法 / 入口函数 / 能力开关
auth   cookie|webkit|cdp|show|clear
login  <url>                     等价 auth webkit --url <url>
```

全局参数在子命令**前后都能写**（`--source demo call …` 与 `call --source demo …` 等价）：

| 参数 | 说明 |
| --- | --- |
| `--source <文件\|id\|名称>` | 书源：JSON 文件（含导出包）或已安装书源 |
| `--data-dir <目录>` | 数据目录（书源 + 登录态）；默认 `$READERX_SOURCE_HOME` / `~/.local/share/readerx-source` |
| `--profile <文件>` | 浏览器身份 JSON（UA / 请求头 / Cookie） |
| `--ua <字符串>` | 覆盖 User-Agent |
| `--header '<K: V>'` | 追加 / 覆盖默认请求头（可重复） |
| `--cookie '<k=v; …>'` | 追加整行 Cookie（无域名作用域） |
| `--cookie-file <文件>` | 导入浏览器 Cookie（Netscape / JSON / Cookie 头文本） |
| `--auth <backend>` | `auto`（默认）/ `webkit` / `cdp` / `none` |
| `--cdp <url>` | Chrome DevTools 地址，默认 `http://127.0.0.1:9222` |
| `--browser <路径>` | 拉起浏览器可执行文件（未开调试端口时） |
| `--timeout <秒>` / `--concurrency <n>` / `--chapters <n>` | 调用预算 / 正文并发 / run 拉几章 |
| `--json` / `--verbose` | 机器可读输出 / 打印书源 `console` 日志 |

退出码：`0` 成功、`1` 书源调用失败或认证未完成、`2` 参数或环境错误。

## 典型用法

```bash
# 1) 离线检查一个还没导入的书源文件（不联网）
readerx-source --source ./my-source.json test

# 2) 搜索一次，看返回结构与日志
readerx-source --source ./my-source.json call searchBook '["剑来"]' --verbose

# 3) 端到端跑一本：搜索 → 目录 → 前 3 章正文
readerx-source --source ./my-source.json run 剑来 --chapters 3

# 4) 直接跑 App 里已安装的书源（指向 App 的数据目录）
readerx-source --data-dir ~/.local/share/com.zilorn.readerx --source 笔趣阁 sources
readerx-source --data-dir ~/.local/share/com.zilorn.readerx --source 笔趣阁 run 剑来

# 5) 机器可读输出（断言 / 二次处理）
readerx-source --source ./my-source.json call searchBook '["剑来"]' --json | jq '.value[0]'
```

`run` 的搜索零结果**不算失败**（与 App 发现页一致）：只有规则抛错或参数非法才非零退出。

## 登录态与 Cloudflare

`cf_clearance` 与 **IP + UA + TLS 指纹**绑定，纯 HTTP 客户端拿不到；CLI 提供三条路：

### 1) 导入浏览器 Cookie（最快，适合已有登录态）

```bash
# Netscape cookies.txt（curl / yt-dlp / 导出插件）
readerx-source --source demo auth cookie --cookie-file ~/cookies.txt
# EditThisCookie / Cookie-Editor 的 JSON，或 Playwright storageState
readerx-source --source demo auth cookie --cookie-file ~/cookies.json
# 直接从 DevTools 复制请求头
readerx-source --source demo auth cookie --cookie 'session=abc; token=xyz'
```

带域名信息的 Cookie 存在 `<data-dir>/profiles/<源id>.json`，**按请求域名逐条筛选**后发送；
无域名信息的整行 Cookie 写进 `<data-dir>/source_sessions/<源id>.json`（与 App 同格式，
App 里也会自动带上）。导入时默认**只保留书源站点**（host 及其父域）的 Cookie——浏览器导出的
文件里往往有几百条别的站点 Cookie，整份塞进一个书源既无用又容易误发；`--url <地址>` 可换站点，
`--url ''` 表示整份都收（`--verbose` 会打印过滤了多少条）。查看当前会带上什么：

```bash
readerx-source --source demo auth show
```

### 2) 本机 WebKit 内核过挑战（与 App 同内核）

```bash
readerx-source --source demo auth webkit --wait 180     # 打开窗口，人工过验证后点「完成」
xvfb-run -a readerx-source --source demo auth webkit   # 无头机器
```

认证成功后 Cookie（含 httpOnly 的 `cf_clearance`）保存为该源登录态，后续 `call` / `run`
自动携带。**UA 要与书源一致**：`--ua` 或身份文件里的 `userAgent` 会同时用于认证窗口。

### 3) 连已有 Chrome（DevTools Protocol）

```bash
# 已在跑的 Chrome（先带 --remote-debugging-port=9222 启动）
readerx-source --source demo auth cdp --cdp http://127.0.0.1:9222
# 让本工具拉起浏览器（独立用户数据目录，不动系统配置）
readerx-source --source demo auth cdp --browser /usr/bin/google-chrome
```

在浏览器里完成登录 / 人机验证后**按回车**即取回该站点 Cookie；非交互环境下等待约 8 秒后
自动取当前 Cookie。

### 清理

```bash
readerx-source --source demo auth clear             # 清空登录态文件
readerx-source --source demo auth clear --clear-cookies  # 同时清空本次会话的 Cookie
```

## 身份文件（profile）

`--profile` 指向一个 JSON，把「浏览器标志信息」一次给全：

```json
{
  "name": "手机 Chrome",
  "userAgent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "headers": { "Referer": "https://example.com/", "Accept-Language": "zh-CN,zh;q=0.9" },
  "cookies": [
    { "name": "cf_clearance", "value": "…", "domain": ".example.com", "path": "/", "secure": true, "expirationDate": 4102444800 }
  ],
  "authUrl": "https://example.com/login"
}
```

- `headers` 也接受数组写法 `[["Referer", "…"]]`；
- `cookies` 字段与浏览器导出的 JSON 同构（大小写两种键名都认）；
- 命令行参数**覆盖**身份文件里的同名字段（Cookie 与请求头为追加 / 同名覆盖）；
- `authUrl` 是 `auth webkit` / `auth cdp` 的默认打开地址（缺省用书源的 `bookSourceUrl`）。

## 排查建议

- **搜索 0 条但书源不报错**：多为挑选器与站点结构不匹配，用 `--verbose` 看书源自己的
  `console.log`，或先 `call discoverBooks` 从列表页验证挑选器。
- **相对地址拼出来 404**：`util.urlJoin` 保留末尾斜杠（`/book/1/` ≠ `/book/1`）；
  若站点用 `<base>` 或跳转，先 `console.log(url)` 核对真实地址。
- **403 / 人机挑战**：`auth show` 看当前带上的 Cookie；挑战页会被引擎标成
  `cf.auto = disabled / unsupported / cooldown / cancelled / stale`（见 [cloudflare.md](./cloudflare.md)）。
- **TLS 指纹**：`cf_clearance` 仍被拒（`cf.auto = "stale"`）通常是 TLS 指纹与浏览器不一致——
  这正是「导入真实浏览器 Cookie / 用真实内核认证」两条路存在的原因；若仍失败，改用
  `--auth cdp` 让请求与认证出自同一浏览器环境。
