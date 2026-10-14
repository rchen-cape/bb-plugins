import { execFile } from "node:child_process";
import { z } from "zod";
import { awaitingReplyFrom, isAutomated, type Actor, type ConversationEntry, type PullSnapshot } from "./board.js";
import type { Checks, ConversationComment, FileContent, PullDetail, PullFile, ReviewEvent, ReviewThread, Side } from "./contract.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  input?: string;
  maxBuffer?: number;
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<string>;

export class CommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export const runCommand: Runner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trim() || error.message;
        reject(new CommandError(`${command} ${args.slice(0, 2).join(" ")}: ${detail}`, stderr));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

export type Gh = (args: readonly string[], options?: Partial<RunOptions>) => Promise<string>;

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const actorSchema = z.object({
  __typename: z.string().optional(),
  login: z.string(),
  avatarUrl: z.string().nullable().optional(),
});

function toActor(actor: z.infer<typeof actorSchema>): Actor {
  return { login: actor.login, avatarUrl: actor.avatarUrl ?? null, isBot: actor.__typename === "Bot" };
}

const reviewStateSchema = z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

export const BOARD_QUERY = `query($q: String!) {
  search(type: ISSUE, query: $q, first: 100) {
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt headRefName baseRefName additions deletions changedFiles reviewDecision
        repository { nameWithOwner }
        author { __typename login avatarUrl(size: 40) }
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login avatarUrl(size: 40) } } } }
        latestReviews(first: 20) { nodes { state author { __typename login avatarUrl(size: 40) } } }
        reviews(last: 50) { pageInfo { hasPreviousPage } nodes { state body submittedAt author { __typename login } } }
        comments(last: 50) { pageInfo { hasPreviousPage } nodes { createdAt author { __typename login } } }
        reviewThreads(first: 100) { nodes { isResolved comments(last: 20) { nodes { author { __typename login } } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

const boardSchema = z.object({
  data: z.object({
    search: z.object({
        nodes: z.array(
          z.object({
            repository: z.object({ nameWithOwner: z.string() }),
            number: z.number(),
            title: z.string(),
            url: z.string(),
            isDraft: z.boolean(),
            createdAt: z.string(),
            updatedAt: z.string(),
            headRefName: z.string(),
            baseRefName: z.string(),
            additions: z.number(),
            deletions: z.number(),
            changedFiles: z.number(),
            reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
            author: actorSchema.nullable(),
            reviewRequests: z.object({
              nodes: z.array(
                z.object({
                  requestedReviewer: z
                    .object({
                      __typename: z.string(),
                      login: z.string().optional(),
                      avatarUrl: z.string().optional(),
                    })
                    .nullable(),
                }),
              ),
            }),
            latestReviews: z.object({
              nodes: z.array(z.object({ state: reviewStateSchema, author: actorSchema.nullable() })),
            }),
            reviews: z.object({
              pageInfo: z.object({ hasPreviousPage: z.boolean() }),
              nodes: z.array(
                z.object({ state: reviewStateSchema, body: z.string(), submittedAt: z.string().nullable(), author: actorSchema.nullable() }),
              ),
            }),
            comments: z.object({
              pageInfo: z.object({ hasPreviousPage: z.boolean() }),
              nodes: z.array(z.object({ createdAt: z.string(), author: actorSchema.nullable() })),
            }),
            reviewThreads: z.object({
              nodes: z.array(
                z.object({
                  isResolved: z.boolean(),
                  comments: z.object({ nodes: z.array(z.object({ author: actorSchema.nullable() })) }),
                }),
              ),
            }),
            commits: z.object({
              nodes: z.array(
                z.object({
                  commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }),
                }),
              ),
            }),
          }),
        ),
    }),
  }),
});

const CHECK_STATES: Record<string, Checks> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending",
};

function withAuthor<T extends { author: z.infer<typeof actorSchema> | null }>(nodes: T[]) {
  return nodes.flatMap((node) => (node.author === null ? [] : [{ ...node, author: toActor(node.author) }]));
}

type BoardNode = z.infer<typeof boardSchema>["data"]["search"]["nodes"][number];

function windowStart(truncated: boolean, times: Array<string | null>): string {
  return truncated ? (times.filter((at) => at !== null).sort()[0] ?? "") : "";
}

function conversationOf({ comments, reviews }: BoardNode): ConversationEntry[] {
  const commentsSince = windowStart(comments.pageInfo.hasPreviousPage, comments.nodes.map((comment) => comment.createdAt));
  const reviewsSince = windowStart(reviews.pageInfo.hasPreviousPage, reviews.nodes.map((review) => review.submittedAt));
  const since = commentsSince > reviewsSince ? commentsSince : reviewsSince;
  return [
    ...withAuthor(comments.nodes).map((comment) => ({ author: comment.author, at: comment.createdAt, hasBody: true, reviewState: null })),
    ...withAuthor(reviews.nodes).flatMap((review) =>
      review.submittedAt === null
        ? []
        : [{ author: review.author, at: review.submittedAt, hasBody: review.body.trim() !== "", reviewState: review.state }],
    ),
  ]
    .filter((entry) => entry.at >= since)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function parseBoardPulls(raw: string): PullSnapshot[] {
  return boardSchema.parse(JSON.parse(raw)).data.search.nodes.map((node) => ({
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: node.isDraft,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    author: node.author === null ? null : toActor(node.author),
    reviewDecision: node.reviewDecision,
    checks: CHECK_STATES[node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? ""] ?? "none",
    requestedReviewers: node.reviewRequests.nodes.flatMap(({ requestedReviewer: reviewer }) =>
      reviewer?.__typename === "User" && reviewer.login !== undefined
        ? [{ login: reviewer.login, avatarUrl: reviewer.avatarUrl ?? null }]
        : [],
    ),
    latestReviews: withAuthor(node.latestReviews.nodes),
    reviews: withAuthor(node.reviews.nodes),
    commentAuthors: withAuthor(node.comments.nodes).map((comment) => comment.author),
    conversation: conversationOf(node),
    unresolvedThreads: node.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    unresolvedThreadLastAuthors: node.reviewThreads.nodes.flatMap((thread) => {
      const author = thread.comments.nodes.at(-1)?.author;
      return thread.isResolved || author === null || author === undefined ? [] : [toActor(author)];
    }),
    unresolvedThreadAuthors: node.reviewThreads.nodes.flatMap((thread) =>
      thread.isResolved ? [] : [withAuthor(thread.comments.nodes).map((comment) => comment.author)],
    ),
  }));
}

const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title body url state isDraft isCrossRepository additions deletions headRefName baseRefName headRefOid baseRefOid
      author { login avatarUrl(size: 64) }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line startLine diffSide
          comments(first: 50) { nodes { id databaseId body createdAt url author { __typename login avatarUrl(size: 40) } } }
        }
      }
      comments(last: 100) { nodes { id body createdAt url author { __typename login avatarUrl(size: 40) } } }
      reviews(last: 100) { nodes { id state body submittedAt url author { __typename login avatarUrl(size: 40) } } }
    }
  }
}`;

