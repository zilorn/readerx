package com.zilorn.readerx

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class TtsServiceArgs {
  var active: Boolean = false
  var playing: Boolean = true
  var title: String = ""
  var text: String = ""
}

@TauriPlugin(
  permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class TtsServicePlugin(private val activity: Activity) : Plugin(activity) {
  /** 通知权限只在第一次开始朗读时询问一次；拒绝后不反复弹窗，服务照常运行。 */
  private var notificationAsked = false

  @Command
  fun setActive(invoke: Invoke) {
    val args = invoke.parseArgs(TtsServiceArgs::class.java)
    activity.runOnUiThread {
      try {
        val intent = Intent(activity, TtsForegroundService::class.java)
        if (args.active) {
          intent.putExtra(TtsForegroundService.EXTRA_TITLE, args.title)
          intent.putExtra(TtsForegroundService.EXTRA_TEXT, args.text)
          intent.putExtra(TtsForegroundService.EXTRA_PLAYING, args.playing)
          ContextCompat.startForegroundService(activity, intent)
          if (needsNotificationPermission()) {
            notificationAsked = true
            // 服务已经在前台运行，通知权限只决定通知是否可见；回调里再 resolve 原始 invoke。
            requestPermissionForAlias("notifications", invoke, "notificationsCallback")
            return@runOnUiThread
          }
        } else {
          activity.stopService(intent)
        }
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject("听书后台服务切换失败: ${error.message}")
      }
    }
  }

  @PermissionCallback
  fun notificationsCallback(invoke: Invoke) {
    invoke.resolve()
  }

  private fun needsNotificationPermission(): Boolean {
    if (notificationAsked || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
    return getPermissionState("notifications") != PermissionState.GRANTED
  }
}
