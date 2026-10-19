import { describe, expect, it } from "vitest";
import { sharedPhrase } from "./suggest";

describe("sharedPhrase", () => {
  it("prefers the longest shared phrase", () => {
    expect(sharedPhrase("How does the token bucket refill?", "Each tenant gets a token bucket.")).toBe("token bucket");
    expect(sharedPhrase("global token bucket size", "the global token bucket is shared")).toBe("global token bucket");
  });

  it("skips stopword edges, numbers, and short words", () => {
    expect(sharedPhrase("of the 2024 api", "the 2024 api of")).toBeNull();
    expect(sharedPhrase("retry the request", "retry later")).toBe("retry");
  });

  it("ignores source markers", () => {
    const body = '<!-- wiki:source notes="Time/x.md" date="2024-01-05" added="2024-01-06" -->\nunrelated';
    expect(sharedPhrase("notes time source", body)).toBeNull();
  });
});
