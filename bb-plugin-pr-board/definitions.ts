import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Definition, DefinitionResult } from "./contract.js";
import { CommandError, type Runner } from "./github.js";
import type { GoplsSessions } from "./gopls.js";

const MAX_DEFINITIONS = 20;
const PREVIEW_LIMIT = 200;

type Language = "go" | "script" | "python" | "rust" | "c" | "jvm" | "proto";

const LANGUAGES: Record<string, Language> = {
  ".go": "go",
  ".ts": "script",
  ".tsx": "script",
  ".mts": "script",
  ".cts": "script",
  ".js": "script",
  ".jsx": "script",
  ".mjs": "script",
  ".cjs": "script",
  ".py": "python",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "c",
  ".cpp": "c",
  ".cxx": "c",
  ".hh": "c",
  ".hpp": "c",
  ".m": "c",
  ".mm": "c",
  ".java": "jvm",
  ".kt": "jvm",
  ".kts": "jvm",
  ".scala": "jvm",
  ".swift": "jvm",
  ".cs": "jvm",
  ".proto": "proto",
};

export function languageOf(path: string): Language | null {
  return LANGUAGES[extname(path).toLowerCase()] ?? null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function definitionPatterns(language: Language | null, symbol: string): RegExp[] {
  const name = `${escapeRegExp(symbol)}(?![\\w$])`;
  const notStatement = "(?!\\s*(?:return|else|case|if|while|for|switch|do|throw|delete|new|await|yield)\\b)";
  const sources: Record<Language | "any", string[]> = {
    go: [
      `^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${name}`,
      `^\\s*(?:type|var|const)\\s+${name}`,
      `^\\s+${name}(?:\\s*,\\s*\\w+)*(?:\\s+[\\w*\\[\\]().]+.*|\\s*:?=[^=].*)?$`,
    ],
    script: [
      `(?:^|[\\s(])(?:function\\*?|class|interface|type|enum|namespace|module|const|let|var)\\s+${name}`,
      `^${notStatement}\\s*(?:(?:public|private|protected|static|readonly|abstract|async|override|declare|get|set)\\s+)*\\*?${name}\\s*(?:<[^>]*>)?\\s*\\([^;]*\\{\\s*$`,
      `^\\s*(?:readonly\\s+)?${name}\\s*[?!]?\\s*:(?!:)`,
    ],
    python: [`^\\s*(?:async\\s+)?def\\s+${name}`, `^\\s*class\\s+${name}`, `^\\s*${name}\\s*(?::[^=]+)?=[^=]`],
    rust: [
      `\\b(?:fn|struct|enum|trait|type|const|static|mod|union)\\s+${name}`,
      `\\bmacro_rules!\\s*${name}`,
      `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?${name}\\s*:(?!:)`,
    ],
    c: [
      `^\\s*#\\s*define\\s+${name}`,
      `\\b(?:struct|class|enum|union|namespace)\\s+(?:\\w+\\s+)*${name}\\s*(?:[:{]|$)`,
      `\\btypedef\\b.*\\b${name}\\s*;`,
      `^${notStatement}[A-Za-z_][\\w\\s*&:<>,~]*?\\b${name}\\s*\\([^;]*$`,
    ],
    jvm: [
      `\\b(?:class|interface|enum|record|struct|protocol|object|trait|func|fun|def|typealias|extension|val|var|let)\\s+${name}`,
      `^${notStatement}\\s*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|open|suspend|inline)\\s+)*[\\w<>\\[\\],.?]+\\s+${name}\\s*\\([^;]*$`,
    ],
    proto: [
      `^\\s*(?:message|enum|service|rpc|oneof)\\s+${name}`,
      `^\\s*(?:optional\\s+|repeated\\s+|required\\s+)?[\\w.<>,]+\\s+${name}\\s*=\\s*\\d+`,
    ],
    any: [
      `\\b(?:function|class|interface|type|enum|struct|trait|def|fn|func|fun|const|let|var|typedef|record|protocol)\\s+${name}`,
      `#\\s*define\\s+${name}`,
    ],
  };
  return sources[language ?? "any"].map((source) => new RegExp(source));
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export function parseGitGrep(raw: string, sha: string): GrepMatch[] {
  const prefix = `${sha}:`;
  return raw.split("\n").flatMap((record) => {
    const [file, line, ...rest] = record.split("\u0000");
    if (file === undefined || line === undefined || rest.length === 0) return [];
    return [{ path: file.startsWith(prefix) ? file.slice(prefix.length) : file, line: Number(line), text: rest.join("\u0000") }];
  });
}

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= PREVIEW_LIMIT ? trimmed : `${trimmed.slice(0, PREVIEW_LIMIT - 1)}…`;
}

const VENDORED = /(?:^|\/)(?:vendor|node_modules|third_party)\//;
const TEST_FILE = /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)tests?\/)/;

