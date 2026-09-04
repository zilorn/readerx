# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 导入本地同名文件时可选择重新导入（替换书架中同名书，尝试继承阅读进度/分组/书签）或作为新书加入；重新导入前预演书签继承，部分书签无法继承时提示并可放弃重新导入。WebDAV 长按重新导入同样增加该提示与放弃选项。

### Fixed

- webdav中直接点击阅读，返回后，失去状态数据的问题。
- tts跟读后翻页异常问题。
- 自动跟读跨章定位异常的问题。

### Changed

- TTS失败后跳过，连续失败多次（5次）后停止。
- 封面中，使用书籍全名，而不是首字。
- 封面可以在epub中取。

## [0.1.1] - 2026-09-04

### Added

- 本地书导入
- 添加tts听书功能
- 搜索全书，书架书籍功能
- webdav支持
- 书源

