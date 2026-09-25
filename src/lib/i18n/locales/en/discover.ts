/**
 * Discover page: online search, result list, book detail sheet and source group
 * filter, plus the user-facing errors of the online-book loader
 * (src/lib/online.ts) and the in-book search panel.
 */
export const discover = {
  // Page header and entry points
  "discover.page.manageSources": "Manage sources",
  "discover.page.sourcesLoading": "Loading sources…",
  "discover.page.noSources": "No enabled sources",
  "discover.page.goManageSources": "Manage sources",

  // Online search
  "discover.search.placeholder": "Search by title or author…",
  "discover.search.noSources": "No enabled source can search",
  "discover.search.groupNoSources": "No searchable enabled source in this group",
  "discover.search.progress": "Searching {done} / {total} sources ({parallel} in parallel)",
  "discover.search.failed": "Search failed: {message}",
  "discover.search.noResults": "No results found",
  "discover.search.foundMore": "{count} results so far · still searching other sources…",
  "discover.search.foundMore_one": "{count} result so far · still searching other sources…",
  "discover.search.foundMore_other": "{count} results so far · still searching other sources…",
  "discover.search.resultCount": "{count} results · tap to view details and add to shelf",
  "discover.search.resultCount_one": "{count} result · tap to view details and add to shelf",
  "discover.search.resultCount_other": "{count} results · tap to view details and add to shelf",

  // Browse (source categories)
  "discover.browse.noSources": "No enabled source supports discover",
  "discover.browse.groupNoSources": "No discover-capable enabled source in this group",
  "discover.browse.loadMore": "Load more",

  // Quick search on title / author / tag
  "discover.quickSearch.title": "Search title",
  "discover.quickSearch.author": "Search author",
  /** Accessible name of the tappable text: `{action}` is the action, `{text}` the searched word */
  "discover.quickSearch.aria": "{action}: {text}",

  // Online book detail sheet
  "discover.sheet.aria": "Online book details",
  "discover.sheet.title": "Book details",
  "discover.sheet.alreadyInShelf": "Already on shelf",

  // Online book info (shared by the detail sheet and the /online page)
  "discover.online.title": "Online book",
  "discover.online.expired": "This book is no longer available",
  "discover.online.expiredHint": "Go back to Discover and search again",
  "discover.online.readOnShelf": "Read from shelf",
  "discover.online.addNote":
    "Adding to the shelf saves only the chapter list; chapter text is cached on demand while reading (the current chapter and {window} chapters on each side), and the reader can batch download a chapter range for offline use",
  "discover.online.latest": "Latest: {value}",
  "discover.online.updateTime": "Updated: {value}",
  "discover.online.inShelf": "On shelf",
  "discover.online.intro": "Summary",
  "discover.online.noIntro": "No summary yet",
  "discover.online.introFailed": "Couldn't load the summary: {message}",
  "discover.online.introLoading": "Loading summary…",
  "discover.online.toc": "Chapters",
  "discover.online.tocCount": "{count} chapters",
  "discover.online.tocCount_one": "{count} chapter",
  "discover.online.tocCount_other": "{count} chapters",
  "discover.online.tocLoading": "Loading chapters…",
  "discover.online.tocFetching": "Fetching chapters…",
  "discover.online.tocUnsupported": "This source has no chapter list support, so chapters can't be previewed",
  "discover.online.tocNotReady": "Chapters aren't ready yet, can't add the book to the shelf",
  "discover.online.expandChapters": "Show all chapters ({count} more)",
  "discover.online.addToShelf": "Add to shelf",
  "discover.online.addAndRead": "Add and read",
  "discover.online.startReading": "Start reading",
  "discover.online.adding": "Adding…",

  // In-book search panel
  "discover.bookSearch.title": "Search in book",
  "discover.bookSearch.close": "Close book search",
  "discover.bookSearch.placeholder": "Search title or text",
  "discover.bookSearch.clear": "Clear search term",
  "discover.bookSearch.scopeTitle": "Title",
  "discover.bookSearch.scopeBody": "Text",
  "discover.bookSearch.kindTitle": "Chapter title",
  "discover.bookSearch.current": "Current",
  "discover.bookSearch.count": "{count} matches",
  "discover.bookSearch.count_one": "{count} match",
  "discover.bookSearch.count_other": "{count} matches",
  "discover.bookSearch.hint": "Type a keyword to search the book",
  "discover.bookSearch.hintDetail": "Matches chapter titles and text",
  "discover.bookSearch.noMatch": "No matches found",
  "discover.bookSearch.noMatchHint": "Try another search scope",
  "discover.bookSearch.truncated": "Too many matches, showing only {count} matches",
  "discover.bookSearch.truncated_one": "Too many matches, showing only {count} match",
  "discover.bookSearch.truncated_other": "Too many matches, showing only {count} matches",

  // Online book loading failures (src/lib/online.ts, shown to the user)
  "discover.error.tocFetchFailed": "Couldn't load the chapter list",
  "discover.error.tocNoArray": "bookToc returned no chapter array",
  "discover.error.tocEmpty": "Empty chapter list (the source returned no chapters)",
  "discover.error.chapterNoUrl": "Chapter has no URL",
  "discover.error.chapterFetchFailed": "Couldn't load the chapter text",
  "discover.error.reloadBusy": "This chapter is already reloading",
  "discover.error.reloadOtherBusy": "Another chapter is already reloading",
  "discover.error.tocChanged": "The chapter list changed, so this chapter wasn't saved",
  "discover.error.bookGone": "The book is no longer in the library, so it wasn't reloaded",
  "discover.error.chapterChanged": "The chapter changed, so it wasn't reloaded",
  "discover.error.notOnlineBook": "Not an online book, can't check for updates",
  "discover.error.missingBookUrl": "This book has no source URL, can't check for updates",
  "discover.error.sourceDeleted": "This source was deleted, can't check for updates",
  "discover.error.sourceDeletedForRefresh": "This source was deleted, can't refresh",
  "discover.error.sourceDisabled": "This source is disabled; enable it in Sources first",
  "discover.error.tocCapability": "This source has no chapter list support, can't check for updates",
  "discover.error.refreshOnlineOnly": "Only online books support refreshing book info",
  "discover.error.detailCapability": "This source has no detail support, can't refresh book info",
  "discover.error.refreshFailed": "Couldn't refresh book info",
};
