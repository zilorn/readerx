package com.zilorn.readerx

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * 听书前台服务：听书会话开始到停止期间常驻，通知栏显示书名 / 章节并提供上一句、暂停继续、
 * 下一句、停止四个按钮。切到后台后 Activity 会暂停，但前台服务让进程与原生 TTS 继续工作，
 * 按钮与逐句推进都经由 WebView 中的听书会话执行（MainActivity 保持 WebView 定时器运行）。
 */
class TtsForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_CONTROL) {
      val sink = dispatch
      if (sink == null) {
        // WebView 已经不在：没有人能执行这个按钮，收起服务。
        stopSelf()
      } else {
        sink(intent.getStringExtra(EXTRA_CONTROL).orEmpty())
      }
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty()
    val text = intent?.getStringExtra(EXTRA_TEXT).orEmpty()
    val playing = intent?.getBooleanExtra(EXTRA_PLAYING, true) ?: true
    ensureChannel()
    val notification = buildNotification(title, text, playing)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // 朗读中才占用唤醒锁；暂停时只保留通知，让 CPU 可以休眠。
    if (playing) acquireWakeLock() else releaseWakeLock()
    running = true
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    releaseWakeLock()
    super.onDestroy()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "readerx:tts").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun ensureChannel() {
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.tts_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    ).apply { setShowBadge(false) }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(title: String, text: String, playing: Boolean): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val open = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    builder.addAction(android.R.drawable.ic_media_previous, getString(R.string.tts_previous), controlIntent(CONTROL_PREVIOUS, 1))
    if (playing) {
      builder.addAction(android.R.drawable.ic_media_pause, getString(R.string.tts_pause), controlIntent(CONTROL_TOGGLE, 2))
    } else {
      builder.addAction(android.R.drawable.ic_media_play, getString(R.string.tts_resume), controlIntent(CONTROL_TOGGLE, 2))
    }
    builder.addAction(android.R.drawable.ic_media_next, getString(R.string.tts_next), controlIntent(CONTROL_NEXT, 3))
    builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, getString(R.string.tts_stop), controlIntent(CONTROL_STOP, 4))
    // 通知按钮只是把控制名交回服务，由 onStartCommand 转给 WebView 执行。
    return builder.build()
  }

  private fun controlIntent(control: String, requestCode: Int): PendingIntent {
    val intent = Intent(this, TtsForegroundService::class.java)
      .setAction(ACTION_CONTROL)
      .putExtra(EXTRA_CONTROL, control)
    return PendingIntent.getService(
      this,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_PLAYING = "playing"
    const val EXTRA_CONTROL = "control"
    const val ACTION_CONTROL = "com.zilorn.readerx.TTS_CONTROL"
    const val CONTROL_PREVIOUS = "previous"
    const val CONTROL_TOGGLE = "toggle"
    const val CONTROL_NEXT = "next"
    const val CONTROL_STOP = "stop"
    private const val CHANNEL_ID = "readerx-tts"
    private const val NOTIFICATION_ID = 0x7454

    /** 前台服务是否正在运行（MainActivity 据此决定是否保持 WebView 定时器） */
    @Volatile
    var running: Boolean = false
      private set

    /** 通知按钮的执行入口，由 MainActivity 绑定到 WebView；无 WebView 时为 null */
    @Volatile
    var dispatch: ((String) -> Unit)? = null
  }
}
