package com.zilorn.readerx

/** 一次实体按键只翻一页，吞掉重复和配对抬起，避免长按连续跨章。 */
internal class VolumeKeyPresses {
  enum class Result { PASS, CONSUME, TURN }
  private val held = mutableSetOf<Int>()

  fun handle(direction: Int, down: Boolean, up: Boolean, repeat: Int, enabled: Boolean): Result {
    if (up) return if (held.remove(direction)) Result.CONSUME else Result.PASS
    if (!down) return Result.PASS
    if (direction in held) return Result.CONSUME
    if (!enabled || repeat != 0) return Result.PASS
    held.add(direction)
    return Result.TURN
  }

  fun clear() = held.clear()
}
