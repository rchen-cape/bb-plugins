import { describe, expect, it } from "vitest";
import { parseBoardPulls, parseFilePages, parseListedPulls, pullAwaitingReply, pullConversation, reviewCommentFields } from "./github";

const NODE = {
  id: "PR_7",
  repository: { nameWithOwner: "acme/app" },
  number: 7,
  title: "Add thing",
  url: "https://github.com/acme/app/pull/7",
  isDraft: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  headRefName: "thing",
  baseRefName: "main",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  reviewDecision: null,
  author: { __typename: "User", login: "alice", avatarUrl: "https://a" },
  reviewRequests: {
    nodes: [
      { requestedReviewer: { __typename: "User", login: "bob", avatarUrl: "https://b" } },
      { requestedReviewer: { __typename: "Team" } },
    ],
  },
  latestReviews: { nodes: [{ state: "COMMENTED", author: { __typename: "Bot", login: "copilot-pull-request-reviewer", avatarUrl: "https://c" } }] },
  reviews: {
    pageInfo: { hasPreviousPage: false },
    nodes: [
      { state: "COMMENTED", body: "", submittedAt: "2026-10-01T01:00:00Z", author: null },
      { state: "CHANGES_REQUESTED", body: "Split this up", submittedAt: "2026-10-01T03:00:00Z", author: { __typename: "User", login: "bob" } },
      { state: "COMMENTED", body: " ", submittedAt: "2026-10-01T04:00:00Z", author: { __typename: "User", login: "bob" } },
      { state: "PENDING", body: "draft", submittedAt: null, author: { __typename: "User", login: "erin" } },
    ],
  },
  comments: { pageInfo: { hasPreviousPage: false }, nodes: [{ createdAt: "2026-10-01T03:30:00Z", author: { __typename: "User", login: "carol" } }] },
  reviewThreads: {
    nodes: [
      {
        isResolved: false,
        comments: { nodes: [{ author: { __typename: "User", login: "erin" } }, { author: { __typename: "User", login: "dave" } }] },
      },
      { isResolved: true, comments: { nodes: [{ author: { __typename: "User", login: "erin" } }] } },
    ],
  },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
};

const boardRaw = (node: unknown) => JSON.stringify({ data: { nodes: [node, null] } });

describe("parseBoardPulls", () => {
  it("maps the GraphQL board query into snapshots", () => {
    const [pull] = parseBoardPulls(boardRaw(NODE));
    expect(parseBoardPulls(boardRaw(NODE))).toHaveLength(1);
    expect(pull).toMatchObject({
      id: "PR_7",
      repo: "acme/app",
      number: 7,
      checks: "failure",
      requestedReviewers: [{ login: "bob", avatarUrl: "https://b" }],
      latestReviews: [{ author: { login: "copilot-pull-request-reviewer", isBot: true }, state: "COMMENTED" }],
      reviews: [{ author: { login: "bob" }, state: "CHANGES_REQUESTED" }, { author: { login: "bob" }, state: "COMMENTED" }, { author: { login: "erin" }, state: "PENDING" }],
      commentAuthors: [{ login: "carol", isBot: false }],
      conversation: [
        { author: { login: "bob" }, at: "2026-10-01T03:00:00Z", hasBody: true, reviewState: "CHANGES_REQUESTED" },
        { author: { login: "carol" }, at: "2026-10-01T03:30:00Z", hasBody: true, reviewState: null },
        { author: { login: "bob" }, at: "2026-10-01T04:00:00Z", hasBody: false, reviewState: "COMMENTED" },
      ],
      unresolvedThreads: 1,
      unresolvedThreadLastAuthors: [{ login: "dave", isBot: false }],
      unresolvedThreadAuthors: [[{ login: "erin" }, { login: "dave" }]],
    });
  });

  it("drops conversation entries older than the start of a cut-off comment or review window", () => {
    const [cutComments] = parseBoardPulls(
      boardRaw({
        ...NODE,
        comments: { pageInfo: { hasPreviousPage: true }, nodes: [{ createdAt: "2026-10-01T03:30:00Z", author: { __typename: "Bot", login: "vercel" } }] },
      }),
    );
    expect(cutComments?.conversation.map((entry) => [entry.author.login, entry.at])).toEqual([
      ["vercel", "2026-10-01T03:30:00Z"],
      ["bob", "2026-10-01T04:00:00Z"],
    ]);
    const [cutReviews] = parseBoardPulls(boardRaw({ ...NODE, reviews: { pageInfo: { hasPreviousPage: true }, nodes: NODE.reviews.nodes.slice(2) } }));
    expect(cutReviews?.conversation.map((entry) => [entry.author.login, entry.at])).toEqual([["bob", "2026-10-01T04:00:00Z"]]);
  });
});

