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
import { readModernConfirmation } from "../packages/providers/amazon-web/checkout/modern-confirmation.js";
const purchase = "123-1111111-2222222",
  order = "123-3333333-4444444";
const review = `https://www.amazon.com/checkout/p/p-${purchase}/spc?pipelineType=Chewbacca&isBuyNow=1`;
const confirmation = review.replace("/spc?", "/thankyou?");
const anchor = `<a href="/your-orders/order-details?orderID=${order}&amp;ref=fixture">View order details</a>`;
const fixture = `<main id="checkout-experience-container"><section id="order-confirmation"><h1>Order placed, thanks!</h1>${anchor}</section></main>`;
describe("Modern confirmation synthetic contract (not live verification)", () => {
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    html: string,
    requests: number;
  beforeAll(async () => {
    browser = await chromium.launch();
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
  async function read(
    url = confirmation,
    expected = review,
    prior = new Set<string>(),
  ) {
    await page.goto(url);
    const count = requests;
    const result = await readModernConfirmation(page, expected, prior);
    expect(requests).toBe(count);
    return result;
  }
  it("observes explicit positive heading and a new native detail-link identity without navigating", async () => {
    expect(await read()).toEqual({
      profile: "modern_one_time_confirmation",
      orderId: order,
      heading: "Order placed, thanks!",
      identitySources: ["native_order_detail_link"],
    });
    expect(requests).toBe(1);
  });
  it.each(["h4", "h5", "h6"])(
    "recognizes a native %s success heading",
    async (tag) => {
      html = fixture.replaceAll("h1", tag);
      expect(await read()).toBeDefined();
    },
  );
  it.each(["thank-you", "spc/place-order"])(
    "supports a bound %s result route",
    async (path) => {
      expect(
        await read(confirmation.replace("/thankyou?", `/${path}?`)),
      ).toBeDefined();
    },
  );
  it("supports legacy thank-you only with explicitly matching purchase identity", async () => {
    const legacy = `https://www.amazon.com/gp/buy/thankyou/handlers/display.html?pipelineType=Chewbacca&isBuyNow=1&purchaseId=${purchase}`;
    expect(await read(legacy)).toBeDefined();
    expect(
      await read(legacy.replace(`&purchaseId=${purchase}`, "")),
    ).toBeUndefined();
  });
  it.each([
    confirmation.split("?")[0],
    confirmation.replace("pipelineType=Chewbacca&", ""),
    confirmation.replace("&isBuyNow=1", ""),
    `https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=${purchase}`,
  ])(
    "accepts omitted result presentation flags only with explicit purchase binding %s",
    async (url) => {
      expect(await read(url)).toMatchObject({ orderId: order });
    },
  );
  it("does not accept omitted result flags as a substitute for purchase identity", async () => {
    expect(
      await read(
        "https://www.amazon.com/gp/buy/thankyou/handlers/display.html",
      ),
    ).toBeUndefined();
    expect(
      await read(
        confirmation.split("?")[0]!.replace(purchase, "999-1111111-2222222"),
      ),
    ).toBeUndefined();
  });
  it.each([
    confirmation.replace("www.amazon.com", "foreign.example"),
    confirmation.replace("https://", "http://"),
    confirmation + "#fragment",
    confirmation.replace(purchase, "999-1111111-2222222"),
    confirmation + "&purchaseId=999-1111111-2222222",
    confirmation + "&isBuyNow=0",
    confirmation.replace("isBuyNow=1", "isBuyNow=0"),
    confirmation.replace("pipelineType=Chewbacca", "pipelineType=SNS"),
    confirmation.replace("/thankyou?", "/spc?"),
    confirmation + "&orderID=" + order,
    confirmation + "&checkoutSessionId=other",
  ])("rejects unsafe/contradictory result context %s", async (url) => {
    expect(await read(url)).toBeUndefined();
  });
  it.each([
    review.replace("www.amazon.com", "foreign.example"),
    review + "&isBuyNow=1",
    review.replace("isBuyNow=1", "isBuyNow=0"),
    review.replace("/spc?", "/address?"),
  ])("rejects invalid expected review %s", async (expected) => {
    expect(await read(confirmation, expected)).toBeUndefined();
  });
  it("rejects a baseline order identity", async () => {
    expect(await read(confirmation, review, new Set([order]))).toBeUndefined();
  });
  it.each([
    "Review your order",
    "Your order is processing",
    "Payment required",
    "Thank you",
  ])("does not infer success from heading %s", async (title) => {
    html = fixture.replace("Order placed, thanks!", title);
    expect(await read()).toBeUndefined();
  });
  it.each([
    "Thank you, your order has been placed",
    "Thank you for your order",
  ])("accepts explicit order placement heading %s", async (title) => {
    html = fixture.replace("Order placed, thanks!", title);
    expect((await read())!.heading).toBe(title);
  });
  it("requires one positive visible heading", async () => {
    html = fixture.replace("<h1>", "<h1 hidden>");
    expect(await read()).toBeUndefined();
    html = fixture.replace("</h1>", "</h1><h2>Thank you for your order</h2>");
    expect(await read()).toBeUndefined();
  });
  it.each([
    "#thank-you",
    "#order-confirmation",
    "data-testid",
    "sole-main",
    "experience",
  ])("supports recognized root %s", async (kind) => {
    html =
      kind === "data-testid"
        ? fixture.replace(
            'id="order-confirmation"',
            'data-testid="order-confirmation"',
          )
        : kind === "sole-main"
          ? `<main><h1>Order placed, thanks!</h1>${anchor}</main>`
          : kind === "experience"
            ? `<div id="checkout-experience-container"><h1>Order placed, thanks!</h1>${anchor}</div>`
            : fixture.replace(
                'id="order-confirmation"',
                `id="${kind.slice(1)}"`,
              );
    expect(await read()).toBeDefined();
  });
  it("rejects duplicate confirmation roots and multiple main fallbacks", async () => {
    html = fixture + fixture;
    expect(await read()).toBeUndefined();
    html = `<main><h1>Order placed, thanks!</h1>${anchor}</main><main>Other</main>`;
    expect(await read()).toBeUndefined();
  });
  it("accepts a labeled order number and records dual sources without duplicating identity", async () => {
    html = fixture.replace(anchor, `<div>Order # ${order}</div>`);
    expect((await read())!.identitySources).toEqual(["explicit_order_number"]);
    html = fixture.replace(
      anchor,
      anchor + `<div><span>Order #</span></div><div>${order}</div>`,
    );
    expect((await read())!.identitySources).toEqual([
      "native_order_detail_link",
      "explicit_order_number",
    ]);
  });
  it("ignores plain IDs and identities outside the confirmed root", async () => {
    html =
      fixture.replace(anchor, `<p>${order}</p>`) +
      `<div>Order # ${order}</div>`;
    expect(await read()).toBeUndefined();
  });
  it("rejects multiple identities even with one baseline and one new identity", async () => {
    html = fixture.replace(
      anchor,
      anchor + "<p>Order # 999-1111111-2222222</p>",
    );
    expect(
      await read(confirmation, review, new Set(["999-1111111-2222222"])),
    ).toBeUndefined();
  });
  it.each([
    anchor.replace(
      'href="/your-orders',
      'href="https://foreign.example/your-orders',
    ),
    anchor.replace("&amp;ref=fixture", "&amp;orderID=999-1111111-2222222"),
    anchor.replace("&amp;ref=fixture", "&amp;orderId=" + order),
    anchor.replace("order-details?", "order-details#bad?"),
  ])("rejects unsafe detail identity links %#", async (link) => {
    html = fixture.replace(anchor, link);
    expect(await read()).toBeUndefined();
  });
  it("allows the native optional ref path", async () => {
    html = fixture.replace(
      "/your-orders/order-details?",
      "/gp/your-account/order-details/ref=fixture?",
    );
    expect(await read()).toBeDefined();
  });
  it.each([
    "<h2>Verify your payment</h2>",
    '<div role="alert">Payment declined</div>',
    '<input type="password">',
    '<form id="checkpointForm"><input name="continueCheck" type="checkbox">I am human</form>',
    '<input name="otpCode">',
    '<input name="cvv">',
    '<input autocomplete="cc-csc">',
    '<input id="captchacharacters">',
  ])(
    "rejects visible authentication/payment challenge %#",
    async (challenge) => {
      html += challenge;
      expect(await read()).toBeUndefined();
    },
  );
  it("ignores hidden unrelated identities and never exposes private controls", async () => {
    html = fixture.replace(
      anchor,
      anchor +
        '<div hidden>Order # 999-1111111-2222222<input value="PRIVATE_TOKEN"></div>',
    );
    expect(JSON.stringify(await read())).not.toMatch(/PRIVATE_|999-/);
  });
});
