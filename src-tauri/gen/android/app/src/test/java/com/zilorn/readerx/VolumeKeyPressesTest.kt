package com.zilorn.readerx

import org.junit.Assert.assertEquals
import org.junit.Test

class VolumeKeyPressesTest {
  @Test fun disabledKeysPassThrough() {
    val keys = VolumeKeyPresses()
    assertEquals(VolumeKeyPresses.Result.PASS, keys.handle(1, true, false, 0, false))
    assertEquals(VolumeKeyPresses.Result.PASS, keys.handle(1, false, true, 0, false))
  }

  @Test fun longPressTurnsOnceAndConsumesReleaseEvenAfterDisabling() {
    val keys = VolumeKeyPresses()
    assertEquals(VolumeKeyPresses.Result.TURN, keys.handle(-1, true, false, 0, true))
    assertEquals(VolumeKeyPresses.Result.CONSUME, keys.handle(-1, true, false, 1, true))
    assertEquals(VolumeKeyPresses.Result.CONSUME, keys.handle(-1, true, false, 2, false))
    assertEquals(VolumeKeyPresses.Result.CONSUME, keys.handle(-1, false, true, 0, false))
    assertEquals(VolumeKeyPresses.Result.PASS, keys.handle(-1, true, false, 0, false))
  }

  @Test fun enablingDuringAnExistingPressDoesNotTakeOver() {
    val keys = VolumeKeyPresses()
    assertEquals(VolumeKeyPresses.Result.PASS, keys.handle(1, true, false, 0, false))
    assertEquals(VolumeKeyPresses.Result.PASS, keys.handle(1, true, false, 1, true))
    assertEquals(VolumeKeyPresses.Result.PASS, keys.handle(1, false, true, 0, true))
    assertEquals(VolumeKeyPresses.Result.TURN, keys.handle(1, true, false, 0, true))
  }

  @Test fun losingForegroundClearsUnreleasedKeys() {
    val keys = VolumeKeyPresses()
    keys.handle(1, true, false, 0, true)
    keys.clear()
    assertEquals(VolumeKeyPresses.Result.PASS, keys.handle(1, false, true, 0, false))
    assertEquals(VolumeKeyPresses.Result.TURN, keys.handle(1, true, false, 0, true))
  }
}
