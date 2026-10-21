// Every error the API returns: {error: {code, message, hint, docs, ...}}, the shape spec/schema/error-v1.json
// publishes and ot's JSON errors share. Codes are documented at otinstaller.com/docs/errors.
import { HTTPException } from "hono/http-exception";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 503;

export const errorDocs = (code: string) => `https://otinstaller.com/docs/errors#${code}`;

/** Fields added to the error object (problems, allowed, retry_after_s, ...), and response headers. */
export type ErrorExtra = Record<string, unknown> & { headers?: Record<string, string> };

export function apiError(status: ErrorStatus, code: string, message: string, hint?: string, extra?: ErrorExtra): never {
  const { headers, ...fields } = extra ?? {};
  const body = { error: { code, message, hint, docs: errorDocs(code), ...fields } };
  throw new HTTPException(status, { res: Response.json(body, { status, headers }) });
}

/** Seconds until a fixed rate-limit window of windowMs ends. */
export function windowRetry(windowMs: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((Math.floor(now / windowMs) * windowMs + windowMs - now) / 1000));
}

/** A 429 that says when to retry: Retry-After, a RateLimit-Policy header, and retry_after_s in the body. */
export function rateLimited(code: string, message: string, hint: string | undefined, retryAfterS: number, limit: number, windowS: number): never {
  apiError(429, code, message, hint, {
    retry_after_s: retryAfterS,
    headers: { "Retry-After": String(retryAfterS), "RateLimit-Policy": `${limit};w=${windowS}` },
  });
}
