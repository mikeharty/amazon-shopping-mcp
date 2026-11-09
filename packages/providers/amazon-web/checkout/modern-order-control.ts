import type { Locator, Page } from "playwright";
import { isModernReviewUrl } from "../../../core/purchasing.js";

/** Inspect the observed native final-order form. This helper never clicks. */
export async function getModernOrderControl(
  page: Page,
  expectedReviewURL: string,
): Promise<Locator | undefined> {
  if (!isModernReviewUrl(expectedReviewURL) || !isModernReviewUrl(page.url()))
    return undefined;
  const roots = page.locator("#checkout-experience-container");
  const visibleRoots: Locator[] = [];
  for (let index = 0; index < (await roots.count()); index++)
    if (await roots.nth(index).isVisible()) visibleRoots.push(roots.nth(index));
  if (visibleRoots.length !== 1) return undefined;
  const panels = visibleRoots[0]!.locator("#checkout-pyo-button-block");
  const visiblePanels: Locator[] = [];
  for (let index = 0; index < (await panels.count()); index++)
    if (await panels.nth(index).isVisible())
      visiblePanels.push(panels.nth(index));
  if (visiblePanels.length !== 1) return undefined;
  const controls = visiblePanels[0]!.locator(
    'button, input[type="submit"], input[type="image"]',
  );
  const enabled: Locator[] = [];
  for (let index = 0; index < (await controls.count()); index++) {
    const control = controls.nth(index);
    if ((await control.isVisible()) && (await control.isEnabled()))
      enabled.push(control);
  }
  if (enabled.length !== 1) return undefined;
  const control = enabled[0]!;
  const valid = await control.evaluate((element, expectedURL) => {
    const visible = (el: Element) =>
      (el as HTMLElement).getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== "hidden";
    const normalize = (value: string | null | undefined) =>
      value?.replace(/\s+/g, " ").trim();
    const expected = new URL(expectedURL);
    const current = new URL(location.href);
    const identityKeys = [
      "pipelineType",
      "isBuyNow",
      "purchaseId",
      "checkoutSessionId",
    ];
    const reviewKeys = [
      "ref",
      "ref_",
      "referrer",
      "pipelineType",
      "isBuyNow",
      "hasWorkingJavascript",
      "purchaseId",
      "checkoutSessionId",
    ];
    if (
      current.origin !== expected.origin ||
      current.pathname !== expected.pathname ||
      current.username ||
      current.password ||
      current.hash ||
      [...current.searchParams.keys()].some(
        (key) =>
          !reviewKeys.includes(key) ||
          current.searchParams.getAll(key).length !== 1,
      ) ||
      expected.searchParams.get("pipelineType") !== "Chewbacca" ||
      expected.searchParams.get("isBuyNow") !== "1" ||
      identityKeys.some(
        (key) =>
          JSON.stringify(current.searchParams.getAll(key)) !==
          JSON.stringify(expected.searchParams.getAll(key)),
      )
    )
      return false;
    const root = element.closest("#checkout-experience-container");
    const panel = element.closest("#checkout-pyo-button-block");
    if (
      !root ||
      !panel ||
      !visible(root) ||
      !visible(panel) ||
      Array.from(
        document.querySelectorAll("#checkout-experience-container"),
      ).filter(visible).length !== 1 ||
      Array.from(root.querySelectorAll("#checkout-pyo-button-block")).filter(
        visible,
      ).length !== 1
    )
      return false;
    if (
      !(element instanceof HTMLInputElement) ||
      element.id !== "placeOrder" ||
      element.name !== "placeYourOrder1" ||
      element.type !== "submit" ||
      element.matches(":disabled") ||
      !visible(element) ||
      element.getAttribute("aria-disabled") === "true" ||
      normalize(element.value) !== "Place your order"
    )
      return false;
    if (
      element.hasAttribute("aria-label") &&
      normalize(element.getAttribute("aria-label")) !== "Place your order"
    )
      return false;
    if (
      [
        "formaction",
        "formmethod",
        "formenctype",
        "formtarget",
        "formnovalidate",
      ].some((name) => element.hasAttribute(name))
    )
      return false;
    const active = Array.from(
      panel.querySelectorAll(
        'button, input[type="submit"], input[type="image"]',
      ),
    ).filter(
      (el) =>
        visible(el) &&
        !el.matches(":disabled") &&
        el.getAttribute("aria-disabled") !== "true",
    );
    if (active.length !== 1 || active[0] !== element) return false;
    const form = element.form;
    if (
      !form ||
      element.closest("form") !== form ||
      !panel.contains(form) ||
      form.getAttribute("method")?.toLowerCase() !== "post" ||
      (form.getAttribute("target") &&
        form.getAttribute("target") !== "_self") ||
      (form.getAttribute("enctype") &&
        form.getAttribute("enctype")?.toLowerCase() !==
          "application/x-www-form-urlencoded")
    )
      return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.getAttributeNames().some((name) => /^on/i.test(name)))
        return false;
      if (node === panel) break;
    }
    const action = form.getAttribute("action");
    if (!action) return false;
    let destination: URL;
    try {
      destination = new URL(form.action);
    } catch {
      return false;
    }
    if (
      destination.origin !== "https://www.amazon.com" ||
      destination.username ||
      destination.password ||
      destination.hash ||
      destination.pathname !== `${expected.pathname}/place-order`
    )
      return false;
    const allowedKeys = [
      "pipelineType",
      "isBuyNow",
      "referrer",
      "ref_",
      "purchaseId",
      "checkoutSessionId",
    ];
    if (
      [...destination.searchParams.keys()].some(
        (key) =>
          !allowedKeys.includes(key) ||
          destination.searchParams.getAll(key).length !== 1,
      ) ||
      identityKeys.some(
        (key) =>
          JSON.stringify(destination.searchParams.getAll(key)) !==
          JSON.stringify(expected.searchParams.getAll(key)),
      )
    )
      return false;
    const required = [
      "anti-csrftoken-a2z",
      "consistencyToken",
      "hasWorkingJavascript",
    ];
    const found = new Set<string>();
    for (const field of Array.from(form.elements)) {
      if (
        !(field instanceof HTMLInputElement) ||
        !panel.contains(field) ||
        field.form !== form
      )
        return false;
      if (field.getAttributeNames().some((name) => /^on/i.test(name)))
        return false;
      if (
        field.type === "submit" &&
        field.id === "placeOrder" &&
        field.name === "placeYourOrder1" &&
        normalize(field.value) === "Place your order"
      ) {
        if (field !== element && visible(field) && !field.matches(":disabled"))
          return false;
        continue;
      }
      if (
        field.type !== "hidden" ||
        !required.includes(field.name) ||
        found.has(field.name) ||
        field.matches(":disabled") ||
        !field.value.trim() ||
        field.value.length > 100_000
      )
        return false;
      found.add(field.name);
    }
    return required.every((name) => found.has(name));
  }, expectedReviewURL);
  return valid ? control : undefined;
}
