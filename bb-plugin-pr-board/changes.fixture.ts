interface FakeCommit {
  sha: string;
  subject: string;
  files: string[];
  local: boolean;
}

export function fakeRepo(start: string) {
  const history: FakeCommit[] = [];
  const state: { status: string; upstream: string | null; fail: boolean } = { status: "", upstream: start, fail: false };
  const calls: Array<{ args: string[]; okExitCodes: readonly number[] | undefined }> = [];
  const indexOf = (ref: string) => {
    if (ref === start) return -1;
    const index = history.findIndex((commit) => commit.sha === ref);
    if (index === -1) throw new Error(`fatal: bad revision ${ref}`);
    return index;
  };
  const shaAt = (index: number) => (index < 0 ? start : (history[index]?.sha ?? start));
  const head = () => shaAt(history.length - 1);
  const since = (base: string) => history.slice(indexOf(base) + 1).reverse();
  const touches = (line: string, paths: readonly string[]) => paths.length === 0 || paths.some((path) => line.split("\t").slice(1).includes(path));
  const record = (commit: FakeCommit) => `\u001e${commit.sha}\u001f${commit.sha.slice(0, 7)}\u001f${commit.subject}\n\n${commit.files.map((line) => `${line}\n`).join("")}`;

  async function git(args: readonly string[], okExitCodes?: readonly number[]): Promise<string> {
    calls.push({ args: [...args], okExitCodes });
    if (state.fail) throw new Error("fatal: not a git repository");
    const [command = "", ...rest] = args[0] === "-c" ? args.slice(2) : args;
    const range = rest.find((arg) => arg.includes("..")) ?? "";
    const paths = rest.includes("--") ? rest.slice(rest.indexOf("--") + 1) : [];
    if (command === "status") return state.status;
    if (command === "rev-parse" && rest[0] === "HEAD") return `${head()}\n`;
    if (command === "rev-parse" && rest[0] === "@{u}") {
      if (state.upstream === null) throw new Error("fatal: no upstream configured");
      return `${state.upstream}\n`;
    }
    if (command === "rev-parse" && rest[0]?.endsWith("^") === true) return `${shaAt(indexOf(rest[0].slice(0, -1)) - 1)}\n`;
    if (command === "log" && rest[0] === "-g") {
      return history
        .filter((commit) => commit.local)
        .reverse()
        .map((commit) => `${commit.sha}\u001fcommit: ${commit.subject}\n`)
        .join("");
    }
    if (command === "log") {
      return since(range.slice(0, range.indexOf("..")))
        .map((commit) => ({ ...commit, files: commit.files.filter((line) => touches(line, paths)) }))
        .filter((commit) => paths.length === 0 || commit.files.length > 0)
        .map(record)
        .join("");
    }
    if (command === "cat-file") {
      const sha = rest[1]?.replace(/\^\{commit\}$/, "") ?? "";
      if (sha !== start && !history.some((commit) => commit.sha === sha)) throw new Error(`fatal: Not a valid object name ${sha}`);
      return "";
    }
    if (command === "rev-list" && rest[1] === "--not") {
      const newest = Math.max(...rest.slice(2).map(indexOf));
      return history.slice(newest + 1).reverse().map((commit) => `${commit.sha}\n`).join("");
    }
    if (command === "rev-list") return since(range.slice(0, range.indexOf(".."))).map((commit) => `${commit.sha}\n`).join("");
    if (command === "diff" || command === "show") return `patch: ${args.join(" ")}`;
    throw new Error(`unexpected git ${args.join(" ")}`);
  }

  return {
    git,
    state,
    calls,
    head,
    commit(subject: string, files: string[], local = true): string {
      const sha = String(history.length + 1).padStart(40, "c");
      history.push({ sha, subject, files, local });
      return sha;
    },
    push(): void {
      state.upstream = head();
    },
    reset(sha: string): void {
      history.splice(indexOf(sha) + 1);
    },
  };
}
