import { describe, expect, it } from "vitest";
import { isModernReviewUrl, isReviewUrl } from "../packages/core/purchasing.js";

const review = "https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc";
describe("Modern purchase review destinations", () => {
  it.each([
    "",
    "?pipelineType=Chewbacca&isBuyNow=1&hasWorkingJavascript=1",
    "?pipelineType=Chewbacca&isBuyNow=1&referrer=checkout",
  ])(
    "recognizes an exact modern review with its routing parameters %s",
    (routing) => {
      expect(isModernReviewUrl(review + routing)).toBe(true);
      expect(isReviewUrl(review + routing)).toBe(true);
    },
  );
  it.each([
    review + "?isBuyNow=1&isBuyNow=0",
    review + "?purchaseId=one&purchaseId=two",
    review + "?action=submit",
    review + "#place-order",
    review + "/place-order",
    review.replace("www.amazon.com", "evil.example"),
    review.replace("www.amazon.com", "www.amazon.com.evil.example"),
    review.replace("www.amazon.com", "owner:secret@www.amazon.com"),
    review.replace("p-123-1111111-2222222", "p-wrong") + "?isBuyNow=1",
  ])("rejects ambiguous or foreign modern routing %s", (url) => {
    expect(isModernReviewUrl(url)).toBe(false);
    expect(isReviewUrl(url)).toBe(false);
  });
  it("retains legacy destinations and rejects repeated legacy routing keys", () => {
    expect(
      isReviewUrl("https://www.amazon.com/checkout/p/review?ref_=fixture"),
    ).toBe(true);
    expect(
      isReviewUrl("https://www.amazon.com/checkout/p/review?ref_=one&ref_=two"),
    ).toBe(false);
  });
});
