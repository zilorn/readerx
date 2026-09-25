/** WebDAV (English) */
export const webdav = {
  // Page
  "webdav.page.title": "WebDAV import",
  "webdav.page.backToShelf": "Back to shelf",
  "webdav.page.configureServer": "Configure WebDAV server",

  // Folder browsing
  "webdav.dir.up": "Go to parent folder",
  "webdav.dir.refresh": "Refresh this folder",
  "webdav.dir.searchPlaceholder": "Search this folder",
  "webdav.dir.searchLabel": "Search folders and books in this folder",
  "webdav.dir.clearKeyword": "Clear search",
  "webdav.dir.importableCount": "{count} books can be imported",
  "webdav.dir.importableCount_one": "{count} book can be imported",
  "webdav.dir.importableCount_other": "{count} books can be imported",
  "webdav.dir.importedCount": ", {count} already imported",
  "webdav.dir.selectAll": "Select all in folder",
  "webdav.hint.importedBooks":
    "Imported books: tap to read, long-press to import again",

  // Entries
  "webdav.entry.select": "Select {name}",
  "webdav.entry.deselect": "Deselect {name}",
  "webdav.entry.openImported":
    "Open {name} to read (imported, long-press to import again)",
  "webdav.entry.imported": "Imported",
  "webdav.entry.enterDir": "Open folder {name}",

  // Empty states and loading
  "webdav.empty.noServerTitle": "No active WebDAV server",
  "webdav.empty.noServerDesc":
    "Set up and activate a server to browse your remote library and import books",
  "webdav.empty.noServers": "No WebDAV servers yet",
  "webdav.empty.noMatch": "No matches found",
  "webdav.empty.noImportable": "Nothing to import in this folder",
  "webdav.action.configureServer": "Configure server",
  "webdav.loading.config": "Loading settings…",
  "webdav.loading.directory": "Loading folder…",

  // Bottom action bar
  "webdav.bar.selectedCount": "{count} books selected",
  "webdav.bar.selectedCount_one": "{count} book selected",
  "webdav.bar.selectedCount_other": "{count} books selected",
  "webdav.bar.clearSelection": "Clear selection",
  "webdav.bar.importSelected": "Import selected ({count})",
  "webdav.bar.importing": "Importing {done}/{total}",

  // Re-import
  "webdav.reimport.dialogLabel": "Import {name} again",
  "webdav.reimport.title": "Import {name} again?",
  "webdav.reimport.desc":
    "This book is already on your shelf. Importing again replaces the local copy with the latest file from the server. Reading progress and groups are kept, and bookmarks are carried over to the new content where possible.",
  "webdav.reimport.action": "Import again",
  "webdav.reimport.checking": "Checking…",

  // Toasts
  "webdav.toast.importedCount": "Imported {count} books",
  "webdav.toast.importedCount_one": "Imported {count} book",
  "webdav.toast.importedCount_other": "Imported {count} books",
  "webdav.toast.importAllFailed":
    "Failed to import {count} books, check the files and your network",
  "webdav.toast.importAllFailed_one":
    "Failed to import {count} book, check the file and your network",
  "webdav.toast.importAllFailed_other":
    "Failed to import {count} books, check the files and your network",
  "webdav.toast.importPartial": "{ok} imported, {failed} failed",
  "webdav.toast.reimported": "Imported {title} again",
  "webdav.toast.reimportCancelled": "Import cancelled",
  "webdav.toast.reimportMissing":
    "No matching local book found, refresh the folder and try again",
  "webdav.toast.serverSaved": "Server settings saved",
  "webdav.toast.serverAdded": "Server added",
  "webdav.toast.serverDeleted": "Server deleted",

  // Errors
  "webdav.error.urlRequired": "Enter the server address",
  "webdav.error.saveFailed": "Could not save",
  "webdav.error.listFailed": "Could not read folder",
  "webdav.error.downloadBookFailed": "Could not download book",
  "webdav.error.downloadFailed": "Download failed, cannot reach the server",
  "webdav.error.connectFailed":
    "Cannot reach the server, check the address and your network",
  "webdav.error.parseFailed":
    "The server returned folder data that could not be parsed",
  "webdav.error.unsupportedFormat": "Unsupported book format: {name}",
  "webdav.error.reimportFailed": "Could not import again",
  /** Failure text composed as "action (reason)" */
  "webdav.error.withReason": "{action} ({reason})",
  "webdav.error.auth":
    "Authentication failed, check the account, password and permissions",
  "webdav.error.notFound": "Folder not found or the address is wrong",
  "webdav.error.serverError": "Server error",

  // Server drawer
  "webdav.drawer.dialogLabel": "WebDAV server settings",
  "webdav.drawer.title": "WebDAV servers",
  "webdav.drawer.backToList": "Back to server list",
  "webdav.drawer.hint":
    "You can add several servers; select one to use it on the import page",

  // Server form
  "webdav.form.name": "Name",
  "webdav.form.namePlaceholder": "e.g. My Nutstore",
  "webdav.form.url": "Server address",
  "webdav.form.username": "Account",
  "webdav.form.usernamePlaceholder": "(leave empty for anonymous access)",
  "webdav.form.password": "Password",
  "webdav.form.saving": "Saving…",

  // Server list rows
  "webdav.server.add": "New server",
  "webdav.server.edit": "Edit server",
  "webdav.server.account": "Account {name}",
  "webdav.server.anonymous": "Anonymous",
  "webdav.server.inUse": "{name} (in use)",
  "webdav.server.use": "Use {name}",
  "webdav.server.editLabel": "Edit {name}",
  "webdav.server.deleteLabel": "Delete {name}",
  "webdav.server.confirmDelete": "Confirm",
};
