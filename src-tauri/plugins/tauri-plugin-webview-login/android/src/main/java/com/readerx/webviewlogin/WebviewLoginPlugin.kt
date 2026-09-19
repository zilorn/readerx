// ReaderX 书源「网页登录」Android 原生实现。
//
// 在 Tauri Activity 上叠加一个全屏原生 WebView 浮层让用户完成登录，
// 顶部提供「取消 / 完成」操作条；点「完成」后收集登录态并原路返回给 Rust 侧：
// - Cookie：CookieManager 采集（含 httpOnly）；
// - localStorage / sessionStorage：页面内 JS 探针（当前页面 origin，含 IndexedDB 库清单）；
// 站点把凭证写在 localStorage 而不是 Cookie 里时，只有 Cookie 的登录态等于没登录。

package com.readerx.webviewlogin

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.ClipDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL

private const val DEFAULT_TIMEOUT_SECS = 900 // 15 分钟无人操作自动关闭
private const val STORAGE_POLL_MS = 200L // 探针轮询间隔（IndexedDB 是异步枚举）
private const val STORAGE_MAX_WAIT_MS = 4000L // 探针最长等待：超时就放弃快照，不让用户干等
private const val MAX_ENTRIES = 500 // 与 Rust 侧 storage::MAX_ENTRIES_PER_ORIGIN 保持一致
private const val MAX_VALUE_CHARS = 8192

/// 取 URL 的 origin（`https://example.com` 或 `https://example.com:8443`）；非 http(s) 返回空串
private fun originOf(url: String): String {
    val trimmed = url.trim()
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return ""
    return runCatching {
        val parsed = URL(trimmed)
        val port = if (parsed.port > 0 && parsed.port != parsed.defaultPort) ":${parsed.port}" else ""
        "${parsed.protocol}://${parsed.host}$port"
    }.getOrDefault("")
}

/// 登录态采集探针（与 Rust `readerx_source::storage::JS_PROBE` 同一份逻辑）。
/// 同步部分当场完成；IndexedDB 只有 `databases()` 异步枚举，因此结果落在 window 上，
/// 由 `pollStorage()` 轮询取回；已就绪时第二个分支直接返回结果对象供 evaluateJavascript 收走。
private const val STORAGE_PROBE_JS = """
(function () {
  var MAX_ENTRIES = __RX_MAX_ENTRIES__;
  var MAX_VALUE = __RX_MAX_VALUE__;
  var EXTRA = __RX_EXTRA_ORIGINS__;
  var out = { version: 1, origins: [] };
  window.__rxStorageProbeDone = false;
  window.__rxStorageProbeResult = "";
  var here = (typeof location !== "undefined" && location) ? location : { origin: "", href: "" };
  var current = String(here.origin || "");
  var list = [current];
  if (Object.prototype.toString.call(EXTRA) === "[object Array]") {
    for (var i = 0; i < EXTRA.length; i++) {
      var candidate = String(EXTRA[i] || "");
      if (candidate && list.indexOf(candidate) < 0) list.push(candidate);
    }
  }
  function clip(text) {
    var value = text == null ? "" : String(text);
    if (value.length <= MAX_VALUE) return { value: value, truncated: false };
    return { value: value.substring(0, MAX_VALUE), truncated: true };
  }
  function dump(store) {
    var entries = [];
    if (!store) return entries;
    for (var i = 0; i < store.length && entries.length < MAX_ENTRIES; i++) {
      var name = store.key(i);
      if (name == null) continue;
      var raw = null;
      try { raw = store.getItem(name); } catch (err) { raw = null; }
      var clipped = clip(raw);
      entries.push({ key: String(name), value: clipped.value, truncated: clipped.truncated });
    }
    return entries;
  }
  for (var k = 0; k < list.length; k++) {
    var page = {
      origin: list[k],
      url: list[k] === current ? String(here.href || "") : list[k],
      localStorage: [],
      sessionStorage: [],
      indexedDb: []
    };
    if (list[k] === current) {
      try { page.localStorage = dump(window.localStorage); } catch (err) {}
      try { page.sessionStorage = dump(window.sessionStorage); } catch (err) {}
    }
    out.origins.push(page);
  }
  function finish() {
    if (window.__rxStorageProbeDone) return;
    window.__rxStorageProbeResult = JSON.stringify(out);
    window.__rxStorageProbeDone = true;
  }
  try {
    var idb = window.indexedDB;
    if (idb) {
      var find = idb.databases;
      if (typeof find === "function") {
        var pending = find.call(idb);
        if (pending && typeof pending.then === "function") {
          pending.then(function (databases) {
            var page = out.origins[0] || { indexedDb: [] };
            var known = databases || [];
            for (var i = 0; i < known.length && page.indexedDb.length < 50; i++) {
              page.indexedDb.push({
                name: String(known[i].name == null ? "" : known[i].name),
                version: Number(known[i].version || 0),
                stores: []
              });
            }
            finish();
          }, function () { finish(); });
          return "pending";
        }
      }
    }
  } catch (err) {}
  finish();
  return "pending";
})()"""

