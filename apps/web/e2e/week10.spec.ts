import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * Week 10 QA gate (FINAL_PROJECT_PLAN §7 and §10): the privacy acceptance
 * scenario. Database content must never leave the browser — no HTTP request,
 * websocket frame, beacon, or cross-origin call may carry table data.
 */

type Outbound = { channel: string; url: string; body: string };

declare global {
  interface Window {
    __week10Outbound?: Outbound[];
  }
}

const SENTINEL = `week10-private-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const PROBE_SQL = `CREATE TABLE private_probe (secret TEXT);
DELETE FROM private_probe;
INSERT INTO private_probe (secret) VALUES ('${SENTINEL}');
SELECT secret FROM private_probe;`;

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });
}

async function instrumentOutbound(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sink: Outbound[] = [];
    Object.defineProperty(window, "__week10Outbound", { value: sink, configurable: true });

    const text = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (value instanceof URLSearchParams) return value.toString();
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
      if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
      if (value instanceof FormData) {
        const parts: string[] = [];
        value.forEach((entry, key) => {
          parts.push(`${key}=${typeof entry === "string" ? entry : entry.name}`);
        });
        return parts.join("&");
      }
      return "";
    };
    const record = (channel: string, url: string, body: unknown): void => {
      sink.push({ channel, url, body: text(body) });
    };

    const originalFetch = window.fetch;
    window.fetch = function fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      record("fetch", url, init?.body);
      return originalFetch.call(window, input, init);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function open(
      this: XMLHttpRequest & { __week10Url?: string },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      this.__week10Url = String(url);
      return (originalOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function send(
      this: XMLHttpRequest & { __week10Url?: string },
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      record("xhr", this.__week10Url ?? "", body);
      return originalSend.call(this, body);
    };

    const originalBeacon = navigator.sendBeacon?.bind(navigator);
    if (originalBeacon) {
      navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
        record("beacon", String(url), data);
        return originalBeacon(url, data);
      };
    }

    const OriginalWebSocket = window.WebSocket;
    class RecordingWebSocket extends OriginalWebSocket {
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        record("websocket", this.url, data);
        super.send(data);
      }
    }
    window.WebSocket = RecordingWebSocket;
  });
}

function includesSentinel(value: string): boolean {
  if (value.includes(SENTINEL)) return true;
  try {
    return decodeURIComponent(value).includes(SENTINEL);
  } catch {
    return false;
  }
}

test("database content never leaves the browser (scenario 14)", async ({
  page,
  context,
  baseURL,
}) => {
  const http: Outbound[] = [];
  const frames: Outbound[] = [];
  context.on("request", (request) => {
    http.push({
      channel: "http",
      url: request.url(),
      body: request.postData() ?? "",
    });
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      frames.push({
        channel: "websocket",
        url: socket.url(),
        body: typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8"),
      });
    });
  });

  await instrumentOutbound(page);
  await ready(page);

  await page.getByTestId("sql-input").fill(PROBE_SQL);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-3")).toContainText(SENTINEL, { timeout: 15_000 });

  const persistence = (await page.getByTestId("persistence").textContent()) ?? "";
  if (persistence.includes("OPFS")) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-button").click();
    const download = await downloadPromise;
    const path = await download.path();
    if (!path) throw new Error("export download has no path");
    const exported = await readFile(path);
    expect(exported.includes(SENTINEL), "the probe value must be present in the export").toBe(true);
  } else {
    test.info().annotations.push({
      type: "export-unavailable",
      description: `Export is not available without OPFS: ${persistence}`,
    });
  }

  await page.waitForTimeout(250);
  const wrapped = await page.evaluate(() => window.__week10Outbound ?? []);
  const outbound = [...http, ...frames, ...wrapped];

  const leaks = outbound.filter(
    (entry) => includesSentinel(entry.url) || includesSentinel(entry.body),
  );
  expect(leaks, `database content was sent over the network: ${JSON.stringify(leaks)}`).toEqual([]);

  const appUrl = new URL(baseURL ?? page.url());
  const foreign = outbound.filter((entry) => {
    if (entry.url.startsWith("blob:") || entry.url.startsWith("data:")) return false;
    try {
      return new URL(entry.url).host !== appUrl.host;
    } catch {
      return false;
    }
  });
  expect(foreign, `requests left the app origin: ${JSON.stringify(foreign)}`).toEqual([]);
});
