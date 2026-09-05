# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 书源「网页登录」：Android 端在应用内 WebView 浮层登录后自动捕获站点 Cookie（含 httpOnly）并按书源持久化（重启自动注入，不随书源 JSON 导出）；书源 JS 引擎开放 `webview.login(url)` / `webview.isSupported()` 宿主 API，书源编辑页提供「网页登录 / 清空登录 Cookie」入口。桌面/iOS 不支持时返回 `ok:false` 且不抛错。
- 导入本地同名文件时可选择重新导入（替换书架中同名书，尝试继承阅读进度/分组/书签）或作为新书加入；重新导入前预演书签继承，部分书签无法继承时提示并可放弃重新导入。WebDAV 长按重新导入同样增加该提示与放弃选项。
- 书籍详情页。
- 目录（TOC）显示章节下载状态。
- 阅读设置里新增「重新加载本章」（仅在线书显示该入口）。
- 在线书获取失败后提示用户并提供重新加载入口。
- 替换文本功能，支持正则。

### Fixed

- webdav中直接点击阅读，返回后，失去状态数据的问题。
- tts跟读后翻页异常问题。
- 自动跟读跨章定位异常的问题。

### Changed

- TTS失败后跳过，连续失败多次（5次）后停止。
- 封面中，使用书籍全名，而不是首字。
- 封面可以在epub中取。
- 当章节内容过多时，阅读器显示正在加载，而不是卡页面。
- 阅读器设置继承设置页面的某些设置项。
- 当书籍有至少一个书签时，不填充svg图标。
- 跨页面选取支持（分页模式）。
- 书签跨段落支持。
- 将书本来源筛选与分组合并，并可以在设置调整。

## [0.1.1] - 2026-09-04

### Added

- 本地书导入
- 添加tts听书功能
- 搜索全书，书架书籍功能
- webdav支持
- 书源

