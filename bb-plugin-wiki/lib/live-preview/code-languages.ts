import { commonmarkLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  StreamLanguage,
  languageDataProp,
  syntaxHighlighting,
  type Language,
  type StreamParser,
  type TagStyle,
} from "@codemirror/language";
import {
  c,
  cpp,
  csharp,
  java,
  kotlin,
} from "@codemirror/legacy-modes/mode/clike";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import {
  javascript,
  json,
  typescript,
} from "@codemirror/legacy-modes/mode/javascript";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { python } from "@codemirror/legacy-modes/mode/python";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { html, xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { NodeType } from "@lezer/common";
import { tags, type Highlighter, type Tag } from "@lezer/highlight";
import { parseCode, type MarkdownExtension } from "@lezer/markdown";

const MODES = {
  shell,
  javascript,
  typescript,
  json,
  python,
  go,
  yaml,
  sql: standardSQL,
  rust,
  diff,
  toml,
  dockerfile: dockerFile,
  html,
  xml,
  c,
  cpp,
  java,
  kotlin,
  csharp,
  protobuf,
  swift,
  ruby,
  lua,
} satisfies Record<string, StreamParser<unknown>>;

export type CodeMode = keyof typeof MODES;

const ALIASES: Readonly<Record<string, CodeMode>> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  json: "json",
  jsonc: "json",
  py: "python",
  python: "python",
  go: "go",
  golang: "go",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  rust: "rust",
  rs: "rust",
  diff: "diff",
  patch: "diff",
  toml: "toml",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  html: "html",
  xml: "xml",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  java: "java",
  kotlin: "kotlin",
  kt: "kotlin",
  csharp: "csharp",
  cs: "csharp",
  proto: "protobuf",
  protobuf: "protobuf",
  swift: "swift",
  ruby: "ruby",
  rb: "ruby",
  lua: "lua",
};

