/**
 * Listening (TTS): the settings sheet, playback notices, HTTP source errors and the
 * audio-decoder troubleshooting guide.
 *
 * Strings that are matched or persisted (voice ids, language tags, MIME types, the
 * {$TEXT} / {$RATE} source placeholders) and voice names returned by the system stay
 * untranslated. Log text (`log.*`) stays Chinese.
 */
export const tts = {
  // Listening settings sheet (TtsSheet)
  "tts.sheet.title": "Listening settings",
  "tts.sheet.close": "Close listening settings",
  "tts.sheet.nativeHint": "Resumes from the start of the current sentence",
  "tts.sheet.httpHint": "Plays sentence by sentence as the server returns audio",
  "tts.sheet.bodyPlaceholder": '{"text": "{$TEXT}"} or text={$TEXT}',

  // Section titles
  "tts.section.engine": "Engine",
  "tts.section.voice": "Voice",
  "tts.section.httpConfig": "Custom source settings",
  "tts.section.rate": "Speed",
  "tts.section.timer": "Sleep timer",

  // Engines
  "tts.engine.native": "System voice",
  "tts.engine.nativeDesc": "System TTS",
  "tts.engine.http": "Custom source",
  "tts.engine.httpDesc": "HTTP endpoint",

  // Voices
  "tts.voice.loading": "Loading system voices…",
  "tts.voice.unavailable": "No system voices in this environment (requires running inside Tauri)",
  "tts.voice.none": "No voices found; the system default voice will be used",
  "tts.voice.default": "System default voice",

  // Pre-synthesis
  "tts.prewarm.book": "Pre-synthesize the whole book (saved to the per-book cache)",
  "tts.prewarm.bookAria": "Pre-synthesize the whole book",
  "tts.prewarm.running": "Pre-synthesizing {text}",

  // Custom source help
  "tts.help.heading": "Placeholders and encoding",
  "tts.help.text": "Text of the current sentence, URL-encoded once by default",
  "tts.help.noEncoding": "No encoding",
  "tts.help.doubleEncoding": "Encoded twice (the number can be anything)",
  "tts.help.rate": "Current speed value (1 / 1.5 / 2 …); the server changes tempo without pitch",
  "tts.help.rateClient":
    "With {$RATE} in the URL the client plays at normal speed; otherwise the client changes speed (pitch may shift)",
  "tts.help.postBody": "A POST body starting with { or [ is sent as JSON, anything else as form encoding",
  "tts.help.audioBytes": "The server should return audio bytes (mp3 / wav / ogg)",
  "tts.help.cache":
    "Synthesized audio is cached per book (Settings → Listening cache to view or clear)",

  // Timer
  "tts.timer.off": "Off",
  "tts.timer.minutes": "{count} minutes",
  "tts.timer.minutes_one": "{count} minute",
  "tts.timer.minutes_other": "{count} minutes",
  "tts.timer.chapterEnd": "End of chapter",
  "tts.timer.remaining": "Stops automatically in {time}",
  "tts.timer.chapterHint": "Stops automatically at the end of this chapter",

  // Actions
  "tts.action.stop": "Stop reading",

  // Floating controls (TtsBubble)
  "tts.bubble.prev": "Previous sentence",
  "tts.bubble.next": "Next sentence",
  "tts.bubble.pause": "Pause",
  "tts.bubble.play": "Play",

  // Playback notices (ttsPlayer notify)
  "tts.notify.bookFinished": "Finished reading this book",
  "tts.notify.noMoreContent": "No content in the following chapters; reading stopped",
  "tts.notify.laterNoText": "No readable text in the later chapters",
  "tts.notify.chapterNoTextTitle": "\"{title}\" has no readable text",
  "tts.notify.chapterNoText": "No readable text in this chapter",
  "tts.notify.chapterTimerEnd": "Timer: chapter finished",
  "tts.notify.timerEnd": "Timer finished; reading stopped",

  // Playback errors (ttsPlayer / ttsEngine / httpTts)
  "tts.error.nativeUnavailable":
    "System voices need the Tauri app (a real Android device); unavailable in this environment",
  "tts.error.nativePlugin": "The system speech plugin is unavailable; make sure you are on an Android device",
  "tts.error.nativeFallback": "System speech is unavailable; check the system speech settings",
  "tts.error.speech": "Speech error: {reason}",
  "tts.error.speechGeneric": "The system speech engine failed; try again later",
  "tts.error.synthFallback": "Speech synthesis failed; check the custom source settings and your network",
  "tts.error.playFailed": "Audio playback failed",
  "tts.error.decodeFailedLinux":
    "Audio decoding failed: the system lacks a decoder for this format (common on Linux without MP3 plugins); see the guide that just opened for the fix",
  "tts.error.decodeFailedHttp":
    "Audio decoding failed: the custom source must return decodable audio (mp3 / wav / ogg)",
  "tts.error.noUrl": "Set the custom source URL first (Listening settings → Custom source)",
  "tts.error.noText": "No text to read",
  "tts.error.timeout": "Custom source request timed out (45 s); check the URL and network",
  "tts.error.requestFailed": "Custom source request failed: {reason}",
  "tts.error.httpStatus": "Custom source returned an error: HTTP {status}",
  "tts.error.notAudio": "Custom source did not return audio (Content-Type: {contentType})",
  "tts.error.emptyAudio": "Custom source returned empty audio",

  // Audio decoder troubleshooting guide (TtsDecodeGuideDialog)
  "tts.guide.aria": "Audio decoding troubleshooting guide",
  "tts.guide.close": "Close the troubleshooting guide",
  "tts.guide.copyCommand": "Copy command: {cmd}",
  "tts.guide.heading": "Missing audio decoder",
  "tts.guide.cause":
    "Your GStreamer installation is missing the decoder plugin needed to play MP3. This is usually " +
    "because of MP3 patent licensing: many Linux distributions ship without the relevant plugins. " +
    "When WebKit plays audio it uses GStreamer, and with no component able to handle MPEG-1 Layer 3 " +
    "the decode fails.",
  "tts.guide.solutionLead": "Install the GStreamer plugin packages that include the MP3 decoder:",
  "tts.guide.debian": "Debian / Ubuntu and derivatives (Pop!_OS, Linux Mint)",
  "tts.guide.debianPackages":
    "gstreamer1.0-plugins-ugly contains patent-encumbered plugins (including the MP3 decoder); " +
    "gstreamer1.0-libav is based on FFmpeg and covers the widest range of codecs.",
  "tts.guide.debianFluendo": "Alternative: a plugin dedicated to MP3 decoding.",
  "tts.guide.fedora": "Fedora / CentOS / RHEL",
  "tts.guide.fedoraNote":
    "These systems need the RPM Fusion repositories enabled before patent-encumbered codec plugins can be installed.",
  "tts.guide.fedoraRepo": "Enable the RPM Fusion repositories (skip if already enabled).",
  "tts.guide.arch": "Arch Linux / Manjaro",
  "tts.guide.suse": "openSUSE",
  "tts.guide.verifyHeading": "Check that the plugin is installed",
  "tts.guide.verifyLead": "Use gst-inspect-1.0 to check whether the system sees an MP3 decoder:",
  "tts.guide.verifyExpect":
    "Seeing mad: mad, avdec_mp3: libav mp3 decoder or mpg123audiodec: mpg123 audio decoder means the install worked.",
  "tts.guide.extraRestart":
    "Restart the app: after installing the plugins, fully quit and start the app again (leaving the reader page is not enough) so the new plugins are loaded.",
  "tts.guide.extraLogs":
    "Check the logs: if the problem persists, open Settings → Debug → App logs, filter by Errors, and copy the log to trace the cause.",
  "tts.guide.extraFallback":
    "Alternative: have the custom source return WAV or Ogg audio; decoders for both usually come with the base plugins.",
  "tts.guide.ok": "Got it",
};
