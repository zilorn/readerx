export type TranslationMode = "bilingual" | "translated" | "original";
export type TranslationProvider = "google" | "openai" | "deepseek" | "custom";
export type TranslationProtocol = "chat" | "responses";
export const TARGET_LANGUAGES = [
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
] as const;
export interface TranslationSettings {
  enabled: boolean;
  autoTranslateMetadata: boolean;
  mode: TranslationMode;
  readingText: "original" | "translated";
  folded: boolean;
  target: (typeof TARGET_LANGUAGES)[number];
  provider: TranslationProvider;
  protocol: TranslationProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  effort: string;
  pretranslate: number;
  glossary: boolean;
  parallel: number;
}
export interface GlossaryTerm {
  source: string;
  target: string;
  note: string;
}
export interface TranslationBookState {
  overrides: Partial<TranslationSettings>;
  terms: GlossaryTerm[];
  glossaryTarget?: string;
  titleEnabled?: boolean;
  titleTranslation?: { source: string; key: string; text: string };
  introEnabled?: boolean;
  introTranslation?: { source: string; key: string; text: string };
}
export interface TranslationCache {
  revision: string;
  entries: Record<string, string>;
}
export interface TranslationSource {
  source: string;
  kind: "paragraph" | "selection";
}
export interface TranslationWriteEntry extends TranslationSource {
  text: string;
}
export interface ParagraphTranslation {
  text: string;
  only: boolean;
}
export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  enabled: false,
  autoTranslateMetadata: false,
  mode: "bilingual",
  readingText: "original",
  folded: false,
  target: "zh-CN",
  provider: "google",
  protocol: "chat",
  baseUrl: "",
  model: "",
  apiKey: "",
  effort: "",
  pretranslate: 0,
  glossary: false,
  parallel: 2,
};
