import { describe, expect, it } from "vitest";
import { parseBoardPulls, parseFilePages, reviewCommentFields } from "./github";

describe("parseBoardPulls", () => {
  it("maps the GraphQL board query into snapshots", () => {
    const raw = JSON.stringify({
      data: {
        search: {
            nodes: [
              {
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
                reviews: { nodes: [{ state: "COMMENTED", author: null }] },
                comments: { nodes: [{ author: { __typename: "User", login: "carol" } }] },
                reviewThreads: {
                  nodes: [
                    { isResolved: false, comments: { nodes: [{ author: { __typename: "User", login: "dave" } }] } },
                    { isResolved: true, comments: { nodes: [{ author: { __typename: "User", login: "erin" } }] } },
                  ],
                },
                commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
              },
            ],
        },
      },
    });
    const [pull] = parseBoardPulls(raw);
    expect(pull).toMatchObject({
      repo: "acme/app",
      number: 7,
      checks: "failure",
      requestedReviewers: [{ login: "bob", avatarUrl: "https://b" }],
      latestReviews: [{ author: { login: "copilot-pull-request-reviewer", isBot: true }, state: "COMMENTED" }],
      reviews: [],
      commentAuthors: [{ login: "carol", isBot: false }],
      unresolvedThreads: 1,
      unresolvedThreadLastAuthors: [{ login: "dave", isBot: false }],
    });
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
