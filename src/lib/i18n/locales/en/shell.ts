/**
 * Application shell: document title, main tabs, sidebar, page-header defaults, 404.
 * Main tab labels are referenced by key from src/shell/routes.ts and shared by the
 * phone tab bar and the desktop sidebar.
 */
export const shell = {
  /** Document / window title */
  "app.title": "ReaderX · Reading",

  // Language preference (settings page)
  "app.language.row": "Interface language",
  "app.language.title": "Language",
  "app.language.system": "System",
  /** Language names are written in their own language, regardless of the UI language */
  "app.language.zhCN": "简体中文",
  "app.language.en": "English",

  // Main tabs
  "shell.tab.shelf": "Bookshelf",
  "shell.tab.discover": "Discover",
  "shell.tab.settings": "Settings",
  /** Accessibility label of the tab bar / sidebar nav */
  "shell.nav.main": "Main navigation",

  // Desktop sidebar
  "shell.sidebar.tagline": "Local library",
  "shell.sidebar.expand": "Expand sidebar",
  "shell.sidebar.collapse": "Collapse sidebar",

  // Startup
  "shell.startup.settingsFailed": "Couldn't load local settings",
  "shell.startup.libraryFailed": "Couldn't load the library",

  // Lazy-load placeholder
  "shell.loading.page": "Loading page…",

  // 404
  "shell.notFound.title": "Page not found",
  "shell.notFound.desc": "This page doesn't exist or has been removed",
  "shell.notFound.action": "Back to bookshelf",
};
