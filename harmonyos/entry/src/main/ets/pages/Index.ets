import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'ReaderX';
/**
 * 固定虚拟域名：rawfile 里的 dist 通过 onInterceptRequest 映射到这个 https origin。
 * 这样 IndexedDB、fetch、模块脚本都按正常同源页面处理，不受 resource:// 的
 * 跨域限制；页面内部使用 hash 路由，不会向该域名请求不存在的 SPA 路径。
 */
const ORIGIN = 'https://readerx.local/';
const RAW_ROOT = 'www/';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();

  /**
   * 把虚拟域名的请求映射到 rawfile/www。
   * 返回 null 表示不拦截（外部 http/https、data、blob 等保持原样）。
   */
  localPath(requestUrl: string): string | null {
    if (!requestUrl.startsWith(ORIGIN)) return null;

    let path = requestUrl.substring(ORIGIN.length);
    const hashAt = path.indexOf('#');
    if (hashAt >= 0) path = path.substring(0, hashAt);
    const queryAt = path.indexOf('?');
    if (queryAt >= 0) path = path.substring(0, queryAt);

    try {
      path = decodeURIComponent(path);
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'invalid URL encoding: %{public}s', requestUrl);
      return null;
    }

    // 目录穿越与绝对路径一律拒绝；SPA 深链接退回 index.html（正常情况下 hash 路由
    // 不会产生这种请求，保留兜底是为了浏览器后退/外部唤起时仍能打开应用）。
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) return null;
    if (path.length === 0) return RAW_ROOT + 'index.html';
    if (!path.includes('.')) return RAW_ROOT + 'index.html';
    return RAW_ROOT + path;
  }

  mimeType(path: string): string {
    const dot = path.lastIndexOf('.');
    const ext = dot >= 0 ? path.substring(dot + 1).toLowerCase() : '';
    switch (ext) {
      case 'html':
      case 'htm':
        return 'text/html';
      case 'js':
      case 'mjs':
        return 'text/javascript';
      case 'css':
        return 'text/css';
      case 'json':
        return 'application/json';
      case 'webmanifest':
        return 'application/manifest+json';
      case 'svg':
        return 'image/svg+xml';
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'ico':
        return 'image/x-icon';
      case 'woff':
        return 'font/woff';
      case 'woff2':
        return 'font/woff2';
      case 'ttf':
        return 'font/ttf';
      case 'otf':
        return 'font/otf';
      case 'wasm':
        return 'application/wasm';
      case 'pdf':
        return 'application/pdf';
      case 'mp3':
        return 'audio/mpeg';
      case 'm4a':
        return 'audio/mp4';
      case 'wav':
        return 'audio/wav';
      case 'ogg':
        return 'audio/ogg';
      case 'mp4':
        return 'video/mp4';
      case 'webm':
        return 'video/webm';
      case 'txt':
        return 'text/plain';
      default:
        return 'application/octet-stream';
    }
  }

  onBackPress(): boolean {
    // 先把返回键交给 WebView 历史（含 hash 路由的页面栈）；没有历史时交还系统。
    if (this.controller.accessBackward()) {
      this.controller.backward();
      return true;
    }
    return false;
  }

  build() {
    Column() {
      Web({ src: ORIGIN + 'index.html', controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .mixedMode(MixedMode.All)
        .mediaPlayGestureAccess(false)
        .zoomAccess(false)
        .darkMode(WebDarkMode.Auto)
        .forceDarkAccess(false)
        .onInterceptRequest((event) => {
          if (!event) return null;
          const url = event.request.getRequestUrl();
          const path = this.localPath(url);
          if (path === null) return null;
          try {
            const response = new WebResourceResponse();
            response.setResponseData($rawfile(path));
            response.setResponseEncoding('utf-8');
            response.setResponseMimeType(this.mimeType(path));
            response.setResponseCode(200);
            response.setReasonMessage('OK');
            response.setResponseIsReady(true);
            return response;
          } catch (error) {
            hilog.error(DOMAIN, TAG, 'rawfile missing: %{public}s', path);
            return null;
          }
        })
        .onPageEnd((event) => {
          hilog.info(DOMAIN, TAG, 'page end: %{public}s', event.url);
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F4F5F7')
  }
}
