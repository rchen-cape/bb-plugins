import type { Checks, Column, Person, ReviewerState } from "./contract.js";

export interface Actor {
  login: string;
  avatarUrl: string | null;
  isBot: boolean;
}

export type GitHubReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface ConversationEntry {
  author: Actor;
  at: string;
  hasBody: boolean;
  reviewState: GitHubReviewState | null;
}

export interface PullSnapshot {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  author: Actor | null;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: Checks;
  requestedReviewers: Person[];
  latestReviews: Array<{ author: Actor; state: GitHubReviewState }>;
  reviews: Array<{ author: Actor; state: GitHubReviewState }>;
  commentAuthors: Actor[];
  conversation: ConversationEntry[];
  unresolvedThreads: number;
  unresolvedThreadLastAuthors: Actor[];
  unresolvedThreadAuthors: Actor[][];
}

export function isAutomated(actor: Actor): boolean {
  return actor.isBot || /\[bot\]$/i.test(actor.login) || /copilot/i.test(actor.login) || actor.login === "github-actions";
}

function isReviewer(actor: Actor, pull: PullSnapshot): boolean {
  return !isAutomated(actor) && actor.login !== pull.author?.login;
}

export function humanFeedbackCount(pull: PullSnapshot): number {
  const comments = pull.commentAuthors.filter((actor) => isReviewer(actor, pull)).length;
  const reviews = pull.reviews.filter((review) => review.state !== "PENDING" && isReviewer(review.author, pull)).length;
  return comments + reviews;
}

function humanLatestReviews(pull: PullSnapshot) {
  return pull.latestReviews.filter((review) => isReviewer(review.author, pull));
}

function isApproved(pull: PullSnapshot): boolean {
  if (pull.reviewDecision !== null) return pull.reviewDecision === "APPROVED";
  const latest = humanLatestReviews(pull);
  return latest.some((review) => review.state === "APPROVED") && !latest.some((review) => review.state === "CHANGES_REQUESTED");
}

function hasHumanFeedback(pull: PullSnapshot): boolean {
  return humanFeedbackCount(pull) > 0 || humanLatestReviews(pull).some((review) => review.state !== "PENDING");
}

export function columnFor(pull: PullSnapshot): Column {
  if (pull.isDraft) return "draft";
  if (isApproved(pull)) return "ready";
  if (hasHumanFeedback(pull)) return "reviewing";
  return "open";
}

const REVIEWER_STATES: Partial<Record<GitHubReviewState, ReviewerState>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
};

export function hasTakenPart(pull: PullSnapshot, login: string): boolean {
  return (
    pull.commentAuthors.some((actor) => actor.login === login) ||
    pull.reviews.some((review) => review.author.login === login) ||
    pull.unresolvedThreadAuthors.some((authors) => authors.some((actor) => actor.login === login))
  );
}

export function isAwaitingReplyFrom(pull: PullSnapshot, login: string): boolean {
  if (pull.unresolvedThreadLastAuthors.some((actor) => actor.login === login)) return true;
  return pull.commentAuthors.filter((actor) => !isAutomated(actor)).at(-1)?.login === login;
}

function asksForReply(entry: ConversationEntry): boolean {
  return entry.hasBody && (entry.reviewState === null || entry.reviewState === "COMMENTED" || entry.reviewState === "CHANGES_REQUESTED");
}

function isReplyFrom(entry: ConversationEntry, login: string): boolean {
  return entry.author.login === login && (entry.hasBody || entry.reviewState !== "COMMENTED");
}

export function unansweredCount(pull: PullSnapshot, login: string): number {
  const isAuthor = pull.author?.login === login;
  const threads = pull.unresolvedThreadAuthors.filter((authors) => {
    const people = authors.filter((actor) => !isAutomated(actor));
    const last = people.at(-1);
    return last !== undefined && last.login !== login && (isAuthor || people.some((actor) => actor.login === login));
  }).length;
  const replied = pull.conversation.some((entry) => !isAutomated(entry.author) && isReplyFrom(entry, login));
  if (!replied && !isAuthor) return threads;
  return threads + awaitingReplyFrom(pull.conversation, login).length;
}

export function awaitingReplyFrom<T extends ConversationEntry>(entries: readonly T[], login: string): T[] {
  const conversation = entries.filter((entry) => !isAutomated(entry.author));
  const lastReply = conversation.reduce((last, entry, index) => (isReplyFrom(entry, login) ? index : last), -1);
  return conversation.slice(lastReply + 1).filter((entry) => entry.author.login !== login && asksForReply(entry));
}

export function reviewersOf(pull: PullSnapshot): Array<Person & { state: ReviewerState }> {
  const reviewed = humanLatestReviews(pull).flatMap((review) => {
    const state = REVIEWER_STATES[review.state];
    return state === undefined ? [] : [{ login: review.author.login, avatarUrl: review.author.avatarUrl, state }];
  });
  const seen = new Set(reviewed.map((reviewer) => reviewer.login));
  const requested = pull.requestedReviewers
    .filter((person) => !seen.has(person.login))
    .map((person) => ({ ...person, state: "requested" as const }));
  return [...reviewed, ...requested];
}