/// 读取探针结果并复位标记；未完成返回空串
private const val STORAGE_POLL_JS = """
(function () {
  if (!window.__rxStorageProbeDone) return "";
  var text = window.__rxStorageProbeResult || "";
  window.__rxStorageProbeDone = false;
  window.__rxStorageProbeResult = "";
  return text;
})()"""

@TauriPlugin
class WebviewLoginPlugin(private val activity: Activity) : Plugin(activity) {

    private var container: LinearLayout? = null
    private var webView: WebView? = null
    private var progressBar: ProgressBar? = null
    private var pendingInvoke: Invoke? = null
    private var startedUrl: String = ""
    private var timeoutHandler: Handler? = null
    private var statusLabel: TextView? = null
    private val visitedOrigins = LinkedHashSet<String>()

    @Volatile
    private var resolved = false

    @SuppressLint("SetJavaScriptEnabled")
    @Command
    fun openLogin(invoke: Invoke) {
        if (container != null) {
            invoke.reject("已有一个登录窗口打开，请先完成或取消")
            return
        }
        val args = invoke.getArgs()
        val url = args.optString("url", "").orEmpty().trim()
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            invoke.reject("仅支持 http/https 的登录地址")
            return
        }
        if (activity.findViewById<FrameLayout>(android.R.id.content) == null) {
            invoke.reject("无法定位窗口，登录不可用")
            return
        }
        val title = args.optString("title", "").orEmpty()
        val timeoutSecs = args.optLong("timeoutSecs", DEFAULT_TIMEOUT_SECS.toLong())
            .takeIf { it > 0 } ?: DEFAULT_TIMEOUT_SECS.toLong()

        startedUrl = url
        pendingInvoke = invoke
        resolved = false
        visitedOrigins.clear()
        runCatching { originOf(url) }.getOrNull()?.let { visitedOrigins.add(it) }