export function rankDefinitions(matches: readonly GrepMatch[], fromPath: string, symbol: string): Definition[] {
  const fromLanguage = languageOf(fromPath);
  const fromDir = posix.dirname(fromPath);
  const patterns = new Map<Language | null, RegExp[]>();
  const isDefinition = (match: GrepMatch) => {
    const language = languageOf(match.path);
    let list = patterns.get(language);
    if (list === undefined) {
      list = definitionPatterns(language, symbol);
      patterns.set(language, list);
    }
    return list.some((pattern) => pattern.test(match.text));
  };
  const score = (match: GrepMatch) => [
    VENDORED.test(match.path) ? 1 : 0,
    fromLanguage !== null && languageOf(match.path) !== fromLanguage ? 1 : 0,
    match.path === fromPath ? 0 : 1,
    posix.dirname(match.path) === fromDir ? 0 : 1,
    TEST_FILE.test(match.path) ? 1 : 0,
  ];
  return matches
    .filter(isDefinition)
    .map((match) => ({ match, score: score(match) }))
    .sort((left, right) => {
      for (let index = 0; index < left.score.length; index++) {
        const delta = left.score[index]! - right.score[index]!;
        if (delta !== 0) return delta;
      }
      return left.match.path.localeCompare(right.match.path) || left.match.line - right.match.line;
    })
    .slice(0, MAX_DEFINITIONS)
    .map(({ match }) => ({ path: match.path, line: match.line, preview: preview(match.text), external: false }));
}

export interface DefinitionQuery {
  worktree: string;
  sha: string;
  atHead: boolean;
  path: string;
  line: number;
  character: number;
  symbol: string;
}

async function lineOf(file: string, line: number): Promise<string | null> {
  try {
    return (await readFile(file, "utf8")).split("\n")[line - 1] ?? null;
  } catch {
    return null;
  }
}

async function goplsDefinition(sessions: GoplsSessions, gopls: string, query: DefinitionQuery): Promise<Definition | null> {
  const source = join(query.worktree, query.path);
  const text = await lineOf(source, query.line);
  if (text === null || text.slice(query.character, query.character + query.symbol.length) !== query.symbol) return null;
  const found = await sessions.definition(gopls, query.worktree, query.sha, source, query.line, query.character);
  if (found === null) return null;
  const file = fileURLToPath(found.uri);
  const line = found.line + 1;
  const inWorktree = relative(query.worktree, file);
  const external = inWorktree.startsWith("..") || isAbsolute(inWorktree);
  return {
    path: external ? file : inWorktree.split(sep).join("/"),
    line,
    preview: preview((await lineOf(file, line)) ?? ""),
    external,
  };
}

async function ensureCommit(run: Runner, worktree: string, sha: string): Promise<void> {
  try {
    await run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: worktree, timeoutMs: 15_000 });
  } catch {
    await run("git", ["fetch", "--no-tags", "origin", sha], { cwd: worktree, timeoutMs: 120_000 });
  }
}

async function searchDefinitions(run: Runner, query: DefinitionQuery): Promise<Definition[]> {
  await ensureCommit(run, query.worktree, query.sha);
  let raw: string;
  try {
    raw = await run(
      "git",
      ["grep", "-n", "-z", "-I", "-w", "-F", "--full-name", "-e", query.symbol, query.sha, "--", ".", ":(exclude)**/node_modules/**"],
      { cwd: query.worktree, timeoutMs: 60_000, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (error) {
    if (error instanceof CommandError && error.stderr.trim() === "") return [];
    throw error;
  }
  return rankDefinitions(parseGitGrep(raw, query.sha), query.path, query.symbol);
}

export async function findDefinitions(
  run: Runner,
  gopls: { path: string; sessions: GoplsSessions } | null,
  query: DefinitionQuery,
): Promise<DefinitionResult> {
  if (gopls !== null && query.atHead && languageOf(query.path) === "go") {
    const found = await goplsDefinition(gopls.sessions, gopls.path, query).catch(() => null);
    if (found !== null) return { symbol: query.symbol, source: "gopls", definitions: [found], message: null };
  }
  const definitions = await searchDefinitions(run, query);
  return {
    symbol: query.symbol,
    source: "search",
    definitions,
    message: definitions.length === 0 ? `No definition of ${query.symbol} found.` : null,
  };
}
