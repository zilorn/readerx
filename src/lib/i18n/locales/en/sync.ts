/**
 * LAN sync (Settings → Sync, and the conflict resolution screen).
 *
 * Two things these strings must make clear: **what syncs** (book metadata, reading
 * position, bookmarks, groups, book sources — never the book files themselves) and
 * **what turning sync off does** (local changes keep being recorded and go out on the
 * next sync).
 */
export const sync = {
  "sync.title": "Sync",

  // Sections
  "sync.section.enable": "Sync",
  "sync.section.status": "Status",
  "sync.section.thisDevice": "This device",
  "sync.section.connect": "Devices",
  "sync.section.auto": "Auto sync",
  "sync.section.data": "Data",

  // Master switch
  "sync.enable.title": "LAN sync",
  "sync.enable.onDesc": "Sync with paired devices on the same local network",
  "sync.enable.offDesc":
    "Syncs book info, reading position, bookmarks, groups and sources; book files and covers stay on each device",
  "sync.enable.toggle": "Turn sync on or off",
  "sync.enable.failed": "Could not change the sync switch",

  // Status
  "sync.status.syncing": "Syncing…",
  "sync.status.idle": "Ready",
  "sync.status.lastSync": "Last sync: {time}",
  "sync.action.syncNow": "Sync",
  "sync.now.failed": "Sync failed",
  "sync.result.ok": "Synced with {names}",
  "sync.auto.failed": "Could not change auto sync",
  "sync.applied.reloadFailed": "Could not load the sync result into the app",

  // Relative time
  "sync.time.never": "Never",
  "sync.time.justNow": "just now",
  "sync.time.minutesAgo": "{count} minutes ago",
  "sync.time.minutesAgo_one": "{count} minute ago",
  "sync.time.minutesAgo_other": "{count} minutes ago",
  "sync.time.hoursAgo": "{count} hours ago",
  "sync.time.hoursAgo_one": "{count} hour ago",
  "sync.time.hoursAgo_other": "{count} hours ago",
  "sync.time.daysAgo": "{count} days ago",
  "sync.time.daysAgo_one": "{count} day ago",
  "sync.time.daysAgo_other": "{count} days ago",

  // This device
  "sync.deviceName.title": "Device name",
  "sync.deviceName.desc": "The name other devices see on the local network",
  "sync.deviceName.save": "Save device name",
  "sync.deviceName.failed": "Could not change the device name",
  "sync.address.title": "Local address",
  "sync.address.desc": "Other devices can also connect by entering this address",
  "sync.pairing.title": "Pairing code",
  "sync.pairing.desc": "Enter it under “Join another device” on the other device",
  "sync.pairing.copy": "Copy",
  "sync.pairing.copied": "Pairing code copied",
  "sync.pairing.copyFailed": "Copy failed — press and hold to select",
  "sync.pairing.failed": "Could not read the pairing code",

  // Connect
  "sync.join.title": "Join another device",
  "sync.join.desc": "Enter the pairing code shown on the other device",
  "sync.join.placeholder": "Pairing code",
  "sync.join.action": "Join",
  "sync.join.done": "Joined the sync group",
  "sync.join.failed": "Could not join the sync group",
  "sync.discover.title": "Find devices",
  "sync.discover.desc": "Devices on this network that share the same sync group",
  "sync.discover.action": "Find",
  "sync.discover.running": "Searching…",
  "sync.discover.empty": "No device available to sync with",
  "sync.discover.emptyHint":
    "Make sure sync is on for the other device and both are on the same network",
  "sync.discover.failed": "Could not search for devices",
  "sync.discover.removed": "Removed",
  "sync.discover.reaccept": "Accept again",
  "sync.peer.lastSync": "Last sync: {time} ({count} times)",
  "sync.peer.empty": "No paired devices yet — auto sync starts once you pair one",
  "sync.peer.lastSync_one": "Last sync: {time} ({count} time)",
  "sync.peer.lastSync_other": "Last sync: {time} ({count} times)",
  "sync.peer.removeAria": "Remove device {name}",
  "sync.peer.removeConfirm": "Confirm",
  "sync.peer.removed": "Removed {name}",
  "sync.peer.removeFailed": "Could not remove the device",
  "sync.peer.acceptFailed": "Could not accept the device again",
  "sync.peer.removedHint":
    "{count} removed devices are no longer synced with this one — accept them again from the search results",
  "sync.peer.removedHint_one":
    "{count} removed device is no longer synced with this one — accept it again from the search results",
  "sync.peer.removedHint_other":
    "{count} removed devices are no longer synced with this one — accept them again from the search results",

  // Auto sync
  "sync.auto.title": "Auto sync",
  "sync.auto.desc": "Sync with paired devices in the background at a fixed interval",
  "sync.auto.toggle": "Turn auto sync on or off",
  "sync.interval.title": "Interval",
  "sync.interval.desc": "With both devices in use, the shorter interval wins",
  "sync.interval.minutes": "{count} minutes",
  "sync.interval.minutes_one": "{count} minute",
  "sync.interval.minutes_other": "{count} minutes",
  "sync.interval.hours": "{count} hours",
  "sync.interval.hours_one": "{count} hour",
  "sync.interval.hours_other": "{count} hours",

  // Data
  "sync.scope.title": "Synced data",
  "sync.scope.desc":
    "Book info, reading position, bookmarks, groups and sources; book files and covers stay local",
  "sync.scope.count": "{count} items",
  "sync.scope.count_one": "{count} item",
  "sync.scope.count_other": "{count} items",
  "sync.reset.title": "Clear sync data",
  "sync.reset.confirm": "Clear sync data?",
  "sync.reset.desc":
    "Only the sync history and pairing are cleared; your library, sources and progress stay",
  "sync.reset.done": "Sync data cleared",
  "sync.reset.failed": "Could not clear sync data",

  // Conflicts
  "sync.conflict.title": "Sync conflicts",
  "sync.conflict.pending": "{count} items to review",
  "sync.conflict.pending_one": "{count} item to review",
  "sync.conflict.pending_other": "{count} items to review",
  "sync.conflict.none": "Nothing to review",
  "sync.conflict.toast": "{count} sync conflicts need your review",
  "sync.conflict.toast_one": "{count} sync conflict needs your review",
  "sync.conflict.toast_other": "{count} sync conflicts need your review",
  "sync.conflict.toastAction": "Review",
  "sync.conflict.loadFailed": "Could not load the conflict list",
  "sync.conflict.resolveFailed": "Could not resolve the conflict",
  "sync.conflict.resolved": "Resolved",
  "sync.conflict.filterPending": "Pending",
  "sync.conflict.filterAll": "All",
  "sync.conflict.empty": "No conflicts",
  "sync.conflict.emptyHint":
    "When two devices change the same thing at once, you decide which copy to keep here",
  "sync.conflict.localSide": "This device",
  "sync.conflict.remoteSide": "Other device",
  "sync.conflict.emptyValue": "(empty)",
  "sync.conflict.keepLocal": "Keep this device",
  "sync.conflict.keepRemote": "Use other device",
  "sync.conflict.dismiss": "Dismiss",

  // Conflict reasons
  "sync.conflict.reason.concurrentWrite": "The same field was changed on both devices",
  "sync.conflict.reason.multiValue": "The same content was edited on both devices",
  "sync.conflict.reason.uniqueKey": "Two records claim the same unique identifier",
  "sync.conflict.reason.deleteVsUpdate": "Deleted on one device, edited on the other",
  "sync.conflict.reason.frozenWrite": "An immutable field was rewritten",
  "sync.conflict.reason.listMove": "The same item was moved to different positions",
  "sync.conflict.reason.duplicateEntity": "The same record was created on both devices",
  "sync.conflict.reason.cascadeBlocked": "Deletion blocked because other records still reference it",
  "sync.conflict.reason.unknown": "Content conflict",

  // Conflict fields and entity kinds
  "sync.field.title": "Title",
  "sync.field.author": "Author",
  "sync.field.intro": "Description",
  "sync.field.tags": "Tags",
  "sync.field.sourceTags": "Source tags",
  "sync.field.group": "Group",
  "sync.field.name": "Name",
  "sync.field.sourceJson": "Source configuration",
  "sync.field.note": "Note",
  "sync.field.entity": "Whole record",
  "sync.kind.book": "Book",
  "sync.kind.source": "Source",
  "sync.kind.group": "Group",
  "sync.kind.bookmark": "Bookmark",
  "sync.kind.progress": "Reading position",
};
