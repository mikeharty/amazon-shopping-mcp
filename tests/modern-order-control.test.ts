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
import { getModernOrderControl } from "../packages/providers/amazon-web/checkout/modern-order-control.js";

const reviewURL =
  "https://www.amazon.com/checkout/p/p-123-1111111-2222222/spc?pipelineType=Chewbacca&isBuyNow=1&hasWorkingJavascript=1";
const action =
  "/checkout/p/p-123-1111111-2222222/spc/place-order?pipelineType=Chewbacca&amp;isBuyNow=1&amp;referrer=spc&amp;ref_=chk_spc_chw_placeOrder";
const input =
  '<input id="placeOrder" name="placeYourOrder1" type="submit" value="Place your order">';
function profile() {
  return `<main id="checkout-experience-container"><section id="checkout-pyo-button-block"><form method="POST" action="${action}"><input type="hidden" name="anti-csrftoken-a2z" value="PRIVATE_CSRF"><input type="hidden" name="consistencyToken" value="PRIVATE_CONSISTENCY"><input type="hidden" name="hasWorkingJavascript" value="1">${input}${input.replace('type="submit"', 'type="submit" disabled')}${input.replace('type="submit"', 'type="submit" disabled')}</form></section></main>`;
}
describe("Observed modern native final-order control guard", () => {
  let browser: Browser, context: BrowserContext, page: Page;
  let html: string;
  let requests: number;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({ offline: true });
    page = await context.newPage();
    html = profile();
    requests = 0;
    await page.route("**/*", (route) => {
      requests++;
      return route.fulfill({ contentType: "text/html", body: html });
    });
  });
  afterEach(async () => {
    await context.close();
  });
  async function read(expected = reviewURL) {
    await page.goto(reviewURL);
    const initial = requests;
    const control = await getModernOrderControl(page, expected);
    expect(requests).toBe(initial);
    return control;
  }
  it("returns only the enabled native submit among three copies, without clicking or exposing tokens", async () => {
    const control = await read();
    expect(control).toBeDefined();
    expect(await control!.isEnabled()).toBe(true);
    expect(await control!.inputValue()).toBe("Place your order");
    expect(requests).toBe(1);
  });
  it("ignores hidden copies while retaining one visible enabled native control", async () => {
    html = html.replace(
      'type="submit" disabled',
      'type="submit" style="display:none"',
    );
    expect(await read()).toBeDefined();
  });
  it.each([
    [
      "foreign action",
      'action="/checkout',
      'action="https://foreign.example/checkout',
    ],
    [
      "credentials",
      'action="/checkout',
      'action="https://user:PRIVATE_SECRET@www.amazon.com/checkout',
    ],
    [
      "wrong purchase",
      "/p-123-1111111-2222222/spc/place-order",
      "/p-999-1111111-2222222/spc/place-order",
    ],
    ["wrong endpoint", "/spc/place-order", "/address/shiptodestination"],
    ["GET method", 'method="POST"', 'method="GET"'],
    ["missing method", 'method="POST"', ""],
    ["wrong label", 'value="Place your order"', 'value="Subscribe now"'],
    ["wrong input name", 'name="placeYourOrder1"', 'name="setDefaultAddress"'],
    ["wrong input id", 'id="placeOrder"', 'id="continue"'],
    [
      "contradictory aria",
      'type="submit" value=',
      'aria-label="Edit address" type="submit" value=',
    ],
    ["pipeline", "pipelineType=Chewbacca", "pipelineType=Other"],
    ["mode", "isBuyNow=1", "isBuyNow=0"],
    ["unknown query", "referrer=spc", "unknown=PRIVATE_VALUE"],
    ["duplicate routing", "isBuyNow=1", "isBuyNow=1&amp;isBuyNow=0"],
    ["fragment", "referrer=spc", "referrer=spc#submit"],
    [
      "inline control",
      'type="submit" value=',
      'onclick="return false" type="submit" value=',
    ],
    ["inline form", 'method="POST"', 'onsubmit="return false" method="POST"'],
    [
      "inline ancestor",
      'id="checkout-pyo-button-block"',
      'onpointerdown="return false" id="checkout-pyo-button-block"',
    ],
    [
      "input action override",
      'type="submit" value=',
      'formaction="/checkout/spc/place-order" type="submit" value=',
    ],
    [
      "unknown hidden field",
      "</form>",
      '<input type="hidden" name="defaultAddress" value="1"></form>',
    ],
    [
      "duplicate token",
      "</form>",
      '<input type="hidden" name="consistencyToken" value="PRIVATE_DUPLICATE"></form>',
    ],
    ["empty token", 'value="PRIVATE_CSRF"', 'value=""'],
    [
      "missing token",
      '<input type="hidden" name="consistencyToken" value="PRIVATE_CONSISTENCY">',
      "",
    ],
    [
      "disabled token",
      'name="consistencyToken"',
      'disabled name="consistencyToken"',
    ],
  ])("rejects %s without dispatch", async (_, from, to) => {
    html = html.replace(from, to);
    expect(await read()).toBeUndefined();
  });
  it("rejects multiple visible enabled controls even when disabled duplicates remain", async () => {
    html = html.replace("</form>", `${input}</form>`);
    expect(await read()).toBeUndefined();
  });
  it("checks the native resolved form destination rather than ignoring a foreign document base URL", async () => {
    html = '<base href="https://foreign.example/">' + html;
    expect(await read()).toBeUndefined();
  });
  it("rejects an inline handler on a wrapper between the native input and its form", async () => {
    html = html.replace(
      input,
      `<span onkeydown="return false">${input}</span>`,
    );
    expect(await read()).toBeUndefined();
  });
  it.each(["root", "panel"])("rejects duplicate visible %s", async (kind) => {
    html =
      kind === "root"
        ? html + html
        : html.replace(
            "</main>",
            '<section id="checkout-pyo-button-block"></section></main>',
          );
    expect(await read()).toBeUndefined();
  });
  it.each([
    reviewURL.replace("p-123-1111111-2222222", "p-999-1111111-2222222"),
    reviewURL.replace("isBuyNow=1", "isBuyNow=0"),
    reviewURL.replace("Chewbacca", "Other"),
    reviewURL + "&isBuyNow=1",
    reviewURL.replace("www.amazon.com", "foreign.example"),
  ])("rejects changed/unsafe expected context: %s", async (expected) => {
    expect(await read(expected)).toBeUndefined();
  });
  it("binds optional purchase/session identities across expected URL, current page and form", async () => {
    const identities =
      "&purchaseId=PRIVATE_PURCHASE_BINDING&checkoutSessionId=PRIVATE_SESSION_BINDING";
    html = html.replace(
      "referrer=spc",
      "purchaseId=PRIVATE_PURCHASE_BINDING&amp;checkoutSessionId=PRIVATE_SESSION_BINDING&amp;referrer=spc",
    );
    await page.goto(reviewURL + identities);
    expect(
      await getModernOrderControl(page, reviewURL + identities),
    ).toBeDefined();
    expect(
      await getModernOrderControl(
        page,
        reviewURL +
          identities.replace("PRIVATE_SESSION_BINDING", "OTHER_SESSION"),
      ),
    ).toBeUndefined();
    await page
      .locator("form")
      .evaluate((form) =>
        form.setAttribute(
          "action",
          form
            .getAttribute("action")!
            .replace("PRIVATE_SESSION_BINDING", "OTHER_SESSION"),
        ),
      );
    expect(
      await getModernOrderControl(page, reviewURL + identities),
    ).toBeUndefined();
    expect(requests).toBe(1);
  });
});
