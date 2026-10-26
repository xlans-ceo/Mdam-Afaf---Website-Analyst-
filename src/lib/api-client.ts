const VISITOR_ID_STORAGE_KEY = 'madam_afaf_visitor_id';
const VALID_VISITOR_ID_REGEX = /^[a-zA-Z0-9_-]{4,64}$/;

let inMemoryVisitorId: string | null = null;

function generateRandomVisitorId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `v_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  const randomPart =
    Math.random().toString(36).slice(2, 12) +
    Math.random().toString(36).slice(2, 12) +
    Date.now().toString(36);
  return `v_${randomPart.slice(0, 32)}`;
}

/**
 * Returns a stable client visitor identifier stored in localStorage (with in-memory fallback).
 * In cross-origin preview iframes where browsers block Set-Cookie, sending this via
 * X-Visitor-Id ensures POST /api/scans and GET /api/scans/:id share the same visitor identity.
 */
export function getClientVisitorId(): string {
  if (inMemoryVisitorId && VALID_VISITOR_ID_REGEX.test(inMemoryVisitorId)) {
    return inMemoryVisitorId;
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const existing = localStorage.getItem(VISITOR_ID_STORAGE_KEY);
      if (existing && VALID_VISITOR_ID_REGEX.test(existing)) {
        inMemoryVisitorId = existing;
        return existing;
      }
      const created = generateRandomVisitorId();
      localStorage.setItem(VISITOR_ID_STORAGE_KEY, created);
      inMemoryVisitorId = created;
      return created;
    }
  } catch {
    // localStorage may be blocked in strict privacy modes; use in-memory ID for the session
  }

  if (!inMemoryVisitorId) {
    inMemoryVisitorId = generateRandomVisitorId();
  }
  return inMemoryVisitorId;
}

export function syncClientVisitorIdFromHeader(headerValue: string | null): void {
  if (!headerValue || !VALID_VISITOR_ID_REGEX.test(headerValue)) return;
  inMemoryVisitorId = headerValue;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(VISITOR_ID_STORAGE_KEY, headerValue);
    }
  } catch {
    // ignore storage errors
  }
}

/**
 * Wrapper around fetch for `/api/*` endpoints that attaches `X-Visitor-Id`
 * without mutating `window.fetch` (which is a getter-only property in AI Studio preview).
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : undefined)
  );
  if (!headers.has('X-Visitor-Id')) {
    headers.set('X-Visitor-Id', getClientVisitorId());
  }

  const response = await fetch(input, {
    ...init,
    headers,
    credentials: init?.credentials ?? 'same-origin'
  });

  const serverVisitorId = response.headers.get('X-Visitor-Id');
  if (serverVisitorId) {
    syncClientVisitorIdFromHeader(serverVisitorId);
  }

  return response;
}
