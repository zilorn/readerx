package com.zilorn.readerx

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  internal var volumeKeys: VolumeKeysPlugin? = null

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
    super.onCreate(savedInstanceState)
  }
}
