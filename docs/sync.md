# 局域网同步框架（readerx-sync）

> 状态：**框架已实现，但尚未接入 App 使用**。本文件说明它解决什么问题、怎么用、
> 边界在哪，以及接入 App 时需要做哪些事。

目标：同一个 ReaderX 的两台设备（手机 + 桌面）在**同一局域网内直接互相同步**，
不需要云服务、不需要账号体系。实现住在 `src-tauri/crates/readerx-sync`，
**不依赖 Tauri / GUI**，与 `readerx-source` / `readerx-log` 同样是可独立编译的 crate。

```text
cargo test -p readerx-sync                          # 单元 / 集成测试
cargo build -p readerx-sync --features cli          # 独立命令行运行器
```

---

## 1. 核心问题与结论

两台设备各自离线改数据，联网后互相推送。核心不是「谁的更新覆盖谁」，而是：

1. **先判断两次更新是否并发**（版本向量），再按数据类型语义合并；
2. 不能自动合并的**进冲突队列**，人/业务规则事后处理——**不静默丢数据**。

落地的组合是：

> **全局唯一 id + 操作日志 + 版本向量（判并发）+ HLC（排序与裁决）+
> 字段级合并 + 墓碑删除 + 冲突队列表 + 版本向量增量同步。**

各机制解决的具体毛病：

| 机制 | 不做会怎样 |
| --- | --- |
| ULID（`id`） | 两台设备各自新增记录时主键撞车 |
| 操作日志（`model::Operation`） | 只看最终值无法判断「改的时候看到了什么」，并发检测无从谈起 |
| 版本向量（`version`） | 只能靠时间戳猜先后，「并发」与「顺序」分不开 |
| HLC（`hlc`） | 设备时钟不准 / 回拨会让新写入被判成旧值而丢失 |
| 字段级合并（`merge`） | 甲改书名、乙改简介被当成冲突 |
| 冲突队列（`model::Conflict`） | 败方数据被覆盖后无处可查 |
| 墓碑（`model::Tombstone`） | 删除与并发更新无法比较，离线设备会把已删记录加回来 |
| op_id 去重 | 网络重试导致同一次修改被应用两次（计数器尤其致命） |
| 版本向量增量同步（`session`） | 每次全量传输；断点续传与中继都要额外记账 |

---

## 2. 数据模型

```text
Operation   追加型日志，同步与重放的唯一真相
  op_id / origin / seq            全局唯一 id + 来源设备与设备内序号
  hlc                             混合逻辑时钟（排序、LWW 裁决）
  entity_id / kind / field        作用对象
  op                              Create / Set / Unset / Increment / Add / Remove / Move / DeleteEntity / RestoreEntity
  base                            作者写入时看到的实体版本 ← 判断并发的关键
  schema_ver                      写入时的 schema 版本

Entity      由操作重放出来的物化视图
  fields       字段名 → FieldState（Value / Multi / Frozen / Counter / Set / List）
  version      已并入的操作（origin → 最大序号）
  deleted      墓碑（hlc + 来源 + 删除者看到的版本）
  conflicted   待裁决字段

Conflict    冲突记录：原因、双方取值与时间、状态、裁决写下的操作 id
```

字段级状态与合并语义（schema 按实体类型声明，未声明字段一律 LWW）：

| `MergeKind` | 语义 | 并发时的结果 | 进冲突队列 |
| --- | --- | --- | --- |
| `Lww` | 单值，HLC 全序最后写入者胜出 | 选边，败方留档 | **是** |
| `MultiValue` | 并发值全部保留（MV-Register） | 多值并存 | **是** |
| `Frozen` | 不可变（创建时写入一次） | 保留首次写入 | **是** |
| `Counter` | PN-Counter | 增量相加 | 否（语义确定） |
| `Set` | OR-Set（`add_wins` / `remove_wins`） | 按策略 | 否（语义确定） |
| `List` | 位置键（分数索引）有序列表 | 两个插入都保留，按 `(位置键, 元素 id)` 排序 | 仅「并发移动同一元素」记一条 |

「进冲突队列」**不等于合并失败**：数据先按确定语义合并（保证各副本收敛），
冲突记录把被覆盖的那一方原样留档，人能看见、能改回来。
**已被后续写入了结**的冲突会自动关闭（甲裁决后同步给乙，乙队列里的旧冲突随之消失）。

---

## 3. 同步流程

```text
本地写：生成 op（base = 实体当前版本）→ 先写 oplog.jsonl（fsync）→ 并进内存实体

收到远端 op：
  去重（op_id 见过就跳过）
    → schema 版本比本机新？进缓冲
    → 因果就绪？(entity.version ⊇ op.base) 否则进缓冲，等前序操作
    → merge（字段策略裁决 + 冲突留档）
    → 记进实体版本向量、推进本地 HLC、追加日志
```

