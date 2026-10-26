package com.zilorn.readerx

import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  internal var volumeKeys: VolumeKeysPlugin? = null

  private var mainWebView: WebView? = null
  private var hasWindowFocus = false
  private var requestedInitialPaint = false

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    mainWebView = webView
    Log.i(TAG, "WebView created")
    requestInitialPaintIfReady()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    hasWindowFocus = hasFocus
    if (hasFocus) requestInitialPaintIfReady()
  }

  // Focus and WebView creation may arrive in either order on Android 14+.
  private fun requestInitialPaintIfReady() {
    val webView = mainWebView ?: return
    if (!hasWindowFocus || requestedInitialPaint) return
    requestedInitialPaint = true
    webView.post {
      if (!isFinishing && !isDestroyed && webView === mainWebView) {
        webView.invalidate()
        Log.i(TAG, "Requested initial WebView repaint")
      }
    }
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (volumeKeys?.dispatchKeyEvent(event) == true) return true
    return super.dispatchKeyEvent(event)
  }

  override fun onPause() {
    volumeKeys?.clearPresses()
    super.onPause()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    Log.i(TAG, "Activity created (savedState=${savedInstanceState != null})")
    super.onCreate(savedInstanceState)
  }

  override fun onDestroy() {
    Log.i(TAG, "Activity destroyed (webViewCreated=${mainWebView != null})")
    mainWebView = null
    super.onDestroy()
  }

  companion object {
    private const val TAG = "ReaderXActivity"
  }
}