const INFO_WORD = /^[{.]?([\w+#-]+)/;

export function codeModeForInfo(info: string): CodeMode | null {
  const match = INFO_WORD.exec(info.trim());
  if (match === null) return null;
  const word = (match[1] ?? "").toLowerCase();
  return Object.hasOwn(ALIASES, word) ? (ALIASES[word] ?? null) : null;
}

const LEGACY_TOKENS: Readonly<Record<string, Tag>> = {
  property: tags.propertyName,
  "variable-2": tags.special(tags.variableName),
  "variable-3": tags.typeName,
  "string-2": tags.special(tags.string),
  qualifier: tags.modifier,
  header: tags.heading,
  hr: tags.contentSeparator,
  positive: tags.inserted,
  negative: tags.deleted,
  error: tags.invalid,
};

const languages = new Map<CodeMode, Language>();

export function codeLanguageFor(info: string): Language | null {
  const mode = codeModeForInfo(info);
  if (mode === null) return null;
  const known = languages.get(mode);
  if (known !== undefined) return known;
  const spec: StreamParser<unknown> = MODES[mode];
  const language = StreamLanguage.define({
    ...spec,
    tokenTable: { ...LEGACY_TOKENS, ...spec.tokenTable },
  });
  languages.set(mode, language);
  return language;
}

export const codeBlockParsers: MarkdownExtension = parseCode({
  codeParser: (info) => codeLanguageFor(info)?.parser ?? null,
});

export interface CodeThemeTokenRule {
  readonly scope?: string | readonly string[];
  readonly settings: {
    readonly foreground?: string;
    readonly fontStyle?: string;
  };
}

export interface CodeTheme {
  readonly type: "light" | "dark" | string;
  readonly tokenColors: readonly CodeThemeTokenRule[];
}

export interface TokenStyle {
  readonly foreground?: string;
  readonly fontStyle?: string;
}

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

export function validColor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) && trimmed.length !== 6 && trimmed.length !== 8
    ? trimmed
    : undefined;
}

function declaredScopes(
  scope: string | readonly string[] | undefined,
): string[] {
  if (scope === undefined) return [];
  const list = typeof scope === "string" ? scope.split(",") : [...scope];
  return list.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function matchScore(declared: string, wanted: string): number {
  if (declared === wanted) return 3_000_000;
  if (wanted.startsWith(`${declared}.`)) return 2_000_000 + declared.length;
  if (declared.startsWith(`${wanted}.`)) return 1_000_000 - declared.length;
  return 0;
}

function fontStyleOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const styles = value
    .split(/\s+/)
    .filter(
      (style) =>
        style === "italic" || style === "bold" || style === "underline",
    );
  return styles.length === 0 ? undefined : styles.join(" ");
}

export function tokenStyleForScopes(
  theme: CodeTheme,
  scopes: readonly string[],
): TokenStyle | undefined {
  for (const wanted of scopes) {
    let best: TokenStyle | undefined;
    let bestScore = 0;
    for (const rule of theme.tokenColors) {
      const foreground = validColor(rule.settings.foreground);
      const fontStyle = fontStyleOf(rule.settings.fontStyle);
      if (foreground === undefined && fontStyle === undefined) continue;
      for (const declared of declaredScopes(rule.scope)) {
        const score = matchScore(declared, wanted);
        if (score > 0 && score >= bestScore) {
          bestScore = score;
          best = {
            ...(foreground === undefined ? {} : { foreground }),
            ...(fontStyle === undefined ? {} : { fontStyle }),
          };
        }
      }
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

export function colorForScopes(
  theme: CodeTheme,
  scopes: readonly string[],
): string | undefined {
  for (const wanted of scopes) {
    const style = tokenStyleForScopes(theme, [wanted]);
    if (style?.foreground !== undefined) return style.foreground;
  }
  return undefined;
}

const TAG_SCOPES: readonly (readonly [readonly Tag[], readonly string[]])[] = [
  [
    [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    ["comment"],
  ],
  [
    [tags.string, tags.docString, tags.character, tags.special(tags.string)],
    ["string"],
  ],
  [[tags.regexp], ["string.regexp", "string"]],
  [
    [tags.escape],
    ["constant.character.escape", "constant.character", "string"],
  ],
  [
    [tags.number, tags.integer, tags.float],
    ["constant.numeric", "constant"],
  ],
  [
    [tags.bool, tags.null, tags.atom],
    ["constant.language", "constant"],
  ],
  [
    [
      tags.keyword,
      tags.controlKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
    ],
    ["keyword.control", "keyword"],
  ],
  [
    [tags.definitionKeyword, tags.modifier],
    ["storage.type", "storage", "keyword"],
  ],
  [
    [tags.typeName, tags.className, tags.namespace],
    ["entity.name.type", "support.type", "storage.type"],
  ],
  [
    [
      tags.definition(tags.variableName),
      tags.function(tags.variableName),
      tags.function(tags.definition(tags.variableName)),
    ],
    ["entity.name.function", "support.function"],
  ],
  [
    [tags.propertyName],
    ["variable.other.property", "support.type.property-name", "variable"],
  ],
  [[tags.variableName], ["variable"]],
  [
    [
      tags.special(tags.variableName),
      tags.standard(tags.variableName),
      tags.self,
    ],
    ["support.function", "variable.language", "support"],
  ],
  [[tags.tagName], ["entity.name.tag"]],
  [[tags.attributeName], ["entity.other.attribute-name"]],
  [[tags.operator], ["keyword.operator", "keyword"]],
  [
    [tags.meta, tags.annotation],
    [
      "meta.preprocessor",
      "keyword.control.directive",
      "entity.name.function.decorator",
    ],
  ],
  [[tags.heading], ["markup.heading", "entity.name.section"]],
  [[tags.inserted], ["markup.inserted"]],
  [[tags.deleted], ["markup.deleted"]],
  [[tags.changed], ["markup.changed"]],
  [[tags.invalid], ["invalid"]],
  [
    [tags.link, tags.url],
    ["markup.underline.link", "string.other.link"],
  ],
  [[tags.labelName], ["entity.name.label"]],
  [[tags.unit], ["keyword.other.unit", "constant.numeric"]],
];

function cssForFontStyle(
  fontStyle: string | undefined,
): Record<string, string> {
  if (fontStyle === undefined) return {};
  const parts = fontStyle.split(" ");
  return {
    ...(parts.includes("italic") ? { fontStyle: "italic" } : {}),
    ...(parts.includes("bold") ? { fontWeight: "bold" } : {}),
    ...(parts.includes("underline") ? { textDecoration: "underline" } : {}),
  };
}

export function codeTagStyles(theme: CodeTheme): TagStyle[] {
  const specs: TagStyle[] = [];
  for (const [tagList, scopes] of TAG_SCOPES) {
    const style = tokenStyleForScopes(theme, scopes);
    if (style === undefined) continue;
    specs.push({
      tag: tagList,
      ...(style.foreground === undefined ? {} : { color: style.foreground }),
      ...cssForFontStyle(style.fontStyle),
    });
  }
  return specs;
}

function isMarkdownTop(type: NodeType): boolean {
  return type.prop(languageDataProp) === commonmarkLanguage.data;
}

export function scopedHighlighting(
  style: HighlightStyle,
  scope: (type: NodeType) => boolean,
): Extension {
  const highlighter: Highlighter = {
    style: (tagList) => style.style(tagList),
    scope,
  };
  return [
    syntaxHighlighting(highlighter),
    style.module === null ? [] : EditorView.styleModule.of(style.module),
  ];
}

export function codeHighlighting(theme: CodeTheme | null): Extension {
  if (theme === null) return [];
  const specs = codeTagStyles(theme);
  if (specs.length === 0) return [];
  return scopedHighlighting(
    HighlightStyle.define(specs),
    (type) => !isMarkdownTop(type),
  );
}

export function markdownScope(type: NodeType): boolean {
  return isMarkdownTop(type);
}
