import { describe, expect, it } from "vitest";
import { parseGiftCardReviewTotals } from "../packages/providers/amazon-web/checkout/review-money.js";
const rows = () => [
  { label: "Items:", value: "$7.40" },
  { label: "Shipping & handling:", value: "$0.00" },
  { label: "Estimated tax to be collected:", value: "$0.83" },
  { label: "Total:", value: "$8.23" },
  { label: "Gift Card:", value: "-$8.23" },
  { label: "Order total:", value: "$0.00" },
];
describe("Observed gift-card checkout summary", () => {
  it("keeps purchase price, discount, gift funding and additional payment separate", () => {
    expect(parseGiftCardReviewTotals(rows())).toMatchObject({
      total: { minorUnits: 823 },
      discount: { minorUnits: 0 },
      funding: {
        giftCardApplied: { minorUnits: 823 },
        additionalAmountDue: { minorUnits: 0 },
      },
    });
  });
  it("supports observed partial funding without changing gross price", () => {
    const input = rows();
    input[4]!.value = "-$5.00";
    input[5]!.value = "$3.23";
    expect(parseGiftCardReviewTotals(input)).toMatchObject({
      total: { minorUnits: 823 },
      funding: {
        giftCardApplied: { minorUnits: 500 },
        additionalAmountDue: { minorUnits: 323 },
      },
    });
  });
  it.each([0, 1, 2, 3, 4, 5])(
    "rejects missing or duplicated summary row %i",
    (index) => {
      const input = rows();
      expect(
        parseGiftCardReviewTotals(input.filter((_, i) => i !== index)),
      ).toBeUndefined();
      expect(
        parseGiftCardReviewTotals([...input, input[index]!]),
      ).toBeUndefined();
    },
  );
  it.each(["Rewards", "Other credit", "Unrecognized charge"])(
    "rejects unrecognized monetary row %s",
    (label) => {
      expect(
        parseGiftCardReviewTotals([...rows(), { label, value: "$0.00" }]),
      ).toBeUndefined();
    },
  );
  it.each(["$-8.23", "$8.23", "-€8.23", "-$8,23", "-$8.2", "-$NaN"])(
    "rejects ambiguous gift-credit money %s",
    (value) => {
      const input = rows();
      input[4]!.value = value;
      expect(parseGiftCardReviewTotals(input)).toBeUndefined();
    },
  );
  it("rejects a missing discount when the observed charges leave a nonzero residual", () => {
    const input = rows();
    input[3]!.value = "$7.23";
    input[4]!.value = "-$7.23";
    expect(parseGiftCardReviewTotals(input)).toBeUndefined();
    expect(
      parseGiftCardReviewTotals([
        ...input,
        { label: "Promotions applied", value: "-$1.00" },
      ]),
    ).toMatchObject({
      discount: { minorUnits: 100 },
      total: { minorUnits: 723 },
    });
  });
  it("rejects overfunding, changed tax and a cash-due mismatch", () => {
    for (const [index, value] of [
      [4, "-$8.24"],
      [2, "$0.84"],
      [5, "$0.01"],
    ] as const) {
      const input = rows();
      input[index]!.value = value;
      expect(parseGiftCardReviewTotals(input)).toBeUndefined();
    }
  });
});
