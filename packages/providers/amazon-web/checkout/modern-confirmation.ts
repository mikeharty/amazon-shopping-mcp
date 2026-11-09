import type { Page } from "playwright";

export type ModernConfirmation = {
  profile: "modern_one_time_confirmation";
  orderId: string;
  heading: string;
  identitySources: ("native_order_detail_link" | "explicit_order_number")[];
};

/** Synthetic contract coverage only until a matching live confirmation is observed. Never clicks or navigates. */
export async function readModernConfirmation(
  page: Page,
  expectedReviewURL: string,
  priorOrderIDs: ReadonlySet<string>,
): Promise<ModernConfirmation | undefined> {
  let expected: URL;
  try {
    expected = new URL(expectedReviewURL);
  } catch {
    return undefined;
  }
  const purchaseId = expected.pathname.match(
    /^\/checkout\/p\/p-(\d{3}-\d{7}-\d{7})\/spc$/,
  )?.[1];
  const keys = [
    "pipelineType",
    "isBuyNow",
    "hasWorkingJavascript",
    "purchaseId",
    "checkoutSessionId",
    "ref",
    "ref_",
    "referrer",
  ];
  if (
    expected.origin !== "https://www.amazon.com" ||
    expected.username ||
    expected.password ||
    expected.hash ||
    !purchaseId ||
    expected.searchParams.get("pipelineType") !== "Chewbacca" ||
    expected.searchParams.get("isBuyNow") !== "1" ||
    [...expected.searchParams.keys()].some(
      (key) =>
        !keys.includes(key) || expected.searchParams.getAll(key).length !== 1,
    ) ||
    (expected.searchParams.has("purchaseId") &&
      expected.searchParams.get("purchaseId") !== purchaseId)
  )
    return undefined;
  const observed = await page.evaluate(
    ({ purchaseId, expectedSession, keys }) => {
      const current = new URL(location.href);
      if (
        current.origin !== "https://www.amazon.com" ||
        current.username ||
        current.password ||
        current.hash ||
        [...current.searchParams.keys()].some(
          (key) =>
            !keys.includes(key) ||
            current.searchParams.getAll(key).length !== 1,
        ) ||
        (current.searchParams.has("isBuyNow") &&
          current.searchParams.get("isBuyNow") !== "1") ||
        (current.searchParams.has("pipelineType") &&
          current.searchParams.get("pipelineType") !== "Chewbacca") ||
        (current.searchParams.has("purchaseId") &&
          current.searchParams.get("purchaseId") !== purchaseId) ||
        (current.searchParams.has("checkoutSessionId") &&
          current.searchParams.get("checkoutSessionId") !== expectedSession)
      )
        return undefined;
      const modern = current.pathname.match(
        /^\/checkout\/p\/p-(\d{3}-\d{7}-\d{7})\/(?:thankyou|thank-you|spc\/place-order)$/,
      );
      const legacy =
        current.pathname === "/gp/buy/thankyou/handlers/display.html" &&
        current.searchParams.get("purchaseId") === purchaseId;
      if (!(modern?.[1] === purchaseId || legacy)) return undefined;
      const visible = (el: Element) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          if (node.matches('template,[hidden],[aria-hidden="true"]'))
            return false;
          const style = getComputedStyle(node);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse"
          )
            return false;
        }
        return (el as HTMLElement).getClientRects().length > 0;
      };
      if (
        Array.from(
          document.querySelectorAll(
            'form[name="signIn"],form#ap_signin_form,form#checkpointForm,form[action*="/ap/signin"],form[action*="/checkpoint/validate"],input[type="password"],input[name="email"],input[name="otpCode"],input[name="verificationCode"],input[name="cvv"],input[autocomplete="cc-csc"],input[name="guess"],#captchacharacters',
          ),
        ).some(visible)
      )
        return undefined;
      const rendered = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        if (
          !(node instanceof HTMLElement) ||
          !visible(node) ||
          node.matches("script,style,input,select,textarea,button")
        )
          return "";
        return Array.from(node.childNodes).map(rendered).join(" ");
      };
      const text = (node: Element) =>
        rendered(node).replace(/\s+/g, " ").trim();
      if (
        Array.from(
          document.querySelectorAll(
            'h1,h2,h3,h4,h5,h6,[role="alert"],#payment-challenge,[data-testid="payment-challenge"]',
          ),
        )
          .filter(visible)
          .some((el) =>
            /\b(?:verify (?:your )?payment|payment (?:required|failed|declined)|sign in to continue|enter (?:the )?verification code|i am human)\b/i.test(
              text(el),
            ),
          )
      )
        return undefined;
      const specific = Array.from(
        document.querySelectorAll(
          '#thank-you,#order-confirmation,[data-testid="order-confirmation"]',
        ),
      ).filter(visible);
      const candidates = specific.length
        ? specific
        : Array.from(
            document.querySelectorAll("#checkout-experience-container"),
          ).filter(visible);
      const roots = candidates.length
        ? candidates
        : Array.from(document.querySelectorAll('main,[role="main"]')).filter(
            visible,
          );
      if (roots.length !== 1) return undefined;
      const root = roots[0]!;
      const headings = Array.from(
        root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'),
      )
        .filter(visible)
        .map(text)
        .filter((value) =>
          /^(?:Order placed,? thanks!?|Thank you,? your order has been placed[.!]?|Thank you for your order[.!]?)$/i.test(
            value,
          ),
        );
      if (headings.length !== 1) return undefined;
      const identities = new Map<
        string,
        Set<"native_order_detail_link" | "explicit_order_number">
      >();
      const record = (
        id: string,
        source: "native_order_detail_link" | "explicit_order_number",
      ) => {
        const sources = identities.get(id) ?? new Set();
        sources.add(source);
        identities.set(id, sources);
      };
      for (const anchor of Array.from(
        root.querySelectorAll<HTMLAnchorElement>("a[href]"),
      ).filter(visible)) {
        const url = new URL(anchor.href);
        if (
          !/^\/(?:gp\/your-account|your-orders)\/order-details(?:\/ref=[A-Za-z0-9_-]+)?\/?$/.test(
            url.pathname,
          )
        )
          continue;
        const ids = [
          ...url.searchParams.getAll("orderID"),
          ...url.searchParams.getAll("orderId"),
        ];
        if (
          url.origin !== current.origin ||
          url.username ||
          url.password ||
          url.hash ||
          ids.length !== 1 ||
          !/^\d{3}-\d{7}-\d{7}$/.test(ids[0]!) ||
          [...url.searchParams.keys()].some(
            (key) =>
              !["orderID", "orderId", "ref", "ref_"].includes(key) ||
              url.searchParams.getAll(key).length !== 1,
          )
        )
          return undefined;
        record(ids[0]!, "native_order_detail_link");
      }
      // Read explicit labeled order numbers only; plain IDs elsewhere are not evidence.
      for (const node of Array.from(
        root.querySelectorAll("span,p,div,li"),
      ).filter(visible)) {
        const value = text(node);
        const match = value.match(/^Order\s*#\s*(\d{3}-\d{7}-\d{7})$/i);
        if (match) record(match[1]!, "explicit_order_number");
        else if (/^Order\s*#$/i.test(value)) {
          const next = node.parentElement?.nextElementSibling;
          const id = next && visible(next) ? text(next) : "";
          if (/^\d{3}-\d{7}-\d{7}$/.test(id))
            record(id, "explicit_order_number");
        }
      }
      if (identities.size !== 1) return undefined;
      const [orderId, sources] = [...identities][0]!;
      return {
        profile: "modern_one_time_confirmation" as const,
        orderId,
        heading: headings[0]!,
        identitySources: [...sources],
      };
    },
    {
      purchaseId,
      expectedSession: expected.searchParams.get("checkoutSessionId"),
      keys,
    },
  );
  return observed && !priorOrderIDs.has(observed.orderId)
    ? observed
    : undefined;
}