一次同步（`session::sync_with`）是**双向**的：

```text
1. 拉：把我的版本向量发给对端 → 对端回「我有而你没有」的操作 → 合并（可能多轮）
2. 推：对端在应答里带上它的版本向量 → 我算出「它有而我没有」的操作 → 分批推送
3. 记录对端状态（地址 / 上次同步 / 对方已知版本）并落盘
```

用版本向量求差（而不是「已发送队列」）带来三个性质：**断点续传**（重启后差集重算）、
**中继**（A 的操作经 B 传到 C，C 的向量里有 A 的进度）、**幂等**（重复发也没事）。

因果就绪是 merge 的前提（`entity.version ⊇ op.base`）。有了它，
「对方有没有见过我这次写入」可以只看 `op.base` 里有没有我的 stamp，
于是「两次写入是否并发」不需要再存每字段的基线向量。局域网里操作乱序到达很常见，
所以缓冲是常规路径，不是异常路径。

---

## 4. 数据目录与文件

```text
<data_dir>/
  device.json      设备身份：设备 id、名称、群组 id、群组密钥（配对码）
  clock.json       HLC 进度（重启后不能从 0 重新计数）
  oplog.jsonl      操作日志：一行一条 Operation（追加 + fsync，唯一真相）
  entities.json    实体快照（物化视图）+ 快照覆盖到的日志行数
  conflicts.json   冲突队列
  deferred.json    因果缓冲
  peers.json       已知对端：地址、上次同步、我们认为对方已有的版本
  .lock            目录锁（见下）
```

- **崩溃安全**：操作先落盘并 fsync；快照 / 冲突队列是「可重建的派生数据」，
  用「临时文件 + rename」原子替换。即使快照没来得及写，重启时会按
  `applied_ops` 与日志行数之差**重放尾部**。
- **格式版本**：每个文件带 `format`。读到比本程序新的版本会直接报错
  （`SyncError::Unsupported`），而不是按旧语义写坏新数据；旧版本走 `store::migrate`。
- **目录锁**：一个数据目录同一时刻只允许**一个写者**。第二个进程打开会被拒绝
  （`已被另一个进程（pid …）打开`），避免两边各有一份内存视图、互相覆盖快照而**静默分叉**。
  进程被强杀可能留下残留锁：Linux / Android 用 `/proc/<pid>` 判断存活并自动接管；
  其它平台保守拒绝，可用 `--force-unlock`（CLI）显式接管。
  **只读打开**（CLI 的 `status` / `ls` / `show` / `ops` / `conflicts`）不抢锁：
  同步服务在跑时依然可以查看数据（读快照 + 重放日志尾部即可得到最新视图）。
- **操作日志只增不减**：删掉旧操作会让落后的对端永远补不齐。
  需要控制体积时应引入「快照传输模式」（把实体状态作为基线发给对端），
  而不是清理日志；这一点当前**没有实现**，属于已知取舍。

---

## 5. 局域网传输

传输抽象是 `net::Transport`，同步语义只依赖它；当前实现两种：

- `net::TcpTransport`（真局域网）与 `net::PeerServer`（监听端）；
- `net::LoopbackTransport`（进程内直连：测试、同机两个数据目录自测）。

握手（HMAC-SHA256，密钥 = 群组密钥）：

```text
客户端 → Hello{protocol, group, device, name, knowledge, nonce_c}
服务端 → Hello{ok, protocol, group, device, name, nonce_s}      ← 校验协议 / 群组 / 信任名单
客户端 → Auth{proof = HMAC(secret, 文本(client))}
服务端 → Auth{ok, proof = HMAC(secret, 文本(server))}           ← 双向认证
之后每帧：Envelope{seq, mac}，MAC 覆盖 (seq ‖ 规范化 JSON)，seq 必须严格递增
```

- 请求：`Pull{since, limit}` / `Push{ops}` / `Stat` / `Ping`；
- 分帧：`[u32 大端长度][JSON]`，握手阶段上限 64 KiB、业务帧 8 MiB；
- 发现：UDP **查询 / 应答**（`net::discovery`），广播报文同样带 HMAC，
  **只回应本群组的查询**——陌生设备连「这里有一台 ReaderX」都探不到；
  同一台设备从多个网卡应答时优先记住回环地址。

**安全边界（明确取舍）**：信任单位是「群组密钥」（配对码）。
持有配对码即可同步该群组数据；**载荷不加密**（局域网内视为同一信任域），
设备名与实体数据对同网段的被动监听者可见。需要更强保护时应换 AEAD / TLS，
而不是在这里加字段。凭据（密钥）永不进日志。

