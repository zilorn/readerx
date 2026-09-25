/** Source list (English) */
export const sources = {
  // Page header and multi-select
  "sources.page.title": "Book sources",
  "sources.page.titleSelecting": "Select sources",
  /** Counted messages keep the base key as the no-count fallback; `_one` / `_other` refine it */
  "sources.page.selectedCount": "{count} selected",
  "sources.page.selectedCount_one": "{count} source selected",
  "sources.page.selectedCount_other": "{count} sources selected",
  "sources.page.enabledCount": "{enabled} / {total} enabled",
  "sources.select.allHint": "Select all sources in the current filter",
  "sources.select.deselectAllHint": "Deselect all sources in the current filter",
  "sources.select.exit": "Exit selection",
  "sources.select.hint":
    "Long-press a source to start selecting; tap a selected source to deselect, then use the bar below to enable, group, export, or delete",

  // Page header actions
  "sources.import.json": "Import JSON",
  "sources.paste.label": "Paste import",
  "sources.url.label": "Import from URL",
  "sources.new.label": "New source",

  // Empty states
  "sources.empty.title": "No book sources yet",
  "sources.empty.hint":
    "Import JSON from the community, or start from a template on the Discover page",
  "sources.empty.noUngrouped": "No ungrouped sources",
  "sources.empty.group": "This group has no sources yet",

  // Batch actions
  "sources.batch.enableDone": "{count} sources enabled",
  "sources.batch.enableDone_one": "{count} source enabled",
  "sources.batch.enableDone_other": "{count} sources enabled",
  "sources.batch.disableDone": "{count} sources disabled",
  "sources.batch.disableDone_one": "{count} source disabled",
  "sources.batch.disableDone_other": "{count} sources disabled",
  "sources.batch.noChange": "No change to the selected sources",
  "sources.batch.grouped": "Grouped {count} sources under {name}",
  "sources.batch.grouped_one": "Grouped {count} source under {name}",
  "sources.batch.grouped_other": "Grouped {count} sources under {name}",
  "sources.batch.ungrouped": "Removed {count} sources from their groups",
  "sources.batch.ungrouped_one": "Removed {count} source from its group",
  "sources.batch.ungrouped_other": "Removed {count} sources from their groups",
  "sources.batch.missing": "The selected sources no longer exist",
  "sources.batch.exported": "Copied JSON for {count} sources",
  "sources.batch.exported_one": "Copied JSON for {count} source",
  "sources.batch.exported_other": "Copied JSON for {count} sources",
  "sources.batch.deleted": "Deleted {count} sources",
  "sources.batch.deleted_one": "Deleted {count} source",
  "sources.batch.deleted_other": "Deleted {count} sources",
  "sources.batch.group": "Group",
  "sources.batch.export": "Export",

  // Import (file / paste / URL share this flow)
  "sources.import.none": "No importable sources found",
  "sources.import.unrecognized": "Unrecognized source: {reason}",
  "sources.import.done": "Import complete: {created} added, {overwritten} overwritten",
  "sources.import.doneKept":
    "Import complete: {created} added, {overwritten} overwritten, {kept} kept on this device",
  "sources.import.issue.notObject": "Not an object",
  "sources.import.issue.missingName": "Missing field: name",
  "sources.import.issue.missingUrl": "Missing field: bookSourceUrl",
  "sources.import.issue.missingJs": "Missing field: js",
  "sources.import.issue.badJson": "Invalid JSON",
  "sources.import.issue.unparsable": "Cannot parse",

  // Import from URL
  "sources.url.missing": "Enter the URL of the source JSON",
  "sources.url.noSource": "That URL has no importable sources",
  "sources.url.dialogAria": "Import sources from a URL",
  "sources.url.hint":
    "Enter a URL pointing to source JSON (a single object or an array); you'll confirm before importing",
  "sources.url.fetching": "Fetching…",
  "sources.url.fetchAndImport": "Fetch and import",
  "sources.url.invalid": "Enter a source URL starting with http(s)://",
  "sources.url.httpFailed": "Fetch failed: HTTP {status}",
  "sources.url.empty": "That URL returned nothing to import",
  "sources.url.timeout": "Request timed out (30s). Check the URL and your network, then try again",
  "sources.url.unreachable": "Couldn't open that URL: {reason}",

  // Delete a source
  "sources.delete.aria": "Delete source",
  "sources.delete.title": "Delete this source?",
  "sources.delete.desc": "Books already downloaded with this source are not affected",
  "sources.delete.done": "Source deleted",

  // Grouping and export
  "sources.group.assigned": "Moved into {name}",
  "sources.group.removed": "Removed from group",
  "sources.copy.done": "Source JSON copied",

  // Source row
  "sources.row.select": "Select source {name}",
  "sources.row.deselect": "Deselect source {name}",
  "sources.row.edit": "Edit source {name}",
  "sources.row.enable": "Enable source {name}",
  "sources.row.disable": "Disable source {name}",
  "sources.row.assignGroup": "Move to group: {name}",
  "sources.row.copyExport": "Copy export JSON: {name}",
  "sources.row.delete": "Delete source: {name}",

  // Test panel
  "sources.test.title": "Test",
  "sources.test.hint": "Saves the current code before running",
  "sources.test.running": "Running…",
  "sources.test.run": "Save and test",
  "sources.test.exportJson": "Export JSON",

  // Capabilities and entry functions (the tables store keys only)
  "sources.capability.discover": "Discover",
  "sources.capability.toc": "Contents",
  "sources.capability.content": "Content",
  "sources.entryDesc.search": "Search by keyword",
  "sources.entryDesc.discover": "Browse books by category",
  "sources.entryDesc.detail": "Enrich book details",
  "sources.entryDesc.toc": "Fetch the chapter list",
  "sources.entryDesc.content": "Fetch one chapter's text",
};
