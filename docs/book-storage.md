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
| 偏好、书架进度、分组、规则等状态 | 原有 `state/<key>.json` |
| 书源与登录态 | 原有 `book_sources/`、`source_sessions/` |
| TTS 缓存 | 原有 `tts-audio/<book_id>/` |
| 章节插图 / PDF 页面图的字节 | 原有 `images/`；数据库只存引用名 |

元信息和章内结构以 JSON 列保留现有字段形状，但数据库按书 / 章分别存行。
列表通过索引连接查询元信息和预计算的章节头，不扫描正文。
按 cid 读取或回写只操作命中的章节，目录标题 / 地址保持当前值；旧 index 仅为兼容提示。
历史空或重复 cid 可以迁入，存在多个命中时正文补丁明确失败，避免错写。

## 事务与迁移

`book_store` 保留进程级书库锁，不持锁调用同步引擎。SQLite 启用外键和
`FULL` 同步，整书替换、正文批次与其指纹 / 图片引用、目录修改均由事务提交。
删书通过外键级联删除章节、书签和注释；图片继续检查其他书的引用后再清理。
数据库由每次操作按当前数据根打开，不把测试或同步夹具的另一份数据根混入本机。
数据库格式使用 `PRAGMA user_version=1`，拒绝更高版本。

首次访问逐本导入旧 `books/<id>/` 和 `books/<id>.json`，同时处理旧全库书签。
每本书先完整读取并校验，再在一个事务中提交元信息、正文、书签、注释及迁移回执。
旧 `digest.json` 不作为权威数据，章节指纹按正文重算。
成功后书籍 JSON 改名为 `.json.migrated` 留底；失败保留原文件，读路径仍可回退，
其他书照常迁移，后续访问可重试。文件归档中断时，事务内保存的回执阻止旧数据覆盖
数据库中的新编辑。已有同名留底文件不被覆盖。

旧身份迁移待办继续使用可重跑日志；数据库书籍改 ID 在事务内级联更新，
书签中的 bookId 随之更新。书架、规则、阅读时长及 TTS 目录仍使用原迁移流程。
分组和书源引用同时更新数据库元信息；书源映射在重命名文件前单独留待办，避免中断丢映射。
损坏的旧元信息使后续引用迁移延后，保留原分组 / 书源及映射，已迁入书籍仍可正常使用。
书源保存继续由共享书源 crate 写文件，App 同步维护数据库中的书源引用。

## 备份与同步

备份格式不变：数据库书籍通过 `book_store::export_books` 转成原来的
`books/<id>/{bookdetail,content,bookmarks,annotations}.json` 归档条目。
正文按章节行写入 zip，不为导出复制整库正文；数据库文件及事务日志不进入归档。
恢复通过 `book_store::import_book_json` 写入数据库，不在应用目录重建书籍 JSON。
合并 / 覆盖恢复、缺失注释清空、书签合并和凭据过滤保持原语义。
有尚未完成迁移的旧书籍时拒绝导出不完整备份。

同步元信息、目录、正文指纹、按需取章、封面与插图引用全部经 `book_store`。
资源字节仍从文件读取，线上消息与协议版本不变。

## 验证

在 `src-tauri` 运行 `cargo test -p readerx --lib book_store`、
`cargo test -p readerx --lib sync::book_ids`、`cargo test -p readerx --lib sync::data_ids`、
`cargo test -p readerx --lib data_transfer`、`cargo test -p readerx --test sync_bridge` 和
`cargo test -p readerx-sync`。PR 的 Test book storage and data compatibility 工作流执行这些检查。
跨 Android / Windows 的原生构建和实际双设备同步仍需对应环境验证。