---

## 6. 独立命令行运行器

不启动 App 也能在两台机器上跑通（`--features cli`）：

```bash
# 设备 A（手机）
readerx-sync --data-dir /data/a init --name 手机
readerx-sync --data-dir /data/a pairing            # 把配对码抄到设备 B
readerx-sync --data-dir /data/a create book --set 'title=三体' --set 'tags=["科幻"]'

# 设备 B（桌面机）
readerx-sync --data-dir /data/b init --name 台式机 --join '<配对码>'
readerx-sync --data-dir /data/b serve              # 前台运行（Ctrl+C 退出）

# 回到设备 A：发现并同步
readerx-sync --data-dir /data/a discover
readerx-sync --data-dir /data/a sync auto
readerx-sync --data-dir /data/a conflicts          # 看冲突队列
readerx-sync --data-dir /data/a resolve <id> --keep local|remote
```

其余命令：`status` / `ls` / `show` / `ops` / `set` / `unset` / `incr` /
`add` / `rm` / `move` / `delete` / `restore`；`--json` 输出机器可读结果，
`--verbose` 把日志打到标准错误。完整用法见 `readerx-sync --help`。

---

## 7. 接入 App 需要做什么（当前**没有**做）

1. **注册 schema**：`SchemaRegistry::readerx_defaults()` 已经给出书 / 阅读进度 /
   书签 / 分组 / 书架顺序 / 设置 / 书源的默认策略，接入时按需增删。
   注：**书籍正文、封面、听书缓存不进同步**——局域网里搬几百兆文件不是同步该干的事；
   同步的是「哪本书、元信息是什么、读到哪」。
2. **把本地写路径改成写操作**：`book_store.rs` 里改书名 / 进度 / 书签的地方，
   改成调用 `SyncEngine` 的 `set_field` / `add_element` / `delete_entity` 等，
   再由引擎落盘（而不是两边各写一份）。
3. **数据目录**：用 App 的应用数据目录调用 `SyncEngine::open(<dir>/sync, …)`，
   与现有 `state/`、`books/` 并存；目录锁与单实例插件共同保证只有一个写者。
4. **命令层**：新增 `sync_status` / `sync_pair` / `sync_peers` / `sync_now` /
   `sync_conflicts` / `sync_resolve` 等 Tauri command（需在 `lib.rs` 的
   `invoke_handler` 注册，并按需加 capabilities），页面挂在设置页下。
5. **后台服务**：`PeerServer` + `DiscoveryService` 在 App 启动时拉起（可配置开关），
   生命周期跟随后台任务，退出时 `shutdown()`。
6. **界面**：冲突队列需要一个入口（徽标 + 列表 + 「保留本地 / 采用对端 / 手动填写」），
   这是「不静默丢数据」承诺的兑现处。
7. **凭据存储**：配对码（群组密钥）目前与设备身份同放在 `device.json`；
   若要接入系统密钥库，改 `SyncStore` 一处即可。

接入前建议先跑一遍 CLI 双设备流程（第 6 节），确认冲突语义符合业务预期。

---

## 8. 覆盖的场景与已知边界

已实现并有测试覆盖：并发改不同实体 / 不同字段、同字段同值、同字段异值（LWW + 留档）、
集合增删（add-wins / remove-wins）、计数器并发、列表并发插入与移动、
删除 vs 更新（`DeleteWins` / `UpdateWins` / `Manual`）、双方都删、删除后恢复、
不可变字段改写、唯一键冲突、级联删除（级联 / 阻止 / 孤儿）、乱序到达（因果缓冲）、
重复提交（op_id 去重）、时钟不准与回拨（HLC）、schema 版本较新（缓冲）、
多租户隔离（群组）、断点续传（版本向量）、中继（A→B→C）、跨进程写者冲突（目录锁）。

**明确的边界**（不要指望框架做这些）：

- **富文本协同编辑**：需要 Yjs / Automerge 这类 CRDT；这里只提供有序列表的
  位置键方案（重复插到最前会在用尽首位空间后退化为「追加到末尾」，见 `order.rs`）。
- **强一致业务**（金额、库存、权限）：P2P 没有权威方，这类数据应走服务端事务或单写者
  设计，不要交给自动合并。
- **二进制大对象**：正文 / 封面 / 音频不在同步范围（只同步元信息与引用）。
- **端到端加密**：载荷不加密（见第 5 节）。
- **日志压缩**：操作日志只增不减（见第 4 节）。
- **自动定时同步**：框架提供一次同步的入口，调度（前台 / 定时 / 网络变化触发）
  由接入方决定。
