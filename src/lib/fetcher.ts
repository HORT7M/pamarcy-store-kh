export class FetchError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  retryAfter?: number;
  constructor(status: number, message: string, code?: string, details?: unknown, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

/** JSON fetch helper for client components. Throws FetchError with server message on failure. */
export async function api<T = unknown>(url: string, init: Omit<RequestInit, "body"> & { body?: unknown } = {}): Promise<T> {
  const { body, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const headerRetry = Number(res.headers.get("Retry-After") || 0);
    const detailRetry = Number(data?.error?.details?.retryAfter || 0);
    const retryAfter = headerRetry > 0 ? headerRetry : detailRetry > 0 ? detailRetry : undefined;
    throw new FetchError(res.status, data?.error?.message ?? `Request failed (${res.status})`, data?.error?.code, data?.error?.details, retryAfter);
  }
  return data as T;
}