        // 确保所有视图操作发生在主线程（Rust 侧可能在任意线程发起调用）
        postToMain {
            try {
                showOverlay(url, title, timeoutSecs)
            } catch (ex: Exception) {
                finishAndRespond(ok = false, message = ex.message ?: "打开登录窗口失败")
            }
        }
    }

    private fun postToMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
        } else {
            Handler(Looper.getMainLooper()).post(block)
        }
    }

    // ------------------------------------------------------------------
    // 浮层
    // ------------------------------------------------------------------

    private fun dp(value: Int): Int {
        return (value * activity.resources.displayMetrics.density).toInt()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showOverlay(url: String, title: String, timeoutSecs: Long) {
        val root = activity.findViewById<FrameLayout>(android.R.id.content) ?: return
        val (topInset, bottomInset) = systemBarInsets()

        // 容器：全屏铺在应用之上
        container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setPadding(0, topInset, 0, bottomInset)
        }
        val overlay = container!!

        // 顶栏：取消 | 标题 | 完成
        val topBar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#F7F7F8"))
                cornerRadius = 0f
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(48),
            )
        }

        topBar.addView(
            TextView(activity).apply {
                text = "取消"
                textSize = 15f
                setTextColor(Color.parseColor("#666666"))
                gravity = Gravity.CENTER
                setPadding(dp(16), 0, dp(16), 0)
                setOnClickListener { finishAndRespond(ok = false, message = "已取消登录") }
            },
        )

        val titleView = TextView(activity).apply {
            text = title.takeIf { it.isNotBlank() } ?: runCatching { URL(url).host }
                .getOrNull() ?: "登录"
            textSize = 16f
            setTextColor(Color.parseColor("#222222"))
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        val statusView = TextView(activity).apply {
            text = "正在读取登录信息…"
            textSize = 12f
            setTextColor(Color.parseColor("#3B82F6"))
            gravity = Gravity.CENTER
            maxLines = 1
            visibility = View.GONE
        }
        statusLabel = statusView
        topBar.addView(
            LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(dp(4), 0, dp(4), 0)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                addView(titleView)
                addView(statusView)
            },
        )

        topBar.addView(
            TextView(activity).apply {
                text = "完成"
                textSize = 15f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                setTextColor(Color.parseColor("#3B82F6"))
                gravity = Gravity.CENTER
                setPadding(dp(16), 0, dp(16), 0)
                setOnClickListener { finishAndRespond(ok = true, message = "") }
            },
        )

        // 加载进度条
        progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            isIndeterminate = false
            background = null
            progressDrawable = ClipDrawable(
                GradientDrawable().apply {
                    setColor(Color.parseColor("#3B82F6"))
                    cornerRadius = 0f
                    shape = GradientDrawable.RECTANGLE
                },
                Gravity.START,
                ClipDrawable.HORIZONTAL,
            )
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(2),
            )
            visibility = View.VISIBLE
        }
        // 用一个容器固定进度条不被 WebView 盖住
        val progressHost = FrameLayout(activity).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(2),
            )
            addView(progressBar!!, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(2),
            ))
        }

        // WebView
        val wv = WebView(activity.applicationContext)
        webView = wv
        wv.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f,
        )
        val settings: WebSettings = wv.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mediaPlaybackRequiresUserGesture = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                super.onProgressChanged(view, newProgress)
                val p = progressBar ?: return
                if (newProgress >= 100) {
                    p.visibility = View.GONE
                } else {
                    p.visibility = View.VISIBLE
                    p.progress = newProgress
                }
            }

            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?,
            ): Boolean {
                // 多数登录流程会在新窗口打开（OAuth / target=_blank）：把新窗口地址改在主 WebView 打开
                val base = view ?: wv
                val helper = WebView(activity.applicationContext)
                helper.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        inner: WebView,
                        request: WebResourceRequest,
                    ): Boolean {
                        val target = request.url.toString()
                        runCatching { inner.destroy() }
                        base.post { base.loadUrl(target) }
                        return true
                    }
                }
                val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                transport.webView = helper
                resultMsg?.sendToTarget()
                return true
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest,
            ): Boolean = false

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                recordOrigin(url)
            }

            @Suppress("DEPRECATION")
            override fun onReceivedError(
                view: WebView,
                errorCode: Int,
                description: String?,
                failingUrl: String?,
            ) {
                // -1 = 页面主动中止（跳转/下载），不提示
                if (errorCode != -1) {
                    runCatching {
                        Toast.makeText(
                            activity,
                            "加载失败（$errorCode）",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            }
        }

        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(wv, true)
        }

        overlay.addView(topBar)
        overlay.addView(progressHost)
        overlay.addView(wv)
        root.addView(overlay)

        wv.loadUrl(url)

        // 无人操作自动关闭，避免 Rust 侧永久阻塞
        timeoutHandler = Handler(Looper.getMainLooper())
        timeoutHandler?.postDelayed(
            {
                if (!resolved && container != null) {
                    finishAndRespond(ok = false, message = "登录等待超时，窗口已关闭")
                }
            },
            timeoutSecs * 1000,
        )
    }

    private fun systemBarInsets(): Pair<Int, Int> {
        val decor = activity.window.decorView
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val insets = decor.rootWindowInsets
            val bars = insets?.getInsets(
                android.view.WindowInsets.Type.systemBars() or
                    android.view.WindowInsets.Type.displayCutout(),
            )
            return (bars?.top ?: 0) to (bars?.bottom ?: 0)
        }
        @Suppress("DEPRECATION")
        val insets = decor.rootWindowInsets
        return (insets?.systemWindowInsetTop ?: 0) to (insets?.systemWindowInsetBottom ?: 0)
    }

    // ------------------------------------------------------------------
    // 收集登录态（Cookie + localStorage / sessionStorage / IndexedDB）并收尾
    // ------------------------------------------------------------------

    /// 记录访问过的 origin（登录链路常跨域：example.com → auth.example.com）
    private fun recordOrigin(url: String?) {
        val origin = runCatching { originOf(url.orEmpty()) }.getOrNull() ?: return
        if (origin.isNotEmpty()) visitedOrigins.add(origin)
    }

    private fun collectCookies(): Pair<String, Int> {
        val cookieManager = CookieManager.getInstance()
        val seen = LinkedHashMap<String, String>()
        val targets = ArrayList<String>()
        targets.add(startedUrl)
        webView?.url?.let { finalUrl -> if (finalUrl != startedUrl) targets.add(finalUrl) }
        for (origin in visitedOrigins) targets.add(origin)
        for (candidate in targets) {
            if (!candidate.startsWith("http")) continue
            val line = runCatching { cookieManager.getCookie(candidate) }.getOrNull()
            if (line.isNullOrBlank()) continue
            for (piece in line.split(";")) {
                val kv = piece.trim()
                if (kv.contains('=')) {
                    val name = kv.substringBefore('=').trim()
                    if (name.isNotEmpty()) seen[name] = kv
                }
            }
        }
        return seen.values.joinToString("; ") to seen.size
    }

    /// 启动存储探针。
    ///
    /// 只能读到**当前页面 origin** 的 localStorage / sessionStorage：`WebStorage` 那套
    /// 已废弃接口只给 origin / 配额、拿不到键值，而跨域读别的 origin 的存储被浏览器禁止。
    /// IndexedDB 是异步枚举，所以按 STORAGE_POLL_MS 轮询取回，最多等 STORAGE_MAX_WAIT_MS ——
    /// 超时就直接放弃快照，不能因为探针卡住而让用户卡在「完成」上。
    private fun collectStorage(onDone: (JSONObject?) -> Unit) {
        val wv = webView ?: return onDone(null)
        val extra = JSONArray()
        for (origin in visitedOrigins) extra.put(origin)
        val script = STORAGE_PROBE_JS
            .replace("__RX_EXTRA_ORIGINS__", extra.toString())
            .replace("__RX_MAX_ENTRIES__", MAX_ENTRIES.toString())
            .replace("__RX_MAX_VALUE__", MAX_VALUE_CHARS.toString())
        val deadline = System.currentTimeMillis() + STORAGE_MAX_WAIT_MS

        fun poll() {
            postToMain {
                val view = webView ?: return@postToMain onDone(null)
                view.evaluateJavascript(STORAGE_POLL_JS) { raw ->
                    val text = decodeEvalString(raw)
                    if (text.isNotEmpty()) {
                        onDone(runCatching { JSONObject(text) }.getOrNull())
                    } else if (System.currentTimeMillis() < deadline) {
                        Handler(Looper.getMainLooper()).postDelayed({ poll() }, STORAGE_POLL_MS)
                    } else {
                        onDone(null)
                    }
                }
            }
        }

        wv.evaluateJavascript(script) { poll() }
    }

    /// evaluateJavascript 把返回值当 JS 值编码返回：字符串会带引号并转义，
    /// 对象（探针已就绪的分支）则是对象字面量 —— 两种都要能还原成原始 JSON 文本。
    private fun decodeEvalString(raw: String?): String {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty() || text == "null" || text == "\"pending\"") return ""
        if (text.startsWith("\"")) {
            return runCatching {
                org.json.JSONTokener(text).nextValue() as? String ?: ""
            }.getOrDefault("")
        }
        return text
    }

    private fun finishAndRespond(ok: Boolean, message: String) {
        postToMain {
            beginFinish(ok, message)
        }
    }

    /// 点「完成」后的第一步：冻结操作条、开始采集（异步），采完再真正收尾。
    private fun beginFinish(ok: Boolean, message: String) {
        if (resolved) return
        resolved = true
        timeoutHandler?.removeCallbacksAndMessages(null)
        timeoutHandler = null

        val finalUrl = webView?.url ?: startedUrl
        if (!ok) {
            doFinish(false, message, finalUrl, "", 0, null)
            return
        }
        statusLabel?.visibility = View.VISIBLE
        collectStorage { storage ->
            val (cookies, count) = collectCookies()
            doFinish(true, message, finalUrl, cookies, count, storage)
        }
    }

    private fun doFinish(
        ok: Boolean,
        message: String,
        finalUrl: String,
        cookies: String,
        count: Int,
        storage: JSONObject?,
    ) {
        // 采集是异步的：等它回来时窗口可能已经被系统关掉（onDestroy 里已收尾并清空 invoke）
        val invoke = pendingInvoke ?: return
        pendingInvoke = null
        val overlay = container
        container = null
        val wv = webView
        webView = null
        progressBar = null
        statusLabel = null

        runCatching {
            wv?.stopLoading()
            wv?.loadUrl("about:blank")
            wv?.clearHistory()
            wv?.removeAllViews()
            (overlay?.parent as? ViewGroup)?.removeView(overlay)
        }
        runCatching { wv?.destroy() }

        val result = JSObject()
        result.put("ok", ok)
        result.put("url", finalUrl)
        result.put("cookies", cookies)
        result.put("count", count)
        result.put("message", message)
        if (storage != null) result.put("storage", JSObject.fromJSONObject(storage))
        invoke.resolve(result)
    }

    override fun onDestroy(activity: AppCompatActivity) {
        super.onDestroy(activity)
        if (container != null && !resolved) {
            finishAndRespond(ok = false, message = "窗口已关闭")
        }
    }
}
