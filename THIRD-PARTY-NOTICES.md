ReaderX 第三方开源库使用声明

ReaderX 打包并使用下列第三方开源库，各库版权归其作者所有，按其声明的许可协议分发；
许可全文见各项目主页。本文件随应用一起打包，应用内「设置 → 关于 → 开源库声明」可查看。

【前端 / WebView 运行时】

solid-js（MIT）
    界面框架：组件渲染与全局状态
    https://github.com/solidjs/solid

@solidjs/router（MIT）
    页面路由与懒加载
    https://github.com/solidjs/solid-router

@tauri-apps/api（Apache-2.0 OR MIT）
    调用宿主命令、事件与系统能力
    https://github.com/tauri-apps/tauri

@tauri-apps/plugin-http（MIT OR Apache-2.0）
    书源 / WebDAV / 听书音频的 HTTP 请求：经宿主发出，绕开 WebView 的跨域与明文限制
    https://github.com/tauri-apps/plugins-workspace

@tauri-apps/plugin-opener（MIT OR Apache-2.0）
    用系统浏览器 / 应用打开外部链接
    https://github.com/tauri-apps/plugins-workspace

fflate（MIT）
    解压 EPUB（ZIP）与简繁转换词典（gzip）
    https://github.com/101arrowz/fflate

opencc-js（MIT AND Apache-2.0）
    简繁转换：构建期取词典、运行时装树
    https://github.com/nk2028/opencc-js

pdfjs-dist（Apache-2.0）
    解析 PDF（文字层、大纲）与渲染扫描件页面
    https://github.com/mozilla/pdf.js

tauri-plugin-tts-api（MIT）
    调用系统语音合成朗读正文（听书）
    https://github.com/brenogonzaga/tauri-plugin-tts

【后端 / Rust】

tauri（Apache-2.0 OR MIT）
    应用外壳：IPC、窗口与资源打包
    https://github.com/tauri-apps/tauri

tauri-plugin-opener（Apache-2.0 OR MIT）
    打开外部链接
    https://github.com/tauri-apps/plugins-workspace

tauri-plugin-http（Apache-2.0 OR MIT）
    书源 / WebDAV / 听书音频的原生 HTTP 请求
    https://github.com/tauri-apps/plugins-workspace

tauri-plugin-fs（Apache-2.0 OR MIT）
    读取随包资源文本（开源许可与本声明）
    https://github.com/tauri-apps/plugins-workspace

tauri-plugin-tts（MIT）
    系统语音合成（听书）
    https://github.com/brenogonzaga/tauri-plugin-tts

tauri-plugin-single-instance（Apache-2.0 OR MIT）
    桌面端单实例：重复启动时聚焦已有窗口
    https://github.com/tauri-apps/plugins-workspace

serde（MIT OR Apache-2.0）
    数据结构序列化 / 反序列化
    https://github.com/serde-rs/serde

serde_json（MIT OR Apache-2.0）
    命令参数与本地 JSON 数据文件
    https://github.com/serde-rs/json

base64（MIT OR Apache-2.0）
    图片 / 音频等二进制在前后端之间以文本传递
    https://github.com/marshallpierce/rust-base64

boa_engine（Unlicense OR MIT）
    书源 JavaScript 沙箱引擎
    https://github.com/boa-dev/boa

scraper（ISC）
    书源 HTML 选择器解析
    https://github.com/rust-scraper/scraper

reqwest（MIT OR Apache-2.0）
    书源 HTTP 客户端：Cookie 会话、gzip 与 TLS
    https://github.com/seanmonstar/reqwest

url（MIT OR Apache-2.0）
    URL 解析与 Cookie 作用域判定
    https://github.com/servo/rust-url

encoding_rs（(Apache-2.0 OR MIT) AND BSD-3-Clause）
    非 UTF-8 站点的编码探测与解码
    https://github.com/hsivonen/encoding_rs

md-5（MIT OR Apache-2.0）
    书源 cryptoUtil 的 MD5 摘要与 HMAC-MD5 签名
    https://github.com/RustCrypto/hashes

sha1（MIT OR Apache-2.0）
    书源 cryptoUtil 的 SHA-1 摘要与 HMAC-SHA1 签名
    https://github.com/RustCrypto/hashes

sha2（MIT OR Apache-2.0）
    书源 cryptoUtil 的 SHA-256 摘要与 HMAC-SHA256 签名
    https://github.com/RustCrypto/hashes

hmac（MIT OR Apache-2.0）
    书源 cryptoUtil 的 HMAC 签名
    https://github.com/RustCrypto/MACs

digest（MIT OR Apache-2.0）
    摘要算法的通用接口
    https://github.com/RustCrypto/traits

aes-gcm（Apache-2.0 OR MIT）
    书源 cryptoUtil 的 AES-256-GCM 对称加解密
    https://github.com/RustCrypto/AEADs

getrandom（MIT OR Apache-2.0）
    随机数：AES-GCM 的随机 IV
    https://github.com/rust-random/getrandom

log（MIT OR Apache-2.0）
    统一日志门面：业务代码只写 log::info! 这类宏，输出目标（文件 / 标准错误 / logcat）由 readerx-log 决定
    https://github.com/rust-lang/log

time（MIT OR Apache-2.0）
    日志时间戳的本地时区换算（按用户所在时区打印，排障时能直接对上用户描述的时间）
    https://github.com/time-rs/time

