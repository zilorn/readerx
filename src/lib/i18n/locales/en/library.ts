/**
 * Library I/O and parsing (EPUB / PDF), the backend channel and error fallbacks.
 *
 * Covers src/lib/backend.ts, epub.ts, pdf.ts and the pdf/ render + chapter helpers:
 * `reportFailure(...)` contexts, parse failures thrown at the user, and the image
 * alt fallback. Log text (`log.*`) stays Chinese and is not part of the dictionary.
 */
export const library = {
  /** Capability note for the plain-browser dev environment (shown as a failure reason) */
  "library.app.onlyInApp": "Only available in the app",

  // Backend state (readerx.* state files)
  "library.state.readFailed": "Couldn't read local settings",
  "library.state.writeFailed": "Couldn't save local settings",
  "library.state.removeFailed": "Couldn't clear local settings",

  // Books
  "library.book.readFailed": "Couldn't read the book",

  // Book sources
  "library.source.listFailed": "Couldn't read the source list",
  "library.source.readFailed": "Couldn't read the source",
  "library.source.appOnly": "Book sources only work in the app",
  "library.source.fetchContentsFailed": "Couldn't fetch chapter text",
  "library.source.imageAppOnly": "Source images only work in the app",
  "library.source.imageDownloadFailed": "Image download failed",

  // Desktop native file import
  "library.file.appOnly": "The file picker is only available in the app",
  "library.file.noContent": "Couldn't read the selected file: no content returned",

  // Developer tools
  "library.devTools.failed": "Couldn't open developer tools",

  // Web sign-in
  "library.login.appOnly": "Web sign-in is only available in the app",
  "library.login.clearFailed": "Couldn't clear the sign-in state",

  // EPUB parsing
  "library.epub.unzipFailed": "Couldn't unpack the EPUB (the file may be damaged or not a valid ZIP)",
  "library.epub.noContainer": "EPUB is missing META-INF/container.xml, not a standard EPUB",
  "library.epub.noOpfPath": "No OPF manifest found in the EPUB container.xml",
  "library.epub.opfMissing": "EPUB manifest not found: {path}",
  "library.epub.spineItemMissing": "EPUB spine references a manifest item that doesn't exist: {id}",
  "library.epub.contentMissing": "EPUB content file missing: {path}",
  /** Default chapter title when no title is available */
  "library.epub.sectionFallback": "Section {index}",
  /** Alt text for an EPUB image without an alt attribute */
  "library.epub.imageAlt": "Illustration",
  "library.epub.noChapters": "No readable chapters found in the EPUB; make sure the file isn't encrypted",

  // PDF parsing
  "library.pdf.pageImageAppOnly": "PDF page images can only be stored in the app",
  "library.pdf.noPages": "The PDF has no readable pages",
  "library.pdf.noContent": "No readable content found in the PDF; make sure the file isn't encrypted or damaged",
  /** Single-page chapter title, and the alt text of page-image chapters */
  "library.pdf.page": "Page {page}",
  "library.pdf.pageRange": "Pages {start}–{end}",
  /** Outline title plus page range (a body title reads "Title (Pages 1–3)") */
  "library.pdf.chapterTitle": "{title} ({pages})",
};
