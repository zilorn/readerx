/**
 * Book details, metadata editing and shelf group management (English).
 *
 * `book.detail.*` covers the detail page, `book.field.*` the metadata field names
 * shared by detail rows, section headings and the edit form, `book.meta.*` the
 * metadata edit sheet, and `book.groups.*` / `book.picker.*` the group manager
 * and the move-to-group sheet. Book titles, authors and group names are data,
 * not messages.
 */
export const book = {
  // Book detail page
  "book.detail.title": "Book details",
  "book.detail.refresh": "Refresh book info (intro, cover and tags)",
  "book.detail.loading": "Loading local library…",
  "book.detail.notFound": "Book not found",
  "book.detail.tagsEmpty": "No tags yet, tap Edit in the top right to add some",
  "book.detail.introEmpty": "No intro yet, tap Edit in the top right to add one",
  "book.detail.searchTitle": "Search title",
  "book.detail.searchAuthor": "Search author",
  "book.detail.openInBrowser": "Open {name} in browser",
  "book.detail.updated": "{fields} updated",
  "book.detail.upToDate": "Book info is already up to date",
  "book.detail.refreshFailed": "Refresh failed: {reason}",
  "book.detail.fieldSeparator": ", ",
  "book.detail.online": "Online",
  "book.detail.webdavImport": "WebDAV import",
  "book.detail.localImport": "Local import",
  "book.detail.chapterCount": "{count} chapters",
  "book.detail.chapterCount_one": "{count} chapter",
  "book.detail.chapterCount_other": "{count} chapters",
  "book.detail.charCount": "{count} characters",
  "book.detail.charCount_one": "{count} character",
  "book.detail.charCount_other": "{count} characters",

  // Metadata field names (detail rows, section headings and edit form)
  "book.field.title": "Title",
  "book.field.author": "Author",
  "book.field.format": "Format",
  "book.field.source": "Source",
  "book.field.bookUrl": "Source URL",
  "book.field.chapters": "Chapters",
  "book.field.chars": "Characters",
  "book.field.size": "Size",
  "book.field.file": "File",
  "book.field.group": "Group",
  "book.field.importedAt": "Imported",
  "book.field.intro": "Intro",
  "book.field.tags": "Tags",
  "book.field.cover": "Cover",

  // Metadata edit sheet
  "book.meta.title": "Edit book info",
  "book.meta.subtitle": "The shelf updates after saving",
  "book.meta.noCover": "No cover",
  "book.meta.changeCover": "Change cover",
  "book.meta.removeCover": "Remove cover",
  "book.meta.tagsEmpty": "No tags yet",
  "book.meta.tagPlaceholder": "Type a tag, then press Enter or the plus button",
  "book.meta.addTag": "Add tag",
  "book.meta.introPlaceholder": "Book intro (optional)",
  "book.meta.titleRequired": "Title can't be empty",
  "book.meta.saveFailed": "Couldn't save, please try again",
  "book.meta.saving": "Saving…",
  "book.meta.coverReadFailed": "Couldn't read that image, please pick another JPG / PNG",

  // Shelf group manager
  "book.groups.title": "Shelf groups",
  "book.groups.manage": "Shelf group management",
  "book.groups.subtitle": "Create, rename or delete shelf groups",
  "book.groups.close": "Close shelf group management",
  "book.groups.empty": "No shelf groups yet, create one below.",
  "book.groups.rename": "Rename \"{name}\"",
  "book.groups.delete": "Delete group \"{name}\"",
  "book.groups.confirmDelete": "Confirm deleting group \"{name}\"",
  "book.groups.saveName": "Save group name",
  "book.groups.newPlaceholder": "New group",
  "book.groups.hidden": "Hidden",
  "book.groups.hiddenHint": "Kept out of the shelf and search",
  "book.groups.bookMissing": "This book is no longer on the shelf",
  "book.groups.movedTo": "Moved to \"{name}\"",
  "book.groups.movedOut": "Removed from group",
  "book.groups.addedToShelf": "Added to shelf",
  "book.groups.joinGroup": "Add to group",

  // Move-to-group sheet
  "book.picker.choose": "Choose a group",
  "book.picker.title": "Move to group",
  "book.picker.subtitle": "Choose a shelf group",
  "book.picker.create": "Create",
};
