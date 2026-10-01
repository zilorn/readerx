# MOBI 导入

书架的导入按钮（Android 文件选择 / 桌面原生文件选择）和 WebDAV 均接受 `.mobi`，扩展名不区分大小写。导入后沿用本地书的阅读、搜索、书签、重新导入、备份与同步流程。

- 支持未加密的传统 MOBI（MOBI6，以及带 MOBI6 正文的双格式文件）。纯 KF8 / AZW3 与 DRM 文件会明确报错，不会保存为乱码书籍。
- 提取书名、作者、简介和 EXTH 声明的封面；正文支持未压缩、PalmDOC 与 HUFF/CDIC。传统正文支持 UTF-8 / Windows-1252。
- 按 HTML 标题分章；缺少一级 / 二级标题时用 `mbp:pagebreak` 分节，无边界则作为一章。当前不重建 MOBI 的二进制导航索引。
- `img recindex` 按原始资源位置提取 JPEG / PNG / GIF / WebP，保留段内插图。资源中夹有非图片记录不会改变后续图片索引。

解析命令 `readerx_parse_mobi` 在 Rust 工作线程中执行，返回元信息、离屏 HTML 和书内图片。前端 `mobi.ts` 与 EPUB 共用 `ebookHtml.ts` 的结构化段落 / 标题 / 插图转换；不执行书内脚本，不加载外部图片。正文和图片保存继续走已有 Rust 书库，无新增存储格式；`format: "mobi"` 是既有字符串字段的新值，无需迁移旧书籍。

纯浏览器预览没有 Rust 宿主，MOBI 导入会提示在应用中使用。HUFF/CDIC 在项目内解码，避免第三方库的正文调试输出。回归测试在 `src-tauri` 运行 `cargo test --lib mobi::tests`，覆盖末尾正文记录、跨记录 UTF-8、Windows-1252、PalmDOC、HUFF/CDIC、旧版短文件头、封面与元信息、尾部附加数据、图片索引与无效 / 加密 / KF8 文件。
