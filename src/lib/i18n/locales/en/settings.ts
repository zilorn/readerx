/**
 * Settings page and the "open source license / third-party notices / app logs /
 * TTS cache" screens (English).
 *
 * The LICENSE and THIRD-PARTY-NOTICES.md bodies ship with the app and are read by
 * Rust; only the container chrome (titles, descriptions, accessibility labels) lives here.
 */
export const settings = {
  // Section headings (the Bookshelf section reuses shell.tab.shelf, the page title shell.tab.settings)
  "settings.section.appearance": "Appearance",
  "settings.section.reading": "Reading",
  "settings.section.sources": "Sources",
  "settings.section.import": "Import",
  "settings.section.data": "Data",
  "settings.section.debug": "Debug",
  "settings.section.about": "About",

  // Appearance: theme (row title and radiogroup label share one key)
  "settings.theme.title": "Theme",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.theme.sepia": "Sepia",

  // Sources
  "settings.sources.manage": "Manage sources",
  "settings.sources.manageDesc": "Manage online book sources and source features",
  "settings.sources.parallel": "Source concurrency",
  "settings.sources.parallelDesc": "How many sources run at once during a search",
  "settings.sources.parallelDecrease": "Decrease source concurrency",
  "settings.sources.parallelIncrease": "Increase source concurrency",

  // Import
  "settings.chapterRules.title": "Chapter rules",
  "settings.chapterRules.desc": "Manage automatic chapter splitting for imported TXT files",

  // Bookshelf
  "settings.shelf.sourceFilter": "Source filter",
  "settings.shelf.sourceFilterDesc": "Show the Local / WebDAV / Online filter at the top of the bookshelf",
  "settings.shelf.sourceFilterToggle": "Bookshelf source filter",

  // Data
  "settings.data.ttsCache": "Manage TTS cache",
  "settings.data.ttsCacheDesc": "View and delete the synthesized audio cached for each book",
  "settings.data.resetProgress": "Reset all reading progress",
  "settings.data.resetConfirm": "Tap again to confirm the reset",
  "settings.data.resetProgressDesc": "Every book goes back to chapter 1; local book files are kept",

  // Debug
  "settings.debug.logsDesc": "View recent backend and UI logs; copy or clear them",
  "settings.debug.devTools": "Developer tools",
  "settings.debug.devToolsDesc": "Open the WebView developer tools",

  // About
  "settings.about.tagline": "Local ebook reader",
  "settings.about.github": "GitHub page",
  "settings.about.githubDesc": "Browse the source code and releases",
  "settings.about.builtWith": "ReaderX {version} · Built with Tauri 2",

  // Open source license (the sheet title is the license name "GNU General Public License v3.0" and stays as is)
  "settings.license.title": "Open source license",
  "settings.license.subtitle": "ReaderX open source license",
  "settings.license.close": "Close open source license",
  "settings.license.error": "Couldn't read the license text",

  // Third-party notices
  "settings.notices.title": "Third-party notices",
  "settings.notices.subtitle": "Open source libraries used by ReaderX",
  "settings.notices.desc": "Third-party open source libraries, their licenses and uses",
  "settings.notices.close": "Close third-party notices",
  "settings.notices.error": "Couldn't read the third-party notices",

  // TTS cache
  "settings.ttsCache.title": "TTS cache",
  "settings.ttsCache.subtitle": "Audio synthesized on this device",
  "settings.ttsCache.limitTitle": "Limit per book",
  "settings.ttsCache.unlimited": "Unlimited",
  "settings.ttsCache.segments": "{count} segments",
  "settings.ttsCache.segments_one": "{count} segment",
  "settings.ttsCache.segments_other": "{count} segments",
  "settings.ttsCache.limitNote": "The limit applies to each book separately; once it is full, new audio replaces the oldest. Pick Unlimited to keep everything",
  "settings.ttsCache.booksTitle": "Cached books",
  "settings.ttsCache.booksDesc": "Audio synthesized from custom sources is saved on this device per book. Listening to the same book with the same voice reuses the cache, and deleting a book clears its cache automatically",
  "settings.ttsCache.empty": "No cached audio yet",
  "settings.ttsCache.bookUsage": "{count} segments · {size}",
  "settings.ttsCache.bookUsage_one": "{count} segment · {size}",
  "settings.ttsCache.bookUsage_other": "{count} segments · {size}",
  /** "used / limit" form: the noun follows the limit, so it takes no {count} and no plural variants */
  "settings.ttsCache.bookUsageLimited": "{used} / {limit} segments · {size}",
  "settings.ttsCache.clear": "Clear",
  "settings.ttsCache.clearAll": "Delete all cached audio",
  "settings.ttsCache.clearAllDesc": "Deletes the synthesized audio of every book; it will be synthesized again the next time you listen",

  /** Two-step confirmation, shared by clearing the TTS cache and clearing the logs */
  "settings.action.clearConfirm": "Tap again to confirm",

  // App logs (sheet)
  "settings.logs.title": "App logs",
  "settings.logs.close": "Close app logs",
  /** Logs are split per day and per launch; this row is the file picker's label and the "being written now" mark */
  "settings.logs.file": "File",
  "settings.logs.runCurrent": "{moment} · current",
  "settings.logs.filterInfo": "Info",
  "settings.logs.filterWarn": "Warning",
  "settings.logs.filterError": "Error",
  "settings.logs.copy": "Copy logs",
  "settings.logs.copyEmpty": "No logs to copy",
  "settings.logs.copied": "Logs copied to clipboard",
  "settings.logs.copyFailed": "Couldn't copy logs",
  "settings.logs.refresh": "Refresh logs",
  "settings.logs.level": "Level",
  "settings.logs.levelNormal": "Normal",
  "settings.logs.levelVerbose": "Verbose",
  "settings.logs.verboseOn": "Verbose logging is on",
  "settings.logs.verboseOff": "Back to normal logging",
  "settings.logs.levelFailed": "Couldn't change the log level",
  "settings.logs.verboseNote": "Verbose logging records every request and parse; switch back to Normal once you are done troubleshooting",
  "settings.logs.cleared": "Logs cleared",
  "settings.logs.clearFailed": "Couldn't clear logs",
  "settings.logs.empty": "No logs yet",
  "settings.logs.emptyAtLevel": "No logs at this level",
  "settings.logs.readFailed": "Couldn't read logs: {reason}",
  "settings.logs.browserOnly": "Logs are only available in the app (the browser dev build has no backend logs)",
  "settings.logs.inAppOnly": "Logs are only available in the app",
  "settings.logs.levelInAppOnly": "The log level can only be changed in the app",
};
