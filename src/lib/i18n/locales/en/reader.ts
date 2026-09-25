/**
 * Reader page (English).
 *
 * Keep this file in sync with `zh-CN/reader.ts`: same keys, same placeholders.
 * Book text, chapter titles, author names and source URLs are user data and stay
 * untranslated; the library's author sentinel (Chinese for "unknown author") is a
 * stored value, not UI copy, so the comparison against it is left as is.
 */
export const reader = {
  // General states
  "reader.backToShelf": "Back to shelf",
  "reader.bookMissing": "This book is missing or was deleted",
  "reader.loadingBook": "Loading book…",
  "reader.loading": "Loading…",
  "reader.typesetting": "Formatting…",
  "reader.currentChapter": "Current chapter",
  "reader.thisChapter": "this chapter",
  "reader.authorSuffix": "by {author}",
  "reader.tapCenterHint": "Tap the center of the screen for the menu",
  "reader.listSeparator": ", ",

  // Chapters and progress
  "reader.chapterOrdinal": "Chapter {index}",
  "reader.chapterRange": "Chapters {from}–{to}",
  "reader.prevChapter": "Previous chapter",
  "reader.nextChapter": "Next chapter",
  "reader.chapterCount": "{count} chapters",
  "reader.chapterCount_one": "{count} chapter",
  "reader.chapterCount_other": "{count} chapters",
  "reader.chapterCountShort": "{count} chapters",
  "reader.chapterCountShort_one": "{count} chapter",
  "reader.chapterCountShort_other": "{count} chapters",
  "reader.textChapterCount": "{count} chapters",
  "reader.textChapterCount_one": "{count} chapter",
  "reader.textChapterCount_other": "{count} chapters",
  "reader.imageCount": "{count} images",
  "reader.imageCount_one": "{count} image",
  "reader.imageCount_other": "{count} images",
  "reader.menuChapterProgress": "{index}/{total} chapters",
  "reader.menuChapterProgress_one": "{index}/{total} chapter",
  "reader.menuChapterProgress_other": "{index}/{total} chapters",
  "reader.statusPageProgress": " · {page} / {total} pages",
  "reader.statusPageProgress_one": " · {page} / {total} page",
  "reader.statusPageProgress_other": " · {page} / {total} pages",
  "reader.statusPageRange": " · {from}–{to} / {total} pages",
  "reader.statusPageRange_one": " · {from}–{to} / {total} page",
  "reader.statusPageRange_other": " · {from}–{to} / {total} pages",
  "reader.menuPageProgress": " · {page}/{total} pages",
  "reader.menuPageProgress_one": " · {page}/{total} page",
  "reader.menuPageProgress_other": " · {page}/{total} pages",
  "reader.menuPageRange": " · {from}–{to}/{total} pages",
  "reader.menuPageRange_one": " · {from}–{to}/{total} page",
  "reader.menuPageRange_other": " · {from}–{to}/{total} pages",

  // Table of contents drawer
  "reader.toc": "Contents",
  "reader.closeToc": "Close contents",
  "reader.searchBook": "Search book",
  "reader.badgeDownloading": "Downloading",
  "reader.badgeDownload": "Download",
  "reader.badgeCurrent": "Current",

  // Image placeholders
  "reader.imageMissing": "Image missing",
  "reader.imageShort": "Image",
  "reader.reloadImage": "Reload image",
  "reader.imageReloadFailed": "Image reload failed: {error}",
  "reader.fetchingImages": "Fetching images {settled} / {total}",

  // Bookmarks
  "reader.bookmarkAdded": "Bookmark added",
  "reader.bookmarkRemoved": "Bookmark removed",
  "reader.bookmarkFailed": "Couldn't add bookmark",
  "reader.bookmarkNoContent": "Can't bookmark this content",
  "reader.bookmarkSelectText": "Select the text to bookmark",
  "reader.bookmarkOverlap": "Selection overlaps an existing bookmark",
  "reader.bookmarkTooLong": "Selection is too long to bookmark",
  "reader.bookmarkNeedParagraph": "Select text inside a paragraph to bookmark",
  "reader.bookmarkNotFound": "Couldn't locate that bookmark",

  // Selection and copy
  "reader.copyFailed": "Copy failed",
  "reader.adjustSelectionStart": "Adjust selection start",
  "reader.adjustSelectionEnd": "Adjust selection end",

  // Menu, toolbar, search mode
  "reader.readingSettings": "Reading settings",
  "reader.bookmarks": "Bookmarks",
  "reader.downloadTitle": "Download text",
  "reader.ttsListen": "Listen",
  "reader.ttsStop": "Stop listening",
  "reader.resumeFollow": "Follow along",
  "reader.restoreProgress": "Back to previous position",
  "reader.closeRestoreHint": "Close this hint",
  "reader.restorePreSearchPosition": "Back to your position before search",
  "reader.backToSearchResults": "Back to search results",
  "reader.searchingTerm": "Searching \"{term}\"",
  "reader.prevResult": "Previous result",
  "reader.nextResult": "Next result",
  "reader.prev": "Prev",
  "reader.next": "Next",
  "reader.exitSearchMode": "Exit search",

  // Online books: fetching, reloading, contents update
  "reader.fetchingChapter": "Fetching chapter…",
  "reader.phaseDownload": "Downloading",
  "reader.phaseWindow": "Prefetching ahead",
  "reader.cachedChaptersReadable": "Cached chapters are still readable",
  "reader.fetchCancelled": "Fetch cancelled",
  "reader.fetchFailed": "Couldn't fetch chapter",
  "reader.retryFetch": "Try again",
  "reader.chapterEmpty": "This chapter is empty",
  "reader.chapterEmptyHint":
    "Fetched from the source, but no text was parsed. The chapter may be empty, or reload it to fetch again.",
  "reader.reloadChapter": "Reload chapter",
  "reader.reloadingChapter": "Reloading…",
  "reader.reloadingChapterOverlay": "Reloading this chapter…",
  "reader.reloadChapterHint":
    "Fetching the text again from the source. This chapter will be replaced when it finishes.",
  "reader.reloadFailedBackToProgress":
    "Reload failed, back to your previous position: {error}",
  "reader.reloadedChapter": "Reloaded \"{title}\"",
  "reader.tocUpToDate": "Contents are up to date",
  "reader.tocAppended": "Added {count} chapters",
  "reader.tocAppended_one": "Added {count} chapter",
  "reader.tocAppended_other": "Added {count} chapters",
  "reader.updateCheckFailed": "Update check failed: {error}",
  "reader.tocOverwritten": "Contents replaced, {count} chapters",
  "reader.tocOverwritten_one": "Contents replaced, {count} chapter",
  "reader.tocOverwritten_other": "Contents replaced, {count} chapters",
  "reader.overwriteFailed": "Overwrite failed: {error}",

  // Text-to-speech warm-up (the sheet renders the progress line)
  "reader.prewarmPreparing": "Preparing…",
  "reader.prewarmDone": "Pre-warm complete: {count} sentences cached",
  "reader.prewarmDone_one": "Pre-warm complete: {count} sentence cached",
  "reader.prewarmDone_other": "Pre-warm complete: {count} sentences cached",

  // Online books: batch download
  "reader.downloadSummary": "{total} chapters · {done} downloaded",
  "reader.downloadSummary_one": "{total} chapter · {done} downloaded",
  "reader.downloadSummary_other": "{total} chapters · {done} downloaded",
  "reader.downloadHint":
    "Reading normally caches only the current chapter and {window} chapters on each side, so sequential reading never breaks. Here you can download the selected range to this device and read it offline later.",
  "reader.downloadConcurrencyHint":
    "Request concurrency follows the global \"Source concurrency\" setting (Settings → Sources).",
  "reader.downloadRangeLabel": "Download range",
  "reader.wholeBook": "Whole book",
  "reader.startChapter": "Start chapter",
  "reader.endChapter": "End chapter",
  "reader.rangeTo": "to",
  "reader.pendingInRange": "{count} chapters left to download",
  "reader.pendingInRange_one": "{count} chapter left to download",
  "reader.pendingInRange_other": "{count} chapters left to download",
  "reader.imageDownloadHint":
    "Chapters with images (comics, illustrated books) download their images after the text, and chapters you read are cached along the way. Storage use grows with the number of images.",
  "reader.phaseWindowBusy": "Prefetching ahead…",
  "reader.phaseImages": "Downloading images…",
  "reader.phaseDownloading": "Downloading…",
  "reader.chaptersFailed": "{count} chapters failed",
  "reader.chaptersFailed_one": "{count} chapter failed",
  "reader.chaptersFailed_other": "{count} chapters failed",
  "reader.imagesFailedRetry":
    "{count} images failed (tap one while reading to retry)",
  "reader.imagesFailedRetry_one":
    "{count} image failed (tap it while reading to retry)",
  "reader.imagesFailedRetry_other":
    "{count} images failed (tap one while reading to retry)",
  "reader.chaptersNotDownloaded": "{count} chapters weren't downloaded last time",
  "reader.chaptersNotDownloaded_one":
    "{count} chapter wasn't downloaded last time",
  "reader.chaptersNotDownloaded_other":
    "{count} chapters weren't downloaded last time",
  "reader.imagesNotDownloaded":
    "{count} images weren't downloaded (tap one while reading to retry)",
  "reader.imagesNotDownloaded_one":
    "{count} image wasn't downloaded (tap it while reading to retry)",
  "reader.imagesNotDownloaded_other":
    "{count} images weren't downloaded (tap one while reading to retry)",
  "reader.stopDownload": "Stop download",
  "reader.downloading": "Downloading…",
  "reader.downloadRemaining": "Download all remaining",
  /** Built from reader.chapterOrdinal / reader.chapterRange (one chapter or a range) */
  "reader.downloadRangeButton": "Download {range}",
  "reader.downloadRangeDone": "{range} already downloaded",
  "reader.downloadAllDone": "All chapters are already downloaded",
  "reader.downloadDoneCached": "Download complete: {items} cached",
  "reader.downloadDoneFailed": "Download complete: {items}; {failed} failed",
  "reader.downloadStorageNote":
    "Downloads are saved in your local library and removed with the book.",
};
