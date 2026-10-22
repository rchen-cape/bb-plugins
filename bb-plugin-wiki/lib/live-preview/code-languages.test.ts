import { describe, expect, it } from "vitest";
import { syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  codeHighlighting,
  codeLanguageFor,
  codeModeForInfo,
  codeTagStyles,
  colorForScopes,
  tokenStyleForScopes,
  validColor,
  type CodeTheme,
} from "./code-languages.js";
import { markdownState } from "./test-support.js";

describe("codeModeForInfo", () => {
  it("maps every documented info string", () => {
    const table: Record<string, string> = {
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
    for (const [info, mode] of Object.entries(table))
      expect(codeModeForInfo(info)).toBe(mode);
  });

  it("ignores case, attributes after the language and braces", () => {
    expect(codeModeForInfo("TypeScript")).toBe("typescript");
    expect(codeModeForInfo('ts title="a.ts"')).toBe("typescript");
    expect(codeModeForInfo("{python}")).toBe("python");
    expect(codeModeForInfo("")).toBeNull();
    expect(codeModeForInfo("brainfuck")).toBeNull();
    expect(codeModeForInfo("css")).toBeNull();
    expect(codeModeForInfo("constructor")).toBeNull();
    expect(codeModeForInfo("toString")).toBeNull();
  });

  it("creates each language lazily once", () => {
    const first = codeLanguageFor("ts");
    expect(first).not.toBeNull();
    expect(codeLanguageFor("typescript")).toBe(first);
    expect(codeLanguageFor("tsx")).toBe(first);
    expect(codeLanguageFor("nope")).toBeNull();
  });

  it("parses fenced code with the matching mode", () => {
    const doc = "```python\ndef run():\n    return 1\n```\n";
    const state = markdownState(doc);
    const inner = syntaxTree(state).resolveInner(doc.indexOf("def") + 1, 1);
    expect(inner.name).not.toBe("CodeText");
    expect(inner.name).not.toBe("FencedCode");
    const plain = markdownState("```\nplain\n```\n");
    expect(syntaxTree(plain).resolveInner(6, 1).name).toBe("CodeText");
  });
});

const theme: CodeTheme = {
  type: "dark",
  tokenColors: [
    { settings: { foreground: "#ffffff" } },
    {
      scope: "comment",
      settings: { foreground: "#6a737d", fontStyle: "italic" },
    },
    { scope: ["string", "string.regexp"], settings: { foreground: "#9ecbff" } },
    { scope: "string.regexp", settings: { foreground: "#dbedff" } },
    { scope: "keyword.control.flow", settings: { foreground: "#f97583" } },
    {
      scope: "entity.name.function, support.function",
      settings: { foreground: "#b392f0" },
    },
    { scope: "constant", settings: { foreground: "#79b8ff" } },
    { scope: "variable", settings: { foreground: "red" } },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
  ],
};

describe("colorForScopes", () => {
  it("matches exact scopes first", () => {
    expect(colorForScopes(theme, ["string"])).toBe("#9ecbff");
    expect(colorForScopes(theme, ["string.regexp"])).toBe("#dbedff");
  });

  it("matches by prefix in both directions", () => {
    expect(colorForScopes(theme, ["constant.numeric"])).toBe("#79b8ff");
    expect(colorForScopes(theme, ["keyword"])).toBe("#f97583");
    expect(colorForScopes(theme, ["support.function"])).toBe("#b392f0");
  });

  it("tries scopes in order and rejects non-hex colors", () => {
    expect(colorForScopes(theme, ["markup.heading", "comment"])).toBe(
      "#6a737d",
    );
    expect(colorForScopes(theme, ["variable"])).toBeUndefined();
    expect(colorForScopes(theme, ["nothing.here"])).toBeUndefined();
  });

  it("reads font styles", () => {
    expect(tokenStyleForScopes(theme, ["comment"])).toEqual({
      foreground: "#6a737d",
      fontStyle: "italic",
    });
    expect(tokenStyleForScopes(theme, ["markup.bold"])).toEqual({
      fontStyle: "bold",
    });
  });

  it("validates colors", () => {
    expect(validColor("#abc")).toBe("#abc");
    expect(validColor("#AABBCCDD")).toBe("#AABBCCDD");
    expect(validColor("#abcde")).toBeUndefined();
    expect(validColor("abc")).toBeUndefined();
    expect(validColor("var(--x)")).toBeUndefined();
    expect(validColor(undefined)).toBeUndefined();
  });
});

describe("codeHighlighting", () => {
  it("is empty without a theme", () => {
    expect(codeHighlighting(null)).toEqual([]);
  });

  it("maps lezer tags to theme colors", () => {
    const specs = codeTagStyles(theme);
    const comment = specs.find(
      (spec) => Array.isArray(spec.tag) && spec.tag.includes(tags.comment),
    );
    expect(comment).toMatchObject({ color: "#6a737d", fontStyle: "italic" });
    const keyword = specs.find(
      (spec) => Array.isArray(spec.tag) && spec.tag.includes(tags.keyword),
    );
    expect(keyword).toMatchObject({ color: "#f97583" });
    expect(codeHighlighting(theme)).not.toEqual([]);
  });

  it("accepts the SDK theme shape structurally", () => {
    const sdkLike = {
      name: "github-dark",
      type: "dark" as const,
      fg: "#fff",
      bg: "#000",
      colors: { "editor.background": "#000000" },
      tokenColors: [
        {
          scope: "comment",
          settings: { foreground: "#888888", background: "#000000" },
        },
      ],
    };
    expect(colorForScopes(sdkLike, ["comment"])).toBe("#888888");
  });
});

const SAMPLES: Readonly<Record<string, string>> = {
  sh: 'echo "$HOME" | grep -c x # note',
  js: "const a = { b: 1, c: `t${x}` }; a.b(/re/g);",
  ts: "export function f(x: number): string { return String(x); }",
  json: '{ "a": [1, true, null], "b": "s" }',
  py: "@dec\ndef f(a):\n    return a  # c",
  go: 'func main() { fmt.Println("x", 1) }',
  yaml: "key: value\nlist:\n  - 1 # c",
  sql: "SELECT a, COUNT(*) FROM t WHERE b = 'x' GROUP BY a;",
  rust: 'fn main() { let x: u32 = 1; println!("{}", x); }',
  diff: "@@ -1 +1 @@\n- a\n+ b",
  toml: '[table]\nkey = "v"\nn = 1',
  dockerfile: "FROM node:22\nRUN npm ci # c",
  html: '<div class="a" id=b><!-- c --><p>t</p></div>',
  xml: '<?xml version="1.0"?><a b="c"/>',
  c: "#include <stdio.h>\nint main(void) { return 0; }",
  cpp: "template <class T> struct S { T v; };",
  java: 'public class A { @Override public String toString() { return "a"; } }',
  kotlin: "fun main() { val x: Int = 1 }",
  cs: "public class A { public int B { get; set; } }",
  proto: 'syntax = "proto3"; message A { string b = 1; }',
  swift: 'func f(_ x: Int) -> String { return "\\(x)" }',
  rb: "def f(a) = a.map { |x| x * 2 } # c",
  lua: "local function f(a) return a .. 'x' end -- c",
};

describe("legacy modes", () => {
  it("highlight every supported language without unknown-tag warnings", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      for (const [info, code] of Object.entries(SAMPLES)) {
        const language = codeLanguageFor(info);
        expect(language, info).not.toBeNull();
        const tree = language?.parser.parse(code);
        expect(tree?.length, info).toBe(code.length);
      }
    } finally {
      console.warn = original;
    }
    expect(warnings).toEqual([]);
  });
});
