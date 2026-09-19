## 下载与安装

本页产物按平台与 CPU 架构拆分，选择与你的设备匹配的一个下载即可。

### Android（APK，按 ABI 拆分）

- **arm64-v8a**：近几年的主流手机 / 平板（64 位），绝大多数设备选这个
- **armeabi-v7a**：仅支持 32 位应用的老设备
- **x86_64 / x86**：Android 模拟器（分别对应 64 / 32 位镜像）

系统要求 **Android 7.0（API 24）及以上**。直接覆盖安装即可升级，书架、书源、设置等数据保留在设备本地，不受影响。

### Linux（x86_64）

- **AppImage**：下载后 `chmod +x` 再运行，免安装；
- **deb**：Debian / Ubuntu 系，`sudo apt install ./readerx_*.deb`；
- **rpm**：Fedora / openSUSE 系，`sudo dnf install ./readerx-*.rpm`。

需要系统已装 WebKitGTK 4.1 与 GTK3（主流桌面发行版通常自带）。

### Windows（x86_64 / aarch64）

安装包文件名里的架构要与设备匹配：**x64** 用于 Intel / AMD 处理器，**arm64** 用于骁龙 X 等 ARM 笔记本。
WebView2 运行时由 Windows 10/11 自带，无需另外安装。

### 关于签名

Android APK 已签名；**Linux 与 Windows 安装包未做代码签名**：

- Windows 安装时可能出现 SmartScreen 提示，选择「仍要运行」即可；
- Linux 下 AppImage 需要自行赋予可执行权限。

使用中遇到问题欢迎到 [Issues](https://github.com/zilorn/readerx/issues) 反馈，请附上平台、设备型号与系统版本。

以下为本版本更新内容：
