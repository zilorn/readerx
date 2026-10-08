# 书籍数据存储

书籍数据保存在 `storage::data_root` 指定的应用数据根目录下的 `books.sqlite3`。
前端仍通过原有 `readerx_book_*`、`readerx_bookmarks_*`、`readerx_annotations_*`
command 访问，数据形状和同步协议不变。

## 数据边界

| 数据 | 存储位置 |
| --- | --- |
| 元信息（含封面字段） | SQLite `books`，按书籍 ID 一行 |
| 章节正文、目录、字数、同步指纹和图片引用名 | SQLite `chapters`，按书籍 ID 和章节顺序一行，cid 建索引 |
| 书签、段落注释 | SQLite `bookmarks` / `annotations`，记录原样保存 |
| 书架进度 | SQLite `books.detail.progress`，随书籍元信息保存 |
| 书架 / 书源分组 | SQLite `groups`，按集合 key 和顺序逐项保存 |
| 文本替换 / 分章规则 | SQLite `rules`，按集合 key 和顺序逐项保存 |
| 偏好、阅读时长等其他状态 | 原有 `state/<key>.json` |
| 书源与登录态 | 原有 `book_sources/`、`source_sessions/` |
| TTS 缓存 | 原有 `tts-audio/<book_id>/` |
| 章节插图 / PDF 页面图的字节 | 原有 `images/`；数据库只存引用名 |

元信息和章内结构以 JSON 列保留现有字段形状，但数据库按书 / 章分别存行。
列表分别查询元信息和预计算的章节头，每本元信息只读一次，不扫描正文或按章重复读取封面。
按 cid 读取或回写只操作命中的章节，目录标题 / 地址保持当前值；旧 index 仅为兼容提示。
历史空或重复 cid 可以迁入，存在多个命中时正文补丁明确失败，避免错写。

## 事务与迁移

`book_store` 保留进程级书库锁，不持锁调用同步引擎。SQLite 启用外键和
`FULL` 同步，整书替换、正文批次与其指纹 / 图片引用、目录修改均由事务提交。
删书通过外键级联删除章节、书签和注释；图片继续检查其他书的引用后再清理。
数据库由每次操作按当前数据根打开，不把测试或同步夹具的另一份数据根混入本机。
数据库格式使用 `PRAGMA user_version=2`（自动升级 v1），拒绝更高版本。

首次访问逐本导入旧 `books/<id>/` 和 `books/<id>.json`，同时处理旧全库书签。
每本书先完整读取并校验，再在一个事务中提交元信息、正文、书签、注释及迁移回执。
旧 `digest.json` 不作为权威数据，章节指纹按正文重算。
成功后书籍 JSON 改名为 `.json.migrated` 留底；失败保留原文件，读路径仍可回退，
其他书照常迁移，后续访问可重试。文件归档中断时，事务内保存的回执阻止旧数据覆盖
数据库中的新编辑。已有同名留底文件不被覆盖。
尚未迁入的书籍拒绝同步写入并返回失败，让同步保留待落库数据，避免当作已删书跳过更新。

分组、书源分组、文本替换、分章规则和旧书架状态首次通过状态入口或备份访问时迁入数据库，
每个集合与迁移回执在同一事务提交，成功后将原 JSON 改名留底；失败保留原文件并返回错误。
书架接口仍返回按书籍 ID 索引的进度视图，实际只更新有变化的 `books.detail.progress`。
整书保存和元信息补丁保留进度；删除书籍同时删除进度。初始化只补缺项，重置在后端更新已有记录。
`collections` 区分空集合与不存在的集合；`migrated_states` 防止归档中断后重复导入覆盖新编辑。

旧身份迁移待办继续使用可重跑日志；数据库书籍改 ID 在事务内级联更新，
书签中的 bookId 随之更新。进度中的 bookId 同事务更新，规则引用继续通过原身份迁移入口更新；阅读时长及 TTS 目录沿用文件迁移。
分组和书源引用同时更新数据库元信息；书源映射在重命名文件前单独留待办，避免中断丢映射。
损坏的旧元信息使后续引用迁移延后，保留原分组 / 书源及映射，已迁入书籍仍可正常使用。
书源保存继续由共享书源 crate 写文件，App 同步维护数据库中的书源引用。

## 备份与同步

新备份为 `readerx-backup/2`：`book_store::backup_books` 在书库锁内通过
`VACUUM INTO` 生成一致的 `books.sqlite3` 快照，流式压缩进 ZIP。
不复制正在写入的数据库文件，也不导出 WAL / SHM / journal；书源仍为
`book_sources/<id>.json`，分组、规则与进度包含在同一快照中，其他状态与图片按文件导出。
恢复只读打开归档数据库，先校验版本、完整性、引用与逐行数据，再将单书内容适配到
现有 `book_store::import_book_json` 和记录合并入口，不整库覆盖本机数据库。
归档里的迁移回执不导入本机。恢复兼容数据库 v1（旧状态 JSON）与 v2，按原集合合并 / 覆盖语义还原，进度仍按 updatedAt 选择较新记录。仍兼容旧 `readerx-backup/1` JSON 备份，
合并 / 覆盖恢复、旧备份缺失注释清空、书签合并和凭据过滤保持原语义。
快照位于受启动回收管理的 `books/*.tmp`，正常与失败退出均清理。
有尚未完成迁移的旧书籍或数据状态时拒绝导出不完整备份。

同步元信息、目录、正文指纹、按需取章、封面与插图引用全部经 `book_store`。
资源字节仍从文件读取，线上消息与协议版本不变。

## 验证

在 `src-tauri` 运行 `cargo test -p readerx --lib book_store`、
`cargo test -p readerx --lib sync::book_ids`、`cargo test -p readerx --lib sync::data_ids`、
`cargo test -p readerx --lib data_transfer`、`cargo test -p readerx --test sync_bridge` 和
`cargo test -p readerx-sync`。PR 的 Test book storage and data compatibility 工作流执行这些检查。
跨 Android / Windows 的原生构建和实际双设备同步仍需对应环境验证。
