/** Bookshelf, shelf search, import entry, book covers and tags (English) */
export const shelf = {
  // Shelf header
  "shelf.title": "Bookshelf",
  "shelf.loading.library": "Loading your library…",
  "shelf.onShelfCount": "{count} books on the shelf",
  "shelf.onShelfCount_one": "{count} book on the shelf",
  "shelf.onShelfCount_other": "{count} books on the shelf",
  "shelf.searchAria": "Search the bookshelf",

  // Book cards
  "shelf.openAria": 'Open "{title}"',
  "shelf.selectBookAria": 'Select "{title}"',
  "shelf.deselectBookAria": 'Deselect "{title}"',
  "shelf.progress.finished": "Finished",
  "shelf.progress.percent": "{percent}% read",

  // Multi-select
  "shelf.select.title": "Select books",
  "shelf.select.count": "{count} books selected",
  "shelf.select.count_one": "{count} book selected",
  "shelf.select.count_other": "{count} books selected",
  "shelf.select.allAria": "Select all visible books",
  "shelf.select.noneAria": "Deselect all visible books",
  "shelf.select.exitAria": "Cancel selection",
  "shelf.select.hint":
    "Long-press a book to select it; tap a selected book to deselect, then move the selection to a group or delete it below",
  "shelf.select.moveToGroup": "Move to group",
  "shelf.select.confirmDelete": "Confirm delete",

  // Filter chips (source names are shared with the cover's "Online" badge)
  "shelf.source.local": "Local",
  "shelf.source.online": "Online",

  // Empty states
  "shelf.empty.noBooks": "Your bookshelf is empty",
  "shelf.empty.noBooksHint": "Import TXT / EPUB / PDF files to your shelf",
  "shelf.empty.allHidden": "All books are hidden",
  "shelf.empty.allHiddenHint": "Tap the Hidden group above to see them",
  "shelf.empty.group": "No books in this group",
  "shelf.empty.groupHint": "Tap All at the top of the shelf to see your other books",
  "shelf.empty.noMatch": "No books match this filter",
  "shelf.empty.noMatchHint": "Change the filter at the top of the shelf to see other books",

  // Import entry
  "shelf.import.title": "Import books",
  "shelf.import.local": "Import a local book",
  "shelf.import.localDesc": "Pick a TXT / EPUB / PDF from this device",
  "shelf.import.webdav": "Import from WebDAV",
  "shelf.import.webdavDesc": "Browse your WebDAV library",
  "shelf.import.importing": "Importing…",
  "shelf.import.imported": 'Imported "{title}"',
  "shelf.import.added": 'Added "{title}"',
  "shelf.import.reimported": 'Re-imported "{title}"',
  "shelf.import.failed": "Import failed",
  "shelf.import.failedCheckFile": "Import failed, check the file",
  "shelf.import.reimportFailed": "Re-import failed",
  "shelf.import.reimportCancelled": "Re-import cancelled",
  "shelf.import.readFailed": "Couldn't read the selected file",
  /** The three parse errors (thrown by books.ts, shown straight in a toast) */
  "shelf.import.errorUnsupported": "Only .txt, .epub, and .pdf files can be imported",
  "shelf.import.errorEmptyTxt": "This TXT file is empty and can't be imported",
  "shelf.import.errorNoContent": "No readable content found in this file",

  // Same-name book conflict dialog
  "shelf.import.conflictTitle": '"{title}" is already on your shelf',
  "shelf.import.conflictDesc":
    "Re-importing replaces this book's content with the selected file; reading progress, group, and bookmarks are carried over where possible. You can also keep the original and add the selected file as a new book.",
  "shelf.import.reimport": "Re-import",
  "shelf.import.checkingBookmarks": "Checking bookmarks…",
  "shelf.import.addAsNew": "Add as a new book",

  // Shelf search
  "shelf.search.title": "Search shelf",
  "shelf.search.back": "Back to shelf",
  "shelf.search.placeholder": "Title / author / file name",
  "shelf.search.clear": "Clear search",
  "shelf.search.resultCount": "{count} books",
  "shelf.search.resultCount_one": "{count} book",
  "shelf.search.resultCount_other": "{count} books",
  "shelf.search.prompt": "Type to start searching",
  "shelf.search.promptHint": "Fuzzy matches title, author, and file name",
  "shelf.search.noResults": "No matching books",

  // Cover and tags
  "shelf.cover.ariaLabel": "Cover of {title}",
  "shelf.tag.removeAria": "Remove tag {tag}",
};
