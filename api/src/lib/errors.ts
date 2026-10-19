import { HTTPException } from "hono/http-exception";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 503;

export function apiError(status: ErrorStatus, code: string, message: string, hint?: string): never {
  const body = { error: { code, message, hint, docs: `https://otinstaller.com/docs/errors#${code}` } };
  throw new HTTPException(status, { res: Response.json(body, { status }) });
}
