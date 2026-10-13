// ─── R2 Worker Helper Functions ─────────────────────────────────────────────
// Extracted for testability. All functions are pure (no side effects).

export interface Env {
  BUCKET: R2Bucket
  PUBLIC_URL: string
  ALLOWED_ORIGINS?: string // comma-separated origins (no wildcard)
  API_SECRET?: string // Cloudflare Workers Secret for Bearer auth
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
export const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
])

/**
 * Build CORS headers based on request origin and allowed origins.
 * Fail-closed: if ALLOWED_ORIGINS is not set, no origin is allowed.
 * Wildcard '*' is NOT supported — each origin must be explicitly listed.
 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? ''
  const allowed = env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()) ?? []
  const allowOrigin = origin && allowed.includes(origin) ? origin : ''

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

/**
 * Build a JSON response with CORS headers.
 */
export function jsonResponse(body: object, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

/**
 * Map content type to file extension.
 */
export function getExtension(contentType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  }
  return map[contentType] ?? 'bin'
}

/**
 * Check Bearer token authentication.
 * - If API_SECRET is not set, authentication is skipped (returns null).
 * - If API_SECRET is set, a valid Bearer token must match.
 * - Returns null on success/skip, or a 403 Response on failure.
 */
export function checkAuth(request: Request, env: Env, cors: Record<string, string>): Response | null {
  if (!env.API_SECRET) return null // D-05: skip if not configured

  const authHeader = request.headers.get('Authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token || token !== env.API_SECRET) {
    return jsonResponse(
      { success: false, error: 'Unauthorized: invalid or missing bearer token' },
      403,
      cors,
    )
  }

  return null // Auth passed
}
