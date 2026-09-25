/**
 * Chapter rules and text replacement (English).
 *
 * The built-in patterns, rule ids and each rule's `name` are matching / persisted
 * data and stay untranslated; `chapterRules.builtin.*` holds display names that are
 * looked up by rule id at render time (see chapterRuleDisplayName in
 * src/lib/chapterRules.ts). Names typed by the user are their own content.
 */
export const chapterRules = {
  // Chapter rules page
  "chapterRules.title": "Chapter rules",
  "chapterRules.subtitle": "Applied when importing TXT",
  "chapterRules.section.auto": "Automatic splitting (tried in list order)",
  "chapterRules.badge.builtin": "Built-in",
  "chapterRules.action.add": "Add chapter rule",
  "chapterRules.action.save": "Save rule",
  "chapterRules.action.deleteAria": 'Delete rule "{name}"',
  "chapterRules.hint.builtinLocked":
    "Built-in rules can't be deleted; when no rule matches, the text is split by character count",
  "chapterRules.hint.appliesToImports":
    "New rules apply to TXT files imported from now on",
  "chapterRules.error.addFailed": "Couldn't add the rule",

  // Add rule sheet
  "chapterRules.sheet.patternHint": "Match headings with a regex",
  "chapterRules.form.name": "Rule name",
  "chapterRules.form.namePlaceholder": "e.g. Part X",
  "chapterRules.form.pattern": "Regular expression",
  "chapterRules.form.hintBefore":
    "The whole matched line becomes the chapter title; anchoring with",
  "chapterRules.form.hintAfter":
    "at the start of a line is safer. Matching is case-insensitive and multi-line.",
  "chapterRules.form.fillSample": "Insert sample: Chinese chapter heading",

  // Display names of the built-in rules (their `name` field stays as-is)
  "chapterRules.builtin.zhPrelude": "Chinese chapters (intro may come first)",
  "chapterRules.builtin.zhChapter": "Chinese chapters (第X章 / 回 / 节)",
  "chapterRules.builtin.zhFront": "Chinese prologue / epilogue / extras",
  "chapterRules.builtin.enChapter": "English Chapter / CHAPTER",
  "chapterRules.builtin.zhVolume": "Chinese volumes (卷 / 部 / 集)",

  // Split method description (shown when falling back to a character count)
  /** Chapter titles generated at import time (used when the source has no usable heading) */
  "chapterRules.generated.chapter": "Chapter {index}",
  "chapterRules.generated.section": "Section {index}",
  "chapterRules.generated.frontMatter": "Front matter",
  "chapterRules.split.byChars":
    "By character count (about {count} characters per chapter)",
  "chapterRules.split.byChars_one":
    "By character count (about {count} character per chapter)",
  "chapterRules.split.byChars_other":
    "By character count (about {count} characters per chapter)",

  // Validation (rule name, regex, text to find)
  "chapterRules.validation.nameRequired": "Enter a rule name",
  "chapterRules.validation.patternRequired": "Enter a regular expression",
  "chapterRules.validation.patternInvalid": "Can't parse the regular expression",
  "chapterRules.validation.findRequired": "Enter the text to find",

  // Text replacement sheet
  "chapterRules.replace.title": "Text replacement",
  "chapterRules.replace.subtitle":
    "Affects the reading view only, never the original text",
  "chapterRules.replace.new": "New replacement",
  "chapterRules.replace.edit": "Edit replacement",
  "chapterRules.replace.backToList": "Back to replacements",
  "chapterRules.replace.close": "Close text replacement",
  "chapterRules.replace.empty": "No replacements yet",
  "chapterRules.replace.save": "Save replacement",
  "chapterRules.replace.delete": "Delete this replacement",
  "chapterRules.replace.saved": "Replacement saved",
  "chapterRules.replace.added": "Replacement added",
  "chapterRules.replace.deleted": "Replacement deleted",

  // Replacement form
  "chapterRules.replace.find": "Find",
  "chapterRules.replace.findPlaceholder": "Text to be replaced",
  "chapterRules.replace.replaceWith": "Replace with",
  "chapterRules.replace.replacePlaceholder": "Leave empty to delete the match",
  "chapterRules.replace.deletedMatch": "Deletes matched text",
  "chapterRules.replace.regex": "Regex",
  "chapterRules.replace.scope": "Applies to",
  "chapterRules.replace.scopeGlobal": "Global",
  "chapterRules.replace.scopeGlobalHint": "Applies to every book on the shelf",
  "chapterRules.replace.scopeGlobalSection": "Global (all books)",
  "chapterRules.replace.scopeBook": "This book only",
  "chapterRules.replace.scopeBookHint": "Applies to the current book only",
  "chapterRules.replace.scopeBookHintTitle": 'Applies to "{title}" only',
  "chapterRules.replace.scopeBookSection": 'Only in "{title}"',
  "chapterRules.replace.scopeBookSectionFallback": "Only in this book",
  "chapterRules.replace.scopeBookBadge": "This book",
  "chapterRules.replace.regexHintBefore":
    "Finds and replaces every match with a regex; the replacement supports",
  "chapterRules.replace.regexHintAfter":
    "and other capture group references. Turn the regex off to match plain text.",
  "chapterRules.replace.error.noBook":
    "No target book, so this can't be saved for one book only",
  "chapterRules.replace.editAria": "Edit replacement: {find}",
  "chapterRules.replace.deleteAria": "Delete replacement: {find}",
};
