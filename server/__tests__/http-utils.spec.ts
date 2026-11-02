import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  maximumRequestBodyBytes,
  readJsonBody,
  sendCaughtError,
  sendError,
  sendJson,
} from "../http-utils";
import { HttpError } from "../room-manager";

const asRequest = (chunks: Array<string | Buffer>) =>
  Readable.from(chunks) as unknown as IncomingMessage;

interface MockResponse {
  headersSent: boolean;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

const createMockResponse = (headersSent = false): MockResponse => ({
  headersSent,
  writeHead: vi.fn<(statusCode: number, headers: Record<string, string>) => void>(),
  end: vi.fn<(payload?: string) => void>(),
});

describe("readJsonBody", () => {
  it("parses a JSON body", async () => {
    await expect(readJsonBody(asRequest(['{"playerName":"Ada"}']))).resolves.toEqual({
      playerName: "Ada",
    });
  });

  it("returns an empty object for an empty body", async () => {
    await expect(readJsonBody(asRequest([]))).resolves.toEqual({});
  });

  it("rejects invalid JSON with a 400", async () => {
    const error = await readJsonBody(asRequest(["not json"])).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(400);
  });

  it("rejects oversized bodies with a 413 before buffering them", async () => {
    const oversized = Buffer.alloc(maximumRequestBodyBytes + 1, "a");
    const error = await readJsonBody(asRequest([oversized])).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(413);
  });
});

describe("sendCaughtError", () => {
  it("preserves intentional HTTP errors without logging", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = createMockResponse();
      sendCaughtError(
        response as unknown as ServerResponse,
        new HttpError(429, "Too many streams."),
        "Request failed",
      );
      expect(response.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
      expect(response.end).toHaveBeenCalledWith('{"error":"Too many streams."}');
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each([new Error("/private/path secret-token"), "private failure", null])(
    "logs unexpected errors but sends only a generic 500",
    (error) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const response = createMockResponse();
        sendCaughtError(response as unknown as ServerResponse, error, "Request failed");
        expect(response.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        expect(response.end).toHaveBeenCalledWith('{"error":"Internal server error."}');
        expect(log).toHaveBeenCalledExactlyOnceWith("Request failed", error);
      } finally {
        log.mockRestore();
      }
    },
  );
});

describe("sendJson", () => {
  it("writes the status code and JSON payload", () => {
    const response = createMockResponse();

    sendJson(response as unknown as ServerResponse, 201, { ok: true });

    expect(response.writeHead).toHaveBeenCalledExactlyOnceWith(201, {
      "Content-Type": "application/json",
    });
    expect(response.end).toHaveBeenCalledExactlyOnceWith('{"ok":true}');
  });

  it("does not write headers again once they were sent (no ERR_HTTP_HEADERS_SENT)", () => {
    const response = createMockResponse(true);

    expect(() => sendError(response as unknown as ServerResponse, 500, "boom")).not.toThrow();
    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledExactlyOnceWith();
  });
});