const pullSchema = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z.object({
      pullRequest: z.object({
        id: z.string(),
        number: z.number(),
        title: z.string(),
        body: z.string(),
        url: z.string(),
        state: z.string(),
        isDraft: z.boolean(),
        isCrossRepository: z.boolean(),
        additions: z.number(),
        deletions: z.number(),
        headRefName: z.string(),
        baseRefName: z.string(),
        headRefOid: z.string(),
        baseRefOid: z.string(),
        author: actorSchema.nullable(),
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              isResolved: z.boolean(),
              isOutdated: z.boolean(),
              path: z.string(),
              line: z.number().nullable(),
              startLine: z.number().nullable(),
              diffSide: z.enum(["LEFT", "RIGHT"]),
              comments: z.object({
                nodes: z.array(
                  z.object({
                    id: z.string(),
                    databaseId: z.number(),
                    body: z.string(),
                    createdAt: z.string(),
                    url: z.string(),
                    author: actorSchema.nullable(),
                  }),
                ),
              }),
            }),
          ),
        }),
        comments: z.object({
          nodes: z.array(z.object({ id: z.string(), body: z.string(), createdAt: z.string(), url: z.string(), author: actorSchema.nullable() })),
        }),
        reviews: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              state: reviewStateSchema,
              body: z.string(),
              submittedAt: z.string().nullable(),
              url: z.string(),
              author: actorSchema.nullable(),
            }),
          ),
        }),
      }),
    }),
  }),
});

type PullNode = z.infer<typeof pullSchema>["data"]["repository"]["pullRequest"];

function toPerson(author: z.infer<typeof actorSchema> | null) {
  return author === null ? { login: "ghost", avatarUrl: null } : { login: author.login, avatarUrl: author.avatarUrl ?? null };
}

function isBotAuthor(author: z.infer<typeof actorSchema> | null): boolean {
  return author !== null && isAutomated(toActor(author));
}

