package com.zilorn.readerx

import android.app.Activity
import android.content.Intent
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class TtsServiceArgs {
  var active: Boolean = false
  var title: String = ""
  var text: String = ""
}

@TauriPlugin
class TtsServicePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun setActive(invoke: Invoke) {
    val args = invoke.parseArgs(TtsServiceArgs::class.java)
    activity.runOnUiThread {
      try {
        val intent = Intent(activity, TtsForegroundService::class.java)
        if (args.active) {
          intent.putExtra(TtsForegroundService.EXTRA_TITLE, args.title)
          intent.putExtra(TtsForegroundService.EXTRA_TEXT, args.text)
          ContextCompat.startForegroundService(activity, intent)
        } else {
          activity.stopService(intent)
        }
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject("听书后台服务切换失败: ${error.message}")
      }
    }
  }
}
