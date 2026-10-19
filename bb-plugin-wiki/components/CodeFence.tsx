import { useSettings, type ExperimentalCodeFenceRendererProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { WikiBookOpenIcon } from "./bits";
import { addRequests } from "./requests";

export const WIKI_CODE_LANGUAGES: string[] = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "yaml",
  "yml",
  "toml",
  "bash",
  "sh",
  "zsh",
  "shell",
  "console",
  "python",
  "py",
  "go",
  "rust",
  "rs",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "h",
  "sql",
  "graphql",
  "html",
  "css",
  "scss",
  "xml",
  "diff",
  "dockerfile",
  "makefile",
  "ruby",
  "rb",
  "php",
  "lua",
  "proto",
  "text",
  "txt",
  "mermaid",
  "typescript",
  "javascript",
  "markdown",
  "md",
  "jsonc",
  "ini",
  "csv",
  "csharp",
  "cs",
  "r",
  "scala",
  "hcl",
  "terraform",
  "powershell",
  "ps1",
];

export function CodeFenceWithWikiButton({ code, language, status, message, Original }: ExperimentalCodeFenceRendererProps) {
  const { values } = useSettings();
  if (values?.codeBlockButton === false) return <Original />;

  const add = () => {
    const delivered = addRequests.emit({ kind: "code", threadId: message.threadId, messageId: message.id, code, language });
    if (!delivered) toast.error("The Wiki is still loading. Try again in a moment.");
  };

  return (
    <div className="group/wiki relative">
      <Original />
      {status === "closed" ? (
        <button
          type="button"
          title="Add to Wiki"
          aria-label="Add to Wiki"
          onClick={add}
          className={cn(
            "absolute z-10 inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/wiki:opacity-100 group-focus-within/wiki:opacity-100 pointer-coarse:opacity-100",
            language === "mermaid" ? "right-24 top-[11px]" : "right-13 top-[7px]",
          )}
        >
          <WikiBookOpenIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