describe("parseFilePages", () => {
  it("flattens slurped REST pages", () => {
    const raw = JSON.stringify([
      [{ filename: "a.go", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@" }],
      [{ filename: "b.go", previous_filename: "old.go", status: "renamed", additions: 0, deletions: 0 }],
    ]);
    expect(parseFilePages(raw)).toEqual([
      { path: "a.go", previousPath: null, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@" },
      { path: "b.go", previousPath: "old.go", status: "renamed", additions: 0, deletions: 0, patch: null },
    ]);
  });
});

describe("reviewCommentFields", () => {
  it("maps sides and only sends a start line for ranges", () => {
    expect(reviewCommentFields({ path: "a.go", side: "additions", startLine: 4, endLine: 4 })).toEqual({ path: "a.go", line: 4, side: "RIGHT" });
    expect(reviewCommentFields({ path: "a.go", side: "deletions", startLine: 2, endLine: 5 })).toEqual({
      path: "a.go",
      line: 5,
      side: "LEFT",
      start_line: 2,
      start_side: "LEFT",
    });
  });
});

describe("parseListedPulls", () => {
  it("keeps only each PR's id, last update, and CI state", () => {
    const raw = JSON.stringify({
      data: {
        search: {
          nodes: [
            { id: "PR_1", updatedAt: "2026-10-02T00:00:00Z", commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } },
            { id: "PR_2", updatedAt: "2026-10-01T00:00:00Z", commits: { nodes: [] } },
          ],
        },
      },
    });
    expect(parseListedPulls(raw)).toEqual([
      { id: "PR_1", updatedAt: "2026-10-02T00:00:00Z", checks: "pending" },
      { id: "PR_2", updatedAt: "2026-10-01T00:00:00Z", checks: "none" },
    ]);
  });
});

describe("pullAwaitingReply", () => {
  it("returns others' comments and reviews with text after my last conversation reply, not counting my code-comment replies", () => {
    const reviewer = { __typename: "User", login: "sbarai-cape" };
    const me = { __typename: "User", login: "rchen-cape" };
    const review = (id: string, author: typeof me, submittedAt: string, body = "", state: "COMMENTED" | "APPROVED" = "COMMENTED") => ({
      id,
      state,
      body,
      submittedAt,
      url: "r",
      author,
    });
    const awaiting = pullAwaitingReply(
      {
        comments: {
          nodes: [
            { id: "IC_old", body: "Early question", createdAt: "2026-10-01T00:00:00Z", url: "c", author: reviewer },
            { id: "IC_answer", body: "Answered", createdAt: "2026-10-02T00:00:00Z", url: "c", author: me },
            { id: "IC_bot", body: "Deployed", createdAt: "2026-10-14T00:00:00Z", url: "c", author: { __typename: "Bot", login: "vercel" } },
          ],
        },
        reviews: {
          nodes: [
            review("PRR_inline", me, "2026-10-07T18:28:02Z"),
            review("PRR_summary", reviewer, "2026-10-12T19:16:29Z", "Overall, looks good to me, left a few minor comments."),
            review("PRR_reply", reviewer, "2026-10-13T21:47:57Z"),
            review("PRR_lgtm", reviewer, "2026-10-13T22:00:00Z", "LGTM", "APPROVED"),
          ],
        },
      },
      "rchen-cape",
    );
    expect(awaiting).toEqual(["PRR_summary"]);
  });
});

describe("pullConversation", () => {
  it("merges comments and reviews with text in time order", () => {
    const author = { login: "bob", avatarUrl: "https://b" };
    const conversation = pullConversation({
      comments: {
        nodes: [
          { id: "IC_1", body: "Later", createdAt: "2026-10-01T03:00:00Z", url: "c", author: null },
          { id: "IC_2", body: "Deployed", createdAt: "2026-10-01T05:00:00Z", url: "c", author: { __typename: "Bot", login: "vercel", avatarUrl: null } },
        ],
      },
      reviews: {
        nodes: [
          { id: "PRR_1", state: "CHANGES_REQUESTED", body: "Split this", submittedAt: "2026-10-01T02:00:00Z", url: "r", author },
          { id: "PRR_2", state: "COMMENTED", body: "  ", submittedAt: "2026-10-01T04:00:00Z", url: "r", author },
          { id: "PRR_3", state: "PENDING", body: "Draft", submittedAt: null, url: "r", author },
          { id: "PRR_4", state: "COMMENTED", body: "Summary", submittedAt: "2026-10-01T06:00:00Z", url: "r", author: { login: "Copilot" } },
        ],
      },
    });
    expect(conversation).toEqual([
      { id: "PRR_1", kind: "review", author, isBot: false, body: "Split this", createdAt: "2026-10-01T02:00:00Z", url: "r" },
      { id: "IC_1", kind: "comment", author: { login: "ghost", avatarUrl: null }, isBot: false, body: "Later", createdAt: "2026-10-01T03:00:00Z", url: "c" },
      { id: "IC_2", kind: "comment", author: { login: "vercel", avatarUrl: null }, isBot: true, body: "Deployed", createdAt: "2026-10-01T05:00:00Z", url: "c" },
      { id: "PRR_4", kind: "review", author: { login: "Copilot", avatarUrl: null }, isBot: true, body: "Summary", createdAt: "2026-10-01T06:00:00Z", url: "r" },
    ]);
  });
});
