package com.zilorn.readerx

import android.app.Activity
import android.view.KeyEvent
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class VolumeKeysArgs {
  var enabled: Boolean = false
}

@TauriPlugin
class VolumeKeysPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private var enabled = false
  private val presses = VolumeKeyPresses()

  override fun load(webView: WebView) {
    this.webView = webView
    enabled = false
    presses.clear()
    (activity as MainActivity).volumeKeys = this
  }

  @Command
  fun setEnabled(invoke: Invoke) {
    val args = invoke.parseArgs(VolumeKeysArgs::class.java)
    activity.runOnUiThread {
      enabled = args.enabled
      invoke.resolve()
    }
  }

  fun clearPresses() = presses.clear()

  fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val direction = when (event.keyCode) {
      KeyEvent.KEYCODE_VOLUME_UP -> -1
      KeyEvent.KEYCODE_VOLUME_DOWN -> 1
      else -> return false
    }
    val view = webView
    // 原生网页登录浮层取得焦点后，也必须让音量键回到系统。
    val intercept = enabled && view?.hasFocus() == true && view.hasWindowFocus()
    return when (presses.handle(direction, event.action == KeyEvent.ACTION_DOWN,
        event.action == KeyEvent.ACTION_UP, event.repeatCount, intercept)) {
      VolumeKeyPresses.Result.PASS -> false
      VolumeKeyPresses.Result.CONSUME -> true
      VolumeKeyPresses.Result.TURN -> {
        view?.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('readerx-volume-key', {detail: $direction}));",
          null,
        )
        true
      }
    }
  }
}
