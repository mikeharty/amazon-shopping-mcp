import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { extractModernReviewFacts } from "../packages/providers/amazon-web/checkout/modern-review-facts.js";

const url =
  "https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc?pipelineType=Chewbacca&isBuyNow=1&hasWorkingJavascript=1";
describe("Observed single-item modern review facts without executable defaults", () => {
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    fixture: string,
    html: string,
    requests: number;
  beforeAll(async () => {
    browser = await chromium.launch();
    fixture = await readFile(
      new URL("fixtures/modern-review-facts.html", import.meta.url),
      "utf8",
    );
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({ offline: true });
    page = await context.newPage();
    html = fixture;
    requests = 0;
    await page.route("**/*", (route) => {
      requests++;
      return route.fulfill({ contentType: "text/html", body: html });
    });
  });
  afterEach(async () => {
    await context.close();
  });
  async function read(expected = url) {
    await page.goto(url);
    const count = requests;
    const facts = await extractModernReviewFacts(page, expected);
    expect(requests).toBe(count);
    return facts;
  }
  it("reads the exact hidden native ASIN, seller, accessibility price, checked promise, gift totals and applied address", async () => {
    const facts = await read();
    expect(facts).toMatchObject({
      executableTerms: false,
      line: {
        asin: "B0FIXTURE1",
        title: "Fixture 20-piece cable pack",
        sellerId: "A1FIXTURE",
        sellerName: "Fixture Seller",
        quantity: 1,
        unitPrice: { currency: "USD", minorUnits: 740 },
        lineIdentityHash: createHash("sha256")
          .update("PRIVATE_SYNTHETIC_LINE_ID")
          .digest("hex"),
      },
      delivery: {
        promise:
          "FREE delivery Tuesday, November 10 Order within the displayed time.",
        arrivalHeading: "FREE delivery Tuesday, November 10",
        price: { minorUnits: 0 },
      },
      totals: {
        total: { minorUnits: 823 },
        discount: { minorUnits: 0 },
        funding: {
          giftCardApplied: { minorUnits: 823 },
          additionalAmountDue: { minorUnits: 0 },
        },
      },
      address: {
        physicalIdentity: {
          recipient: "FIXTURE OWNER",
          addressLines: ["123 EXAMPLE ST", "APT 4"],
          city: "SEATTLE",
          region: "WA",
          postalCode: "98101",
          country: "US",
        },
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(facts!.line).not.toHaveProperty("condition");
    expect(facts!.line).not.toHaveProperty("purchaseMode");
    expect(JSON.stringify(facts)).not.toMatch(
      /PRIVATE_|anti-csrftoken|data-lineitemid|Condition:|one_time|subscribe_and_save/,
    );
    expect(facts!.delivery.promise).not.toContain("2026");
    expect(requests).toBe(1);
  });
  it("accepts the known offscreen accessibility price even when the price span itself is not rendered", async () => {
    html = html.replace(
      'class="a-offscreen">$7.40',
      'class="a-offscreen" style="display:none">$7.40',
    );
    expect(await read()).toBeDefined();
  });
  it.each([
    [
      "missing native ASIN",
      'data-testid="Item_asin_0_0_0"',
      'data-testid="Other_asin_0_0_0"',
    ],
    [
      "malformed native ASIN marker",
      "Item_asin_0_0_0",
      "Item_asin_0_0_0_extra",
    ],
    ["invalid native ASIN", ">B0FIXTURE1<", ">PRIVATE_ASIN<"],
    [
      "hidden ancestor alternative",
      '<span class="aok-hidden" data-testid="Item_asin_0_0_0">B0FIXTURE1</span>',
      '<div style="display:none"><span class="aok-hidden" data-testid="Item_asin_0_0_0">B0FIXTURE1</span></div>',
    ],
    [
      "duplicate/conflicting native ASIN",
      "</article>",
      '<span class="aok-hidden" data-testid="Item_asin_0_0_1">B0OTHER001</span></article>',
    ],
    [
      "duplicate same native ASIN",
      "</article>",
      '<span class="aok-hidden" data-testid="Item_asin_0_0_1">B0FIXTURE1</span></article>',
    ],
    [
      "conflicting selected row ASIN",
      'id="checkout-item-block-0"',
      'id="checkout-item-block-0" data-asin="B0OTHER001"',
    ],
    ["missing title", "lineitem-title-text break-word", "unknown-title"],
    [
      "foreign seller",
      "https://www.amazon.com/sp?",
      "https://foreign.example/sp?",
    ],
    [
      "duplicate seller ID",
      "seller=A1FIXTURE",
      "seller=A1FIXTURE&amp;seller=A1OTHER",
    ],
    ["invalid seller ID", "seller=A1FIXTURE", "seller=bad"],
    ["quantity mismatch", 'data-steppervalue="1"', 'data-steppervalue="2"'],
    [
      "unrecognized stepper",
      'data-a-component="stepper"',
      'data-a-component="other"',
    ],
    [
      "non-USD price",
      'class="a-offscreen">$7.40',
      'class="a-offscreen">CAD$7.40',
    ],
    [
      "hidden price container",
      'class="a-price apex-price-to-pay-value"',
      'class="a-price apex-price-to-pay-value" style="display:none"',
    ],
    ["missing checked delivery", 'name="delivery" checked', 'name="delivery"'],
    [
      "duplicate checked delivery",
      'name="delivery" value="PRIVATE_UNSELECTED"',
      'name="other-delivery" checked value="PRIVATE_UNSELECTED"',
    ],
    ["incomplete address", "<span>United States</span>", ""],
    ["line ID missing", "data-lineitemid=", "data-not-lineitemid="],
    ["blank line IDs", "PRIVATE_SYNTHETIC_LINE_ID", "   "],
    [
      "line ID conflict",
      'data-lineitemid="PRIVATE_SYNTHETIC_LINE_ID"',
      'data-lineitemid="PRIVATE_OTHER_LINE_ID"',
    ],
    [
      "unknown new charge",
      '</div>\n<div id="checkout-delivery-address-panel"',
      '<div class="order-summary-grid"><div class="order-summary-line-term">Handling fee:</div><div class="order-summary-line-definition">$1.00</div></div></div>\n<div id="checkout-delivery-address-panel"',
    ],
    ["partial gift funding", ">-\u00248.23<", ">-\u00247.23<"],
  ])("rejects %s without manufacturing facts", async (label, from, to) => {
    html =
      label === "line ID missing" || label === "blank line IDs"
        ? html.replaceAll(from, to)
        : html.replace(from, to);
    expect(await read()).toBeUndefined();
  });
  it.each([
    ["row Used", ' data-condition="Used"', ""],
    ["row Renewed", ' condition-type="Renewed"', ""],
    ["row SNS", ' data-purchase-mode="subscribe_and_save"', ""],
    [
      "condition component",
      "",
      '<div class="lineitem-condition-section">Condition: Used</div>',
    ],
    [
      "mode component",
      "",
      '<div data-component="purchaseMode">Subscribe and Save</div>',
    ],
    [
      "selected control",
      "",
      '<select name="purchaseMode"><option selected value="subscribe_and_save">Subscribe and Save</option></select>',
    ],
  ])(
    "rejects explicit contradictory %s evidence in the selected line",
    async (_, attrs, component) => {
      html = html
        .replace(
          'id="checkout-item-block-0"',
          `id="checkout-item-block-0"${attrs}`,
        )
        .replace("</article>", `${component}</article>`);
      expect(await read()).toBeUndefined();
    },
  );
  it("allows explicit matching components while ignoring unselected alternatives and title semantics", async () => {
    html = html
      .replace(
        'id="checkout-item-block-0"',
        'id="checkout-item-block-0" data-condition="New" data-purchase-mode="one_time"',
      )
      .replace(
        "</article>",
        '<div class="lineitem-condition-section">Condition: New</div><select name="purchaseMode"><option value="subscribe_and_save">Subscribe</option><option selected value="one_time">One time</option></select><div hidden data-condition="Used"></div><input type="radio" name="condition" value="Used"></article>',
      );
    expect(await read()).toBeDefined();
  });
  it("rejects a second visible item instead of borrowing row zero for a multi-item checkout", async () => {
    html = html.replace(
      "</article>",
      '</article><article id="checkout-item-block-1"><span data-testid="Item_asin_0_1_0">B0OTHER001</span></article>',
    );
    expect(await read()).toBeUndefined();
  });
  it.each(["root", "review", "title", "price", "total"])(
    "rejects duplicate visible %s evidence",
    async (kind) => {
      html =
        kind === "root"
          ? fixture + fixture
          : kind === "review"
            ? html.replace(
                "</main>",
                '<section id="checkout-ric-review"></section></main>',
              )
            : kind === "title"
              ? html.replace(
                  "</article>",
                  '<span class="lineitem-title-text">Another title</span></article>',
                )
              : kind === "price"
                ? html.replace(
                    "</article>",
                    '<span class="a-price apex-price-to-pay-value"><span class="a-offscreen">$7.40</span></span></article>',
                  )
                : html.replace(
                    "</main>",
                    '<div id="subtotals-marketplace-table"></div></main>',
                  );
      expect(await read()).toBeUndefined();
    },
  );
  it.each([
    url.replace("p-123-1111111-2222222", "p-999-1111111-2222222"),
    url.replace("isBuyNow=1", "isBuyNow=0"),
    url + "&isBuyNow=1",
    url.replace("www.amazon.com", "foreign.example"),
  ])("rejects mismatched or unsafe expected context: %s", async (expected) => {
    expect(await read(expected)).toBeUndefined();
  });
  it("rechecks item state across capture rather than returning a mixed snapshot", async () => {
    await page.goto(url);
    await page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (...args) => {
        const result = await original(...args);
        document
          .querySelector('[name="checkout-quantity-stepper"]')!
          .setAttribute("data-steppervalue", "2");
        document.querySelector(".a-stepper-value-live")!.textContent = "2";
        return result;
      };
    });
    expect(await extractModernReviewFacts(page, url)).toBeUndefined();
  });
  it("rechecks the independently applied address across capture", async () => {
    await page.goto(url);
    await page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let calls = 0;
      crypto.subtle.digest = async (...args) => {
        const result = await original(...args);
        if (++calls === 2)
          document.querySelector(
            ".destination-data-alignment span:nth-child(2)",
          )!.textContent = "456 Wrong St";
        return result;
      };
    });
    expect(await extractModernReviewFacts(page, url)).toBeUndefined();
  });
});
