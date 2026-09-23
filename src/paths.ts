import path from "node:path";

const SLUG_MAX_LENGTH = 40;

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+/u, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/_+$/u, "");
  return slug.length > 0 ? slug : "untitled";
}

export function artifactFileName(args: {
  ordinal: number;
  title: string;
}): string {
  const prefix = String(args.ordinal).padStart(2, "0");
  return `${prefix}_${slugify(args.title)}.md`;
}

export function expandHomePath(rawPath: string, homeDirectory: string): string {
  if (rawPath === "~") return homeDirectory;
  if (rawPath.startsWith("~/")) {
    return path.join(homeDirectory, rawPath.slice(2));
  }
  return rawPath;
}

export function resolveRootDirectory(args: {
  rawPath: string;
  homeDirectory: string;
}): string {
  const expanded = expandHomePath(args.rawPath.trim(), args.homeDirectory);
  if (expanded.length === 0) {
    throw new Error("A Trees folder path is required.");
  }
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `The Trees folder must be an absolute path or start with "~/", received "${args.rawPath}".`,
    );
  }
  const normalized = path.normalize(expanded);
  return normalized.length > 1 && normalized.endsWith(path.sep)
    ? normalized.slice(0, -1)
    : normalized;
}

export function projectDirectory(args: {
  rootDirectory: string;
  name: string;
}): string {
  return path.join(args.rootDirectory, slugify(args.name));
}

export function artifactPath(args: {
  directory: string;
  artifactFile: string;
}): string {
  return path.join(args.directory, args.artifactFile);
}

export function markdownStub(title: string): string {
  return `# ${title}\n\n`;
}

export function isMarkdownStub(content: string): boolean {
  return content.replace(/^\s*#[^\n]*\n?/u, "").trim().length === 0;
}
