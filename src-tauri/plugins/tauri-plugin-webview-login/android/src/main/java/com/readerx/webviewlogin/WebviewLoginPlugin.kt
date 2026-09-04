// ReaderX 书源「网页登录」Android 原生实现。
//
// 在 Tauri Activity 上叠加一个全屏原生 WebView 浮层让用户完成登录，
// 顶部提供「取消 / 完成」操作条；点「完成」后用 CookieManager 收集
// 当前站点（含 httpOnly）的 Cookie，经 Invoke 原路返回给 Rust 侧。

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
import java.net.URL

private const val DEFAULT_TIMEOUT_SECS = 900 // 15 分钟无人操作自动关闭

@TauriPlugin
class WebviewLoginPlugin(private val activity: Activity) : Plugin(activity) {

    private var container: LinearLayout? = null
    private var webView: WebView? = null
    private var progressBar: ProgressBar? = null
    private var pendingInvoke: Invoke? = null
    private var startedUrl: String = ""
    private var timeoutHandler: Handler? = null

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

        topBar.addView(
            TextView(activity).apply {
                text = title.takeIf { it.isNotBlank() } ?: runCatching { URL(url).host }
                    .getOrNull() ?: "登录"
                textSize = 16f
                setTextColor(Color.parseColor("#222222"))
                gravity = Gravity.CENTER
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(dp(4), 0, dp(4), 0)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
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
    // 收集 Cookie 并收尾
    // ------------------------------------------------------------------

    private fun collectCookies(): Pair<String, Int> {
        val cookieManager = CookieManager.getInstance()
        val seen = LinkedHashMap<String, String>()
        val hosts = ArrayList<String>()
        hosts.add(startedUrl)
        webView?.url?.let { finalUrl -> if (finalUrl != startedUrl) hosts.add(finalUrl) }
        for (candidate in hosts) {
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

    private fun finishAndRespond(ok: Boolean, message: String) {
        postToMain {
            doFinish(ok, message)
        }
    }

    private fun doFinish(ok: Boolean, message: String) {
        if (resolved) return
        resolved = true
        timeoutHandler?.removeCallbacksAndMessages(null)
        timeoutHandler = null

        val finalUrl = webView?.url ?: startedUrl
        var cookies = ""
        var count = 0
        if (ok) {
            val (line, n) = collectCookies()
            cookies = line
            count = n
        }

        val overlay = container
        container = null
        val wv = webView
        webView = null
        progressBar = null

        runCatching {
            wv?.stopLoading()
            wv?.loadUrl("about:blank")
            wv?.clearHistory()
            wv?.removeAllViews()
            (overlay?.parent as? ViewGroup)?.removeView(overlay)
        }
        runCatching { wv?.destroy() }

        val invoke = pendingInvoke
        pendingInvoke = null
        if (invoke != null) {
            val result = JSObject()
            result.put("ok", ok)
            result.put("url", finalUrl)
            result.put("cookies", cookies)
            result.put("count", count)
            result.put("message", message)
            invoke.resolve(result)
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        super.onDestroy(activity)
        if (container != null && !resolved) {
            finishAndRespond(ok = false, message = "窗口已关闭")
        }
    }
}
