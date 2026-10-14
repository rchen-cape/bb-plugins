import { describe, expect, it } from "vitest";
import {
  columnFor,
  humanFeedbackCount,
  isAutomated,
  isAwaitingReplyFrom,
  reviewersOf,
  unansweredCount,
  type Actor,
  type ConversationEntry,
  type PullSnapshot,
} from "./board";

const human = (login: string): Actor => ({ login, avatarUrl: null, isBot: false });
const bot = (login: string): Actor => ({ login, avatarUrl: null, isBot: true });
const comment = (author: Actor, at: string): ConversationEntry => ({ author, at, hasBody: true, reviewState: null });
const review = (author: Actor, at: string, reviewState: ConversationEntry["reviewState"], hasBody: boolean): ConversationEntry => ({
  author,
  at,
  hasBody,
  reviewState,
});

function pull(overrides: Partial<PullSnapshot> = {}): PullSnapshot {
  return {
    id: "PR_1",
    repo: "acme/app",
    number: 1,
    title: "Change",
    url: "https://github.com/acme/app/pull/1",
    isDraft: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    headRefName: "feature",
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    author: human("author"),
    reviewDecision: null,
    checks: "none",
    requestedReviewers: [],
    latestReviews: [],
    reviews: [],
    commentAuthors: [],
    conversation: [],
    unresolvedThreads: 0,
    unresolvedThreadLastAuthors: [],
    unresolvedThreadAuthors: [],
    ...overrides,
  };
}

describe("isAutomated", () => {
  it.each([
    [bot("github-actions"), true],
    [human("github-actions"), true],
    [human("dependabot[bot]"), true],
    [human("copilot-pull-request-reviewer"), true],
    [human("Copilot"), true],
    [human("alice"), false],
  ])("%o is automated: %s", (actor, expected) => {
    expect(isAutomated(actor)).toBe(expected);
  });
});

describe("columnFor", () => {
  it("puts drafts in draft even when approved", () => {
    expect(columnFor(pull({ isDraft: true, reviewDecision: "APPROVED" }))).toBe("draft");
  });

  it("keeps PRs with only bot, Copilot, and author comments in open", () => {
    const quiet = pull({
      commentAuthors: [bot("github-actions"), human("author"), human("Copilot")],
      reviews: [{ author: bot("copilot-pull-request-reviewer"), state: "COMMENTED" }],
    });
    expect(columnFor(quiet)).toBe("open");
    expect(humanFeedbackCount(quiet)).toBe(0);
  });

  it("moves PRs with a human comment or review into reviewing", () => {
    expect(columnFor(pull({ commentAuthors: [human("alice")] }))).toBe("reviewing");
    expect(columnFor(pull({ reviews: [{ author: human("bob"), state: "CHANGES_REQUESTED" }] }))).toBe("reviewing");
  });

  it("ignores pending reviews", () => {
    const pending = { author: human("bob"), state: "PENDING" as const };
    expect(columnFor(pull({ reviews: [pending], latestReviews: [pending] }))).toBe("open");
  });

  it("counts a latest review that fell outside the recent reviews window", () => {
    expect(columnFor(pull({ reviewDecision: "REVIEW_REQUIRED", latestReviews: [{ author: human("bob"), state: "COMMENTED" }] }))).toBe("reviewing");
  });

  it("uses GitHub's review decision for ready", () => {
    expect(columnFor(pull({ reviewDecision: "APPROVED" }))).toBe("ready");
    const needsMore = pull({
      reviewDecision: "REVIEW_REQUIRED",
      latestReviews: [{ author: human("bob"), state: "APPROVED" }],
      reviews: [{ author: human("bob"), state: "APPROVED" }],
    });
    expect(columnFor(needsMore)).toBe("reviewing");
  });

  it("treats a human approval as ready when the repo requires no reviews", () => {
    const approved = pull({
      latestReviews: [{ author: human("bob"), state: "APPROVED" }],
      reviews: [{ author: human("bob"), state: "APPROVED" }],
    });
    expect(columnFor(approved)).toBe("ready");
    const blocked = pull({
      latestReviews: [
        { author: human("bob"), state: "APPROVED" },
        { author: human("carol"), state: "CHANGES_REQUESTED" },
      ],
    });
    expect(columnFor(blocked)).toBe("reviewing");
  });
});