export function pullConversation({ comments, reviews }: Pick<PullNode, "comments" | "reviews">): ConversationComment[] {
  return [
    ...comments.nodes.map((comment) => ({
      id: comment.id,
      kind: "comment" as const,
      author: toPerson(comment.author),
      isBot: isBotAuthor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
    })),
    ...reviews.nodes.flatMap((review) =>
      review.submittedAt === null || review.body.trim() === ""
        ? []
        : [
            {
              id: review.id,
              kind: "review" as const,
              author: toPerson(review.author),
              isBot: isBotAuthor(review.author),
              body: review.body,
              createdAt: review.submittedAt,
              url: review.url,
            },
          ],
    ),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function pullAwaitingReply({ comments, reviews }: Pick<PullNode, "comments" | "reviews">, viewer: string): string[] {
  const entries: Array<ConversationEntry & { id: string }> = [
    ...comments.nodes.flatMap((comment) =>
      comment.author === null ? [] : [{ id: comment.id, author: toActor(comment.author), at: comment.createdAt, hasBody: true, reviewState: null }],
    ),
    ...reviews.nodes.flatMap((review) =>
      review.author === null || review.submittedAt === null
        ? []
        : [{ id: review.id, author: toActor(review.author), at: review.submittedAt, hasBody: review.body.trim() !== "", reviewState: review.state }],
    ),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return awaitingReplyFrom(entries, viewer).map((entry) => entry.id);
}

const VIEWED_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } }
    }
  }
}`;

const viewedSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        files: z.object({
          nodes: z.array(z.object({ path: z.string(), viewerViewedState: z.string() })),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        }),
      }),
    }),
  }),
});

const restFileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().nullable().optional(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().nullable().optional(),
});

export function parseFilePages(raw: string): Array<Omit<PullFile, "viewed">> {
  return z
    .array(z.array(restFileSchema))
    .parse(JSON.parse(raw))
    .flat()
    .map((file) => ({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
    }));
}

const GITHUB_SIDE: Record<Side, "LEFT" | "RIGHT"> = { deletions: "LEFT", additions: "RIGHT" };

export interface CommentTarget {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
}

export function reviewCommentFields(target: CommentTarget) {
  const side = GITHUB_SIDE[target.side];
  return {
    path: target.path,
    line: target.endLine,
    side,
    ...(target.startLine < target.endLine ? { start_line: target.startLine, start_side: side } : {}),
  };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function createGitHub(gh: Gh) {
  async function graphql(query: string, variables: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
    const raw = await gh(["api", "graphql", "--input", "-"], { input: JSON.stringify({ query, variables }), timeoutMs });
    const errors = z.object({ errors: z.array(z.object({ message: z.string() })).optional() }).parse(JSON.parse(raw)).errors;
    if (errors !== undefined && errors.length > 0) throw new Error(errors.map((error) => error.message).join("; "));
    return raw;
  }

  function split(repo: string) {
    const [owner, name] = repo.split("/");
    return { owner, name };
  }

  async function viewedStates(repo: string, number: number): Promise<Map<string, boolean>> {
    const viewed = new Map<string, boolean>();
    let after: string | null = null;
    for (let page = 0; page < 30; page++) {
      const raw: string = await graphql(VIEWED_QUERY, { ...split(repo), number, after });
      const files: z.infer<typeof viewedSchema>["data"]["repository"]["pullRequest"]["files"] =
        viewedSchema.parse(JSON.parse(raw)).data.repository.pullRequest.files;
      for (const file of files.nodes) viewed.set(file.path, file.viewerViewedState === "VIEWED");
      if (!files.pageInfo.hasNextPage) break;
      after = files.pageInfo.endCursor;
    }
    return viewed;
  }

  return {
    async searchPulls(query: string): Promise<PullSnapshot[]> {
      return parseBoardPulls(await graphql(BOARD_QUERY, { q: query }));
    },

    async pullDetail(repo: string, number: number): Promise<PullDetail> {
      const [rawPull, rawFiles, viewed] = await Promise.all([
        graphql(PULL_QUERY, { ...split(repo), number }),
        gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/files?per_page=100`], { timeoutMs: 120_000 }),
        viewedStates(repo, number),
      ]);
      const { viewer, repository } = pullSchema.parse(JSON.parse(rawPull)).data;
      const pull = repository.pullRequest;
      const mergeBaseSha = (
        await gh(["api", `repos/${repo}/compare/${pull.baseRefOid}...${pull.headRefOid}`, "--jq", ".merge_base_commit.sha"], {
          timeoutMs: 60_000,
        })
      ).trim();
      const threads: ReviewThread[] = pull.reviewThreads.nodes.map((thread) => ({
        id: thread.id,
        path: thread.path,
        side: thread.diffSide === "LEFT" ? "deletions" : "additions",
        line: thread.line,
        startLine: thread.startLine,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        comments: thread.comments.nodes.map((comment) => ({
          id: comment.id,
          databaseId: comment.databaseId,
          isBot: isBotAuthor(comment.author),
          body: comment.body,
          createdAt: comment.createdAt,
          url: comment.url,
          author: comment.author === null ? { login: "ghost", avatarUrl: null } : { login: comment.author.login, avatarUrl: comment.author.avatarUrl ?? null },
        })),
      }));
      return {
        repo,
        number,
        nodeId: pull.id,
        title: pull.title,
        body: pull.body,
        url: pull.url,
        state: pull.state,
        isDraft: pull.isDraft,
        isCrossRepository: pull.isCrossRepository,
        author: pull.author === null ? { login: "ghost", avatarUrl: null } : { login: pull.author.login, avatarUrl: pull.author.avatarUrl ?? null },
        headRefName: pull.headRefName,
        baseRefName: pull.baseRefName,
        headSha: pull.headRefOid,
        mergeBaseSha,
        additions: pull.additions,
        deletions: pull.deletions,
        viewer: viewer.login,
        files: parseFilePages(rawFiles).map((file) => ({ ...file, viewed: viewed.get(file.path) ?? false })),
        threads,
        conversation: pullConversation(pull),
        awaitingReply: pullAwaitingReply(pull, viewer.login),
      };
    },

    async fileAt(repo: string, sha: string, path: string): Promise<FileContent> {
      try {
        const content = await gh(
          ["api", "-H", "Accept: application/vnd.github.raw+json", `repos/${repo}/contents/${encodePath(path)}?ref=${sha}`],
          { timeoutMs: 60_000, maxBuffer: MAX_FILE_BYTES },
        );
        if (content.includes("\u0000")) return { content: null, unavailable: "binary" };
        return { content, unavailable: null };
      } catch (error) {
        if (error instanceof CommandError && /HTTP 404/.test(error.stderr)) return { content: null, unavailable: "missing" };
        if (error instanceof RangeError || (error instanceof Error && /maxBuffer/i.test(error.message))) {
          return { content: null, unavailable: "too-large" };
        }
        throw error;
      }
    },

    async submitReview(repo: string, number: number, review: { headSha: string; event: ReviewEvent; body: string; comments: Array<CommentTarget & { body: string }> }) {
      const raw = await gh(["api", "--method", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", "-"], {
        input: JSON.stringify({
          commit_id: review.headSha,
          event: review.event,
          ...(review.body.trim().length > 0 ? { body: review.body } : {}),
          comments: review.comments.map((comment) => ({ ...reviewCommentFields(comment), body: comment.body })),
        }),
      });
      return z.object({ html_url: z.string().nullable().optional() }).parse(JSON.parse(raw)).html_url ?? null;
    },

    async postComment(repo: string, number: number, headSha: string, target: CommentTarget, body: string): Promise<void> {
      await gh(["api", "--method", "POST", `repos/${repo}/pulls/${number}/comments`, "--input", "-"], {
        input: JSON.stringify({ commit_id: headSha, body, ...reviewCommentFields(target) }),
      });
    },

    async postIssueComment(repo: string, number: number, body: string): Promise<void> {
      await gh(["api", "--method", "POST", `repos/${repo}/issues/${number}/comments`, "--input", "-"], {
        input: JSON.stringify({ body }),
      });
    },

    async reply(repo: string, number: number, commentId: number, body: string): Promise<void> {
      await gh(["api", "--method", "POST", `repos/${repo}/pulls/${number}/comments/${commentId}/replies`, "--input", "-"], {
        input: JSON.stringify({ body }),
      });
    },

    async resolveThread(threadId: string, resolved: boolean): Promise<void> {
      const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
      await graphql(`mutation($id: ID!) { ${mutation}(input: {threadId: $id}) { thread { id } } }`, { id: threadId });
    },

    async setViewed(pullNodeId: string, path: string, viewed: boolean): Promise<void> {
      const mutation = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
      await graphql(`mutation($id: ID!, $path: String!) { ${mutation}(input: {pullRequestId: $id, path: $path}) { clientMutationId } }`, {
        id: pullNodeId,
        path,
      });
    },
  };
}

export type GitHub = ReturnType<typeof createGitHub>;
