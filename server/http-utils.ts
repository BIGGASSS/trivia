/**
 * Small HTTP helpers for the multiplayer middleware, split out so they can
 * be unit-tested (body-size cap, headers-sent guard, error mapping).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./room-manager";
import type { RequestBody } from "./room-manager";

export const maximumRequestBodyBytes = 16 * 1024;

export const readJsonBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    totalBytes += buffer.byteLength;

    if (totalBytes > maximumRequestBodyBytes) {
      throw new HttpError(413, "Request body is too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {} satisfies RequestBody;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
  } catch {
    throw new HttpError(400, "Invalid JSON request body.");
  }
};

export const sendJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
  // Once the SSE stream (or any earlier write) has sent headers we can no
  // longer send a JSON response; bail out instead of crashing the server
  // with ERR_HTTP_HEADERS_SENT.
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
};

export const sendError = (response: ServerResponse, statusCode: number, message: string) => {
  sendJson(response, statusCode, { error: message });
};

export const sendCaughtError = (
  response: ServerResponse,
  error: unknown,
  fallbackMessage: string,
) => {
  if (error instanceof HttpError) {
    sendError(response, error.statusCode, error.message);
    return;
  }

  sendError(response, 400, error instanceof Error ? error.message : fallbackMessage);
};