describe("reviewersOf", () => {
  it("lists human reviews first and then outstanding requests", () => {
    const reviewers = reviewersOf(
      pull({
        latestReviews: [
          { author: human("bob"), state: "APPROVED" },
          { author: bot("copilot-pull-request-reviewer"), state: "COMMENTED" },
          { author: human("dave"), state: "DISMISSED" },
        ],
        requestedReviewers: [
          { login: "bob", avatarUrl: null },
          { login: "erin", avatarUrl: null },
        ],
      }),
    );
    expect(reviewers.map((reviewer) => [reviewer.login, reviewer.state])).toEqual([
      ["bob", "approved"],
      ["erin", "requested"],
    ]);
  });
});

describe("isAwaitingReplyFrom", () => {
  it("is true while my comment is the latest in an unresolved thread or the conversation", () => {
    expect(isAwaitingReplyFrom(pull({ unresolvedThreadLastAuthors: [human("other"), human("me")] }), "me")).toBe(true);
    expect(isAwaitingReplyFrom(pull({ commentAuthors: [human("other"), human("me"), bot("github-actions")] }), "me")).toBe(true);
  });

  it("is false once someone replies", () => {
    expect(isAwaitingReplyFrom(pull({ unresolvedThreadLastAuthors: [human("other")] }), "me")).toBe(false);
    expect(isAwaitingReplyFrom(pull({ commentAuthors: [human("me"), human("other")] }), "me")).toBe(false);
  });
});

describe("unansweredCount", () => {
  it("counts unresolved code comments on my PR where someone else replied last", () => {
    const mine = pull({
      author: human("me"),
      unresolvedThreadAuthors: [[human("alice")], [human("alice"), human("me")], [human("me"), human("bob"), bot("github-actions")], [bot("Copilot")]],
    });
    expect(unansweredCount(mine, "me")).toBe(2);
  });

  it("only counts code comments I replied in on someone else's PR", () => {
    const theirs = pull({ unresolvedThreadAuthors: [[human("bob")], [human("me"), human("author")], [human("author"), human("me")]] });
    expect(unansweredCount(theirs, "me")).toBe(1);
  });

  it("counts conversation comments and reviews with text after my latest reply", () => {
    const mine = pull({
      author: human("me"),
      conversation: [
        comment(human("alice"), "2026-10-01T00:00:00Z"),
        comment(human("me"), "2026-10-02T00:00:00Z"),
        comment(human("alice"), "2026-10-03T00:00:00Z"),
        review(human("bob"), "2026-10-04T00:00:00Z", "CHANGES_REQUESTED", true),
        review(human("bob"), "2026-10-05T00:00:00Z", "COMMENTED", false),
        review(human("carol"), "2026-10-06T00:00:00Z", "APPROVED", true),
        comment(bot("vercel"), "2026-10-07T00:00:00Z"),
      ],
    });
    expect(unansweredCount(mine, "me")).toBe(2);
  });

  it("counts every conversation comment on my PR before I first reply", () => {
    expect(unansweredCount(pull({ author: human("me"), conversation: [comment(human("alice"), "2026-10-01T00:00:00Z")] }), "me")).toBe(1);
  });

  it("treats my approval as a reply but not a review that only holds code-comment replies", () => {
    const approved = pull({
      conversation: [comment(human("me"), "2026-10-01T00:00:00Z"), comment(human("author"), "2026-10-02T00:00:00Z"), review(human("me"), "2026-10-03T00:00:00Z", "APPROVED", false)],
    });
    expect(unansweredCount(approved, "me")).toBe(0);
    const repliedInline = pull({
      conversation: [comment(human("me"), "2026-10-01T00:00:00Z"), comment(human("author"), "2026-10-02T00:00:00Z"), review(human("me"), "2026-10-03T00:00:00Z", "COMMENTED", false)],
    });
    expect(unansweredCount(repliedInline, "me")).toBe(1);
  });

  it("ignores the conversation on someone else's PR until I post in it", () => {
    expect(unansweredCount(pull({ conversation: [comment(human("author"), "2026-10-01T00:00:00Z")] }), "me")).toBe(0);
  });
});
