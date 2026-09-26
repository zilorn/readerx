/**
 * Data backup / restore (Settings → Data → Data backup).
 *
 * The copy has to say three things: what a backup contains (the whole library, including
 * book text and images), that login state is **not** included by default, and that restoring
 * has two meanings — merge (keeps everything on this device) and replace (drops books and
 * sources the backup does not have).
 */
export const backup = {
  "backup.appOnly": "Only available in the app",
  "backup.title": "Data backup",
  "backup.subtitle": "Export everything into one file, or restore from a backup",

  // Export
  "backup.section.export": "Export",
  "backup.export.desc":
    "A backup contains the shelf and full book text, bookmarks, groups, sources, images, replacement and chapter rules, reading progress and interface preferences.",
  "backup.export.credentials": "Include login state",
  "backup.export.credentialsDesc":
    "Source login cookies and WebDAV passwords are written into the backup file too, so do not share it",
  "backup.export.action": "Export backup",
  "backup.export.busy": "Exporting…",
  "backup.export.done": "Exported {name} ({size})",
  "backup.export.failed": "Failed to export the backup",

  // Import
  "backup.section.import": "Import",
  "backup.import.desc":
    "Restore from a backup file: merge only fills in what is missing and overwrites matching ids; replace also deletes books and sources the backup does not have.",
  "backup.import.pick": "Choose a backup file",
  "backup.import.picking": "Reading the backup…",
  "backup.import.failed": "Failed to import the backup",
  "backup.import.readFailed": "Failed to read the backup",

  // Preview
  "backup.preview.title": "This backup contains",
  "backup.preview.time": "Exported at {time}",
  "backup.preview.books": "{count} books",
  "backup.preview.books_one": "{count} book",
  "backup.preview.books_other": "{count} books",
  "backup.preview.images": "{count} images",
  "backup.preview.images_one": "{count} image",
  "backup.preview.images_other": "{count} images",
  "backup.preview.sources": "{count} sources",
  "backup.preview.sources_one": "{count} source",
  "backup.preview.sources_other": "{count} sources",
  "backup.preview.size": "File size {size}",
  "backup.preview.credentials": "Contains login state (cookies and WebDAV passwords)",
  "backup.preview.dismiss": "Cancel",

  // Import mode
  "backup.mode.merge": "Merge",
  "backup.mode.mergeDesc": "Keeps every book and source already on this device",
  "backup.mode.replace": "Replace",
  "backup.mode.replaceDesc":
    "Deletes books and sources the backup does not have; content settings go back to that moment",
  "backup.mode.replaceConfirm": "Tap again to confirm replace",

  // Progress
  "backup.progress.exporting": "Exporting {step} {done}/{total}",
  "backup.progress.importing": "Importing {step} {done}/{total}",
  "backup.step.state": "settings",
  "backup.step.books": "books",
  "backup.step.images": "images",
  "backup.step.sources": "sources",
  "backup.step.sessions": "login state",

  // Result
  "backup.result.title": "Import finished",
  "backup.result.booksAdded": "{count} books added",
  "backup.result.booksAdded_one": "Added {count} book",
  "backup.result.booksAdded_other": "Added {count} books",
  "backup.result.booksUpdated": "{count} books overwritten",
  "backup.result.booksUpdated_one": "Overwrote {count} book",
  "backup.result.booksUpdated_other": "Overwrote {count} books",
  "backup.result.booksSkipped": "{count} already present (matched by book identity, not imported twice)",
  "backup.result.booksSkipped_one": "{count} already present (matched by book identity, not imported twice)",
  "backup.result.booksSkipped_other": "{count} already present (matched by book identity, not imported twice)",
  "backup.result.booksRemoved": "{count} books deleted",
  "backup.result.booksRemoved_one": "Deleted {count} book",
  "backup.result.booksRemoved_other": "Deleted {count} books",
  "backup.result.images": "{count} images written",
  "backup.result.images_one": "Wrote {count} image",
  "backup.result.images_other": "Wrote {count} images",
  "backup.result.sourcesAdded": "{count} sources added",
  "backup.result.sourcesAdded_one": "Added {count} source",
  "backup.result.sourcesAdded_other": "Added {count} sources",
  "backup.result.sourcesUpdated": "{count} sources overwritten",
  "backup.result.sourcesUpdated_one": "Overwrote {count} source",
  "backup.result.sourcesUpdated_other": "Overwrote {count} sources",
  "backup.result.sourcesSkipped": "{count} sources already present (same site, not imported twice)",
  "backup.result.sourcesSkipped_one": "{count} source already present (same site, not imported twice)",
  "backup.result.sourcesSkipped_other": "{count} sources already present (same site, not imported twice)",
  "backup.result.sourcesRemoved": "{count} sources deleted",
  "backup.result.sourcesRemoved_one": "Deleted {count} source",
  "backup.result.sourcesRemoved_other": "Deleted {count} sources",
  "backup.result.state": "{count} settings updated",
  "backup.result.state_one": "Updated {count} setting",
  "backup.result.state_other": "Updated {count} settings",
};
