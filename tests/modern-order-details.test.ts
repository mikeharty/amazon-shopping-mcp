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
import {
  deriveModernReceiptQuantity,
  readModernOrderDetails,
} from "../packages/providers/amazon-web/checkout/modern-order-details.js";
const id = "123-1111111-2222222";
const url = `https://www.amazon.com/your-orders/order-details?orderID=${id}&ref=fixture`;
describe("Modern single-item observed receipt", () => {
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    fixture: string,
    html: string,
    requests: number;
  beforeAll(async () => {
    browser = await chromium.launch();
    fixture = await readFile(
      new URL("fixtures/modern-order-details.html", import.meta.url),
      "utf8",
    );
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    html = fixture;
    requests = 0;
    context = await browser.newContext({ offline: true });
    page = await context.newPage();
    await page.route("**/*", (route) => {
      requests++;
      return route.fulfill({ contentType: "text/html", body: html });
    });
  });
  afterEach(async () => {
    await context.close();
  });
  async function read(target = url, expected = id) {
    await page.goto(target);
    const count = requests;
    const receipt = await readModernOrderDetails(page, expected);
    expect(requests).toBe(count);
    return receipt;
  }
  it("observes exact identity and every total without copying omitted purchase fields", async () => {
    const receipt = await read();
    expect(receipt).toMatchObject({
      profile: "modern_single_item_receipt",
      orderId: id,
      line: {
        asin: "B0FIXTURE1",
        merchant: { kind: "marketplace", sellerId: "A1FIXTURE" },
        unitPrice: { currency: "USD", minorUnits: 740 },
      },
    });
    expect(receipt!.monetaryRows).toHaveLength(5);
    expect(receipt!.line.quantity).toBeUndefined();
    expect(receipt!.line.condition).toBeUndefined();
    expect(receipt!.line.deliveryFrequency).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toMatch(
      /PRIVATE_|B0OTHER001|purchaseMode|funding|verified/,
    );
    expect(deriveModernReceiptQuantity(receipt!)).toEqual({
      quantity: 1,
      evidence: {
        kind: "item_subtotal_divided_by_unit_price",
        subtotal: { currency: "USD", minorUnits: 740 },
        unitPrice: { currency: "USD", minorUnits: 740 },
      },
    });
  });
  it.each([
    url.replace("www.amazon.com", "foreign.example"),
    url.replace("https://", "http://"),
    url + "&orderID=" + id,
    url + "&orderId=" + id,
    url + "&unknown=1",
    url + "#fragment",
    url.replace("/your-orders/order-details", "/gp/your-account/order-history"),
    url.replace(id, "999-1111111-2222222"),
  ])("rejects unsafe or mismatching detail URL %s", async (target) => {
    expect(await read(target)).toBeUndefined();
  });
  it("rejects a new requested ID when the page still displays the prior order", async () => {
    expect(
      await read(url.replace(id, "999-1111111-2222222"), "999-1111111-2222222"),
    ).toBeUndefined();
  });
  it.each([
    ["missing header", "Order #", "Reference #"],
    [
      "mismatched header",
      `<span>${id}</span>`,
      "<span>999-1111111-2222222</span>",
    ],
    [
      "hidden header",
      'data-component="orderId"',
      'data-component="orderId" hidden',
    ],
    ["foreign product", 'href="/dp/', 'href="https://foreign.example/dp/'],
    [
      "foreign seller",
      'href="/gp/aag/main?',
      'href="https://foreign.example/gp/aag/main?',
    ],
    [
      "duplicate seller parameter",
      "seller=A1FIXTURE",
      "seller=A1FIXTURE&amp;seller=A2FIXTURE",
    ],
    [
      "contradictory merchant text",
      "Sold by: <a",
      "Sold by: Amazon.com and <a",
    ],
    ["wrong seller route", 'href="/gp/aag/main?', 'href="/account?'],
    [
      "invalid price",
      '<span class="a-offscreen">$7.40</span>',
      '<span class="a-offscreen">unknown</span>',
    ],
    [
      "substitution",
      'data-component="substitutionDetails"></div>',
      'data-component="substitutionDetails">Substitute item</div>',
    ],
    [
      "associated service",
      'data-component="associatedOrdersForService"></div>',
      'data-component="associatedOrdersForService">Service order</div>',
    ],
    [
      "cancellation",
      'data-component="cancelled"></div>',
      'data-component="cancelled">Cancelled item</div>',
    ],
    [
      "replacement",
      'data-component="shipmentStatus">Delivered',
      'data-component="shipmentStatus">Replacement delivered',
    ],
  ])("rejects %s", async (_, from, to) => {
    html = html.replace(from, to);
    expect(await read()).toBeUndefined();
  });
  it("rejects multiple merchant links and duplicate prices", async () => {
    html = html.replace(
      "Fixture Seller</a>",
      'Fixture Seller</a><a href="/gp/aag/main?seller=A2FIXTURE">Other Seller</a>',
    );
    expect(await read()).toBeUndefined();
    html = fixture.replace(
      '<span class="a-offscreen">$7.40</span>',
      '<span class="a-offscreen">$7.40</span><span class="a-offscreen">$7.40</span>',
    );
    expect(await read()).toBeUndefined();
  });
  it.each(["same_root", "second_root"])(
    "rejects multiple purchased lines across %s",
    async (kind) => {
      const body = fixture.match(
        /<div data-component="itemTitle">[\s\S]*?<\/a><\/div><\/div>/,
      )![0];
      html = html.replace(
        '<div data-component="cancelled">',
        (kind === "same_root" ? "" : '<div data-component="purchasedItems">') +
          '<div class="a-fixed-left-grid">' +
          body +
          "</div>" +
          (kind === "same_root" ? "" : "</div>") +
          '<div data-component="cancelled">',
      );
      if (kind === "same_root")
        html = fixture.replace(
          '<div data-component="itemCondition">',
          body + '<div data-component="itemCondition">',
        );
      expect(await read()).toBeUndefined();
    },
  );
  it("also accepts the existing native seller profile route", async () => {
    html = html.replace("/gp/aag/main?seller=", "/sp?seller=");
    expect((await read())!.line.merchant).toEqual({
      kind: "marketplace",
      sellerId: "A1FIXTURE",
    });
  });
  it("records an Amazon retail marker without inventing a marketplace seller ID", async () => {
    html = html.replace(
      '<a href="/gp/aag/main?seller=A1FIXTURE">Fixture Seller</a>',
      "Amazon.com",
    );
    expect((await read())!.line.merchant).toEqual({
      kind: "amazon_retail",
      label: "Amazon.com",
    });
  });
  it("preserves unknown monetary rows and explicit gift credit without fabricating funding", async () => {
    html = html.replace(
      '</div>\n <div data-component="shipments">',
      '<div class="od-line-item-row"><span class="od-line-item-row-label">Gift Card:</span><span class="od-line-item-row-content">-$8.23</span></div><div class="od-line-item-row"><span class="od-line-item-row-label">Unrecognized adjustment:</span><span class="od-line-item-row-content">pending</span></div></div>\n <div data-component="shipments">',
    );
    const receipt = await read();
    expect(receipt!.monetaryRows).toContainEqual({
      label: "Gift Card:",
      value: "-$8.23",
      amount: { currency: "USD", minorUnits: -823 },
    });
    expect(receipt!.monetaryRows).toContainEqual({
      label: "Unrecognized adjustment:",
      value: "pending",
    });
    expect(deriveModernReceiptQuantity(receipt!)).toBeUndefined();
    expect(receipt).not.toHaveProperty("funding");
  });
  it("retains explicit condition/frequency and agrees with a mathematically established quantity", async () => {
    html = html
      .replace(
        'data-component="itemCondition"></div>',
        'data-component="itemCondition">Condition: Used - Good</div>',
      )
      .replace(
        'data-component="deliveryFrequency"></div>',
        'data-component="deliveryFrequency">Every month</div>',
      )
      .replace(
        '<span class="a-size-small"></span>',
        '<span class="a-size-small">Quantity: 2</span>',
      )
      .replace(
        'class="od-line-item-row-content">$7.40',
        'class="od-line-item-row-content">$14.80',
      );
    const receipt = await read();
    expect(receipt!.line).toMatchObject({
      condition: "Condition: Used - Good",
      deliveryFrequency: "Every month",
      quantity: 2,
    });
    expect(deriveModernReceiptQuantity(receipt!)).toMatchObject({
      quantity: 2,
      evidence: { explicitQuantity: 2 },
    });
  });
  it.each(["$7.41", "$0.00", "$81.40"])(
    "does not derive quantity from nondivisible, zero, or excessive subtotal %s",
    async (value) => {
      html = html.replace(
        'class="od-line-item-row-content">$7.40',
        `class="od-line-item-row-content">${value}`,
      );
      const receipt = await read();
      expect(deriveModernReceiptQuantity(receipt!)).toBeUndefined();
    },
  );
  it("rejects a quantity derivation contradicting explicit quantity", async () => {
    html = html.replace(
      '<span class="a-size-small"></span>',
      '<span class="a-size-small">Quantity: 2</span>',
    );
    expect(deriveModernReceiptQuantity((await read())!)).toBeUndefined();
  });
});
