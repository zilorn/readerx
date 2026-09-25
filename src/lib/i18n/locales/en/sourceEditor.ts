/** 书源编辑器 (English) */
export const sourceEditor = {
  // Editor shell
  "sourceEditor.title.new": "New source",
  "sourceEditor.title.edit": "Edit source",
  "sourceEditor.action.save": "Save",
  "sourceEditor.tabs.label": "Source editor",
  "sourceEditor.tab.info": "Source info",
  "sourceEditor.tab.code": "JavaScript",
  "sourceEditor.tab.test": "Test",
  "sourceEditor.code.docHint":
    "Entry functions and host APIs: docs/book-source-spec.md / docs/book-source-api.md",
  "sourceEditor.code.fillTemplate": "Fill in template",
  "sourceEditor.code.confirmOverwrite": "Tap again to overwrite",
  "sourceEditor.code.ariaLabel": "Source JavaScript",

  // Source info form
  "sourceEditor.form.name": "Name",
  "sourceEditor.form.bookSourceUrl": "Site URL (bookSourceUrl)",
  "sourceEditor.form.author": "Author",
  "sourceEditor.form.version": "Version",
  "sourceEditor.form.group": "Group",
  "sourceEditor.form.enabled": "Enable source",
  /** Accessible label of a capability switch (its visible text stays CAPABILITY_LABELS) */
  "sourceEditor.form.ability": "{name} capability",
  "sourceEditor.form.userAgent":
    "User-Agent (blank uses the built-in default; set a browser UA here for sites behind Cloudflare)",
  "sourceEditor.form.headers":
    "Default headers (one \"Name: value\" per line; paste cookies here, see docs/cloudflare.md for Cloudflare sites)",
  "sourceEditor.form.webLogin": "Web login",
  "sourceEditor.form.webLoginHint":
    "Sign in inside the WebView overlay to capture cookies, including httpOnly ones",
  "sourceEditor.form.autoAuth": "Automatic web auth",
  "sourceEditor.form.autoAuthHint":
    "Opens the auth window and retries when a request hits a Cloudflare challenge (expired tokens refresh automatically); the source script's webview.login is controlled by this switch too",
  "sourceEditor.form.autoAuthOff":
    "Off: blocked requests no longer open the auth window, and the source script's webview.login reports unavailable; \"Open login page\" below is unaffected",
  "sourceEditor.form.loginOpening": "Login window open…",
  "sourceEditor.form.openLogin": "Open login page",
  "sourceEditor.form.clearLogin": "Clear login cookies",
  "sourceEditor.form.unsupported":
    "Web login is not supported on this platform (in-app overlay on Android, separate login window on desktop); call webview.login(url) from your script instead.",

  // Saving and deleting
  "sourceEditor.validation.nameRequired": "Name is required",
  "sourceEditor.validation.urlRequired": "Site URL is required",
  "sourceEditor.validation.jsRequired": "JavaScript is required",
  "sourceEditor.validation.loginUrl": "Enter a valid http/https login URL",
  "sourceEditor.unnamedSource": "Untitled source",
  "sourceEditor.saved": "Source saved",
  "sourceEditor.deleted": "Source deleted",
  "sourceEditor.deleteConfirm": "Tap again to delete",
  "sourceEditor.action.deleteSource": "Delete source",

  // Test
  "sourceEditor.test.argsInvalid": "Arguments are not a valid JSON array",
  "sourceEditor.test.ok": "OK · {ms}ms",
  "sourceEditor.test.noResult": "No return value",

  // Web login results
  "sourceEditor.login.cookieCount": "{count} cookies",
  "sourceEditor.login.cookieCount_one": "{count} cookie",
  "sourceEditor.login.cookieCount_other": "{count} cookies",
  "sourceEditor.login.storageCount": "{count} storage entries",
  "sourceEditor.login.storageCount_one": "{count} storage entry",
  "sourceEditor.login.storageCount_other": "{count} storage entries",
  /** Joins the captured items: "A and B" (used when a login captured at least two kinds) */
  "sourceEditor.login.join": " and ",
  "sourceEditor.login.captured": "Captured {parts} and saved to this source",
  "sourceEditor.login.nothingCaptured": "Login finished, but no login data was captured",
  "sourceEditor.login.cancelled": "Login cancelled",
  "sourceEditor.login.failed": "Login failed",
  "sourceEditor.login.cleared": "Login data cleared",
  "sourceEditor.login.none": "No saved login data",

  // Import confirm sheet
  "sourceEditor.import.ariaLabel": "Import sources",
  "sourceEditor.import.title": "Import sources",
  "sourceEditor.import.summary": "{create} new · {overwrite} overwritten",
  "sourceEditor.import.disclaimer":
    "Community and third-party sources are not affiliated with ReaderX or its authors, who took no part in creating them. Source JavaScript runs in a local sandbox, but its safety cannot be guaranteed — only import sources you trust.",
  "sourceEditor.import.skipped": "Skipped {count} unreadable entries: {items}",
  "sourceEditor.import.skipped_one": "Skipped 1 unreadable entry: {items}",
  /** Separator between unreadable entries (UI concatenation only) */
  "sourceEditor.import.issueSeparator": "; ",
  "sourceEditor.import.duplicateTitle":
    "Sources already on this device (same name and site); imported content overwrites them by default",
  "sourceEditor.import.skip": "Skip",
  "sourceEditor.import.overwrite": "Overwrite",
  "sourceEditor.import.overwriteAria": "Overwrite source {name}",
  "sourceEditor.import.groupsTitle": "Groups in the imported content",
  "sourceEditor.import.grouped": "Grouped",
  "sourceEditor.import.groupToggleAria": "Import groups by group name",
  "sourceEditor.import.groupCount": "{count} · {state}",
  "sourceEditor.import.groupCount_one": "{count} source · {state}",
  "sourceEditor.import.groupCount_other": "{count} sources · {state}",
  "sourceEditor.import.groupExisting": "existing",
  "sourceEditor.import.groupNew": "new",
  "sourceEditor.import.apply": "Import anyway",
  "sourceEditor.import.pasteMore": "Continue with paste import",

  // Paste import sheet
  "sourceEditor.paste.ariaLabel": "Paste sources to import",
  "sourceEditor.paste.title": "Paste import",
  "sourceEditor.paste.subtitle": "Source JSON or a JSON URL",
  /** Input hint: the JSON keys stay as they are, only the sample name is translated */
  "sourceEditor.paste.placeholder": '[{"name": "Source name", "bookSourceUrl": "https://…"}]',
  "sourceEditor.paste.readClipboard": "Read clipboard",
  "sourceEditor.paste.url": "URL",
  "sourceEditor.paste.charCount": "{count} characters",
  "sourceEditor.paste.charCount_one": "{count} character",
  "sourceEditor.paste.charCount_other": "{count} characters",
  "sourceEditor.paste.emptyClipboard":
    "Nothing to import in the clipboard; paste or type the JSON directly",
  "sourceEditor.paste.failed": "Import failed",
  "sourceEditor.paste.processing": "Working…",
  "sourceEditor.paste.fetch": "Fetch and import",
  "sourceEditor.paste.parse": "Parse and import",

  // Reload-chapter bookmark risk dialog
  "sourceEditor.reload.ariaLabel": "Reloading \"{chapterTitle}\" may invalidate bookmarks",
  "sourceEditor.reload.title": "Bookmarks may break after reloading",
  "sourceEditor.reload.allFailed":
    "All {count} bookmarks in this chapter will lose their exact position in the refreshed text: reloading replaces this chapter with the latest text from the source, and those bookmarks may fail to jump or land in the wrong place.",
  "sourceEditor.reload.allFailed_one":
    "The only bookmark in this chapter will lose its exact position in the refreshed text: reloading replaces this chapter with the latest text from the source, and it may fail to jump or land in the wrong place.",
  "sourceEditor.reload.partialFailed":
    "{failed} of the {total} bookmarks in this chapter will lose their exact position in the refreshed text: reloading replaces this chapter with the latest text from the source, and those bookmarks may fail to jump or land in the wrong place.",
  "sourceEditor.reload.restKept": "The other bookmarks are unaffected and stay as they are.",
  "sourceEditor.reload.keepHint":
    "Cancel this reload to keep the current text and bookmarks of this chapter.",
  "sourceEditor.reload.proceed": "Reload anyway",

  // Online table of contents overwrite dialog
  "sourceEditor.toc.ariaLabel": "Overwrite the table of contents of \"{bookTitle}\"",
  "sourceEditor.toc.title": "Table of contents differs from the shelf",
  "sourceEditor.toc.desc":
    "The source returned a newer table of contents for \"{bookTitle}\" ({oldCount} chapters → {newCount}). The differences are not a plain append at the end, so it cannot be merged safely.",
  "sourceEditor.toc.effect":
    "Overwriting replaces the whole chapter list with the latest one: chapters whose URLs are unchanged keep their cached text, while changed chapters are fetched again on demand; a changed chapter structure may affect reading progress and exact bookmark jumps.",
  "sourceEditor.toc.confirm": "Overwrite",
  "sourceEditor.toc.applying": "Overwriting…",

  // JavaScript code editor
  "sourceEditor.js.fallbackLabel": "JavaScript",
};
