/**
 * Reader chrome: settings sheet, bookmark panel, selection menu, pagination and progress.
 *
 * Covers the reader overlays in src/components plus the user-facing strings of the lib
 * modules they depend on (bookmark chapter fallback, Han conversion and image failures).
 * The reading page itself (src/pages/Reader.tsx) owns the `reader.` prefix.
 */
export const readerChrome = {
  // Reading settings sheet
  "readerChrome.settings.title": "Reading settings",
  "readerChrome.settings.closeLabel": "Close reading settings",
  "readerChrome.settings.textReplace": "Text replacement",
  "readerChrome.settings.textReplaceDesc": "Replaces text while reading; the original file is untouched",
  "readerChrome.settings.statusBar": "Bottom status bar",
  "readerChrome.settings.statusBarDesc": "Keeps the chapter name and reading progress below the text",
  "readerChrome.settings.progressScope": "Progress percentage",
  "readerChrome.settings.progressScopeDesc": "Which range the status bar percentage covers",
  "readerChrome.settings.scopeBook": "Whole book",
  "readerChrome.settings.scopeChapter": "Current chapter",
  "readerChrome.settings.menuSlider": "Menu progress bar",
  "readerChrome.settings.menuSliderDesc": "Shown above the menu in paged mode; drag to jump to a page",
  "readerChrome.settings.checkUpdate": "Check for updates",
  "readerChrome.settings.checkUpdateDesc": "Refetches the source catalog and appends new chapters",
  "readerChrome.settings.checkUpdateBusy": "Checking for updates…",
  "readerChrome.settings.reloadChapter": "Reload this chapter",
  "readerChrome.settings.reloadChapterDesc": "Refetches this chapter's text from the source",
  "readerChrome.settings.reloadChapterBusyDesc": "Refetching this chapter's text",
  "readerChrome.settings.reloadChapterBusy": "Reloading this chapter…",

  // Reading settings rows (shared with the settings page)
  "readerChrome.reading.fontSize": "Text size",
  "readerChrome.reading.fontSizeDecrease": "Decrease text size",
  "readerChrome.reading.fontSizeIncrease": "Increase text size",
  "readerChrome.reading.paraSpacing": "Paragraph spacing",
  "readerChrome.reading.paraSpacingDesc": "Space between paragraphs",
  "readerChrome.reading.pageMode": "Page mode",
  "readerChrome.reading.pageModePaged": "Page turn",
  "readerChrome.reading.pageModeScroll": "Scroll",
  "readerChrome.reading.hanMode": "Chinese conversion",
  "readerChrome.reading.hanModeDesc": "Titles, intros, contents and text",
  "readerChrome.reading.hanOff": "Off",
  "readerChrome.reading.hanS2T": "Simp. → Trad.",
  "readerChrome.reading.hanT2S": "Trad. → Simp.",

  // Text selection menu
  "readerChrome.selection.bookmark": "Bookmark",
  "readerChrome.selection.speak": "Read aloud",
  "readerChrome.selection.replace": "Replace",

  // Bookmark panel
  "readerChrome.bookmark.title": "Bookmarks",
  "readerChrome.bookmark.closeLabel": "Close bookmarks",
  /** Base keys are required by MessageKey; the plural variants are what `t()` picks */
  "readerChrome.bookmark.totalCount": "{count} bookmarks",
  "readerChrome.bookmark.totalCount_one": "{count} bookmark",
  "readerChrome.bookmark.totalCount_other": "{count} bookmarks",
  /** Chapter-count suffix appended to the total; only rendered for 2+ chapters */
  "readerChrome.bookmark.chapterCount": " · {count} chapters",
  "readerChrome.bookmark.chapterCount_one": " · {count} chapter",
  "readerChrome.bookmark.chapterCount_other": " · {count} chapters",
  "readerChrome.bookmark.foundCount": "Found {count} matches",
  "readerChrome.bookmark.foundCount_one": "Found {count} match",
  "readerChrome.bookmark.foundCount_other": "Found {count} matches",
  "readerChrome.bookmark.itemCount": "{count} items",
  "readerChrome.bookmark.itemCount_one": "{count} item",
  "readerChrome.bookmark.itemCount_other": "{count} items",
  "readerChrome.bookmark.currentBadge": "This chapter",
  "readerChrome.bookmark.deleteLabel": "Delete bookmark",
  "readerChrome.bookmark.emptyTitle": "No bookmarks yet",
  "readerChrome.bookmark.emptyHint": 'Select text in the book and tap "Bookmark" to add one',
  "readerChrome.bookmark.searchPlaceholder": "Search chapters or bookmark text",
  "readerChrome.bookmark.clearSearch": "Clear search",
  "readerChrome.bookmark.noMatch": "No matching bookmarks",
  "readerChrome.bookmark.noMatchHint": "Search chapter titles or the text inside bookmarks",
  /** Chapter label used when the chapter has no title */
  "readerChrome.bookmark.chapterFallback": "Chapter {index}",

  // Bookmark-loss warning before re-importing
  "readerChrome.bookmarkRisk.title": "Some bookmarks may break",
  "readerChrome.bookmarkRisk.dialogLabel": 'Re-importing "{title}" may invalidate bookmarks',
  "readerChrome.bookmarkRisk.allFailed":
    'After re-importing "{title}", all {count} bookmarks can no longer be located in the new content: ',
  "readerChrome.bookmarkRisk.allFailed_one":
    'After re-importing "{title}", its {count} bookmark can no longer be located in the new content: ',
  "readerChrome.bookmarkRisk.allFailed_other":
    'After re-importing "{title}", all {count} bookmarks can no longer be located in the new content: ',
  "readerChrome.bookmarkRisk.someFailed":
    'After re-importing "{title}", {failed} of {count} bookmarks can no longer be located precisely in the new content: ',
  "readerChrome.bookmarkRisk.someFailed_one":
    'After re-importing "{title}", {failed} of {count} bookmark can no longer be located precisely in the new content: ',
  "readerChrome.bookmarkRisk.someFailed_other":
    'After re-importing "{title}", {failed} of {count} bookmarks can no longer be located precisely in the new content: ',
  "readerChrome.bookmarkRisk.reason":
    "The text may have changed or the chapters may have shifted, so these bookmarks may fail to jump or land in the wrong place.",
  "readerChrome.bookmarkRisk.restKept": "The other bookmarks will be kept as they are.",
  "readerChrome.bookmarkRisk.cancelHint": "Cancel the re-import to keep the current content and bookmarks.",
  "readerChrome.bookmarkRisk.proceed": "Re-import anyway",
  "readerChrome.bookmarkRisk.importing": "Importing…",

  // Chapter page slider
  "readerChrome.pageSlider.label": "Chapter page progress",
  "readerChrome.pageSlider.valueText": "Page {page} of {total}",

  // Chapter range sheet
  "readerChrome.chapterRange.hint": "Chapters {min}–{max}",
  /** Halves of the chapter-number input label; English keeps only the prefix */
  "readerChrome.chapterRange.ordinalPrefix": "Chapter",
  "readerChrome.chapterRange.ordinalSuffix": "",
  "readerChrome.chapterRange.ordinalLabel": "Chapter number",
  "readerChrome.chapterRange.notCached": "Not cached",

  // Pagination and image loading (user-facing strings inside lib)
  "readerChrome.page.authorBy": "by {author}",
  "readerChrome.image.downloadFailed": "Image download failed",
  "readerChrome.han.dictLoadFailed": "Couldn't load the Chinese conversion dictionary",
  "readerChrome.han.settingsLoadFailed": "Couldn't load the Chinese conversion setting",
  "readerChrome.han.dictRequestFailed": "Dictionary request failed: HTTP {status}",
  "readerChrome.han.dictMismatch": "The dictionary doesn't match this build (rebuild required)",
};
