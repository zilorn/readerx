/*
 * ReaderX PWA Service Worker（手写，无第三方依赖）。
 *
 * 目标：HarmonyOS 浏览器安装到桌面后，断网也能打开应用外壳；
 * 正文、书签、进度等数据在 IndexedDB（见 src/lib/webStore.ts），由页面自己管理。
 *
 * 更新策略：
 * - 导航请求走「网络优先」，保证发布新版本后刷新即可拿到新的 index.html；
 * - 带哈希的构建产物走「缓存优先」，命中后不再回源；
 * - 其它同源 GET 走 stale-while-revalidate。
 *
 * 改动缓存内容时同步修改 CACHE_VERSION，旧的 Cache Storage 会在 activate 中删除。
 */
const CACHE_VERSION = "readerx-v1";
const CACHE_NAME = `${CACHE_VERSION}-shell`;
const BASE = self.location.pathname.replace(/\/sw\.js$/, "/") || "/";
const APP_SHELL = [
  BASE,
  `${BASE}index.html`,
  `${BASE}manifest.webmanifest`,
  `${BASE}favicon.svg`,
  `${BASE}icons/icon-192.png`,
  `${BASE}icons/icon-512.png`,
  `${BASE}icons/icon-maskable-512.png`,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && key.startsWith("readerx-"))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheable(response) {
  return response && (response.ok || response.type === "opaque");
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match(`${BASE}index.html`));
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (isCacheable(response)) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/sw.js")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  if (
    url.pathname.includes("/assets/") ||
    url.pathname.includes("/icons/") ||
    url.pathname.includes("/generated/")
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
