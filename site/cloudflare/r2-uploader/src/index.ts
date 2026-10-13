// ─── Cloudflare Worker — R2 Image Upload ─────────────────────────────────────

import {
  type Env,
  MAX_FILE_SIZE,
  ALLOWED_TYPES,
  corsHeaders,
  jsonResponse,
  getExtension,
  checkAuth,
} from './helpers'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env)

    // ── Preflight ──────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // ── Health check ───────────────────────────────────────────────────────
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'workflow-r2-uploader' }, 200, cors)
    }

    // ── Upload ─────────────────────────────────────────────────────────────
    if (url.pathname === '/upload' && request.method === 'POST') {
      // Bearer token authentication (D-05: skip if API_SECRET not set)
      const authError = checkAuth(request, env, cors)
      if (authError) return authError

      try {
        const formData = await request.formData()
        const file = formData.get('file')

        if (!file || !(file instanceof File)) {
          return jsonResponse({ success: false, error: 'No file provided. Use "file" field.' }, 400, cors)
        }

        // Validate type
        if (!ALLOWED_TYPES.has(file.type)) {
          return jsonResponse(
            { success: false, error: `Invalid file type: ${file.type}. Allowed: png, jpg, gif, webp, svg` },
            400,
            cors,
          )
        }

        // Validate size
        if (file.size > MAX_FILE_SIZE) {
          return jsonResponse(
            { success: false, error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: 10MB` },
            400,
            cors,
          )
        }

        // Generate unique key
        const timestamp = Date.now()
        const uuid = crypto.randomUUID()
        const ext = getExtension(file.type)
        const key = `images/${timestamp}-${uuid}.${ext}`

        // Upload to R2
        await env.BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        })

        // Build public URL
        const publicUrl = env.PUBLIC_URL.replace(/\/+$/, '')
        const imageUrl = `${publicUrl}/${key}`

        return jsonResponse({ success: true, url: imageUrl }, 200, cors)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return jsonResponse({ success: false, error: message }, 500, cors)
      }
    }

    // ── 404 ────────────────────────────────────────────────────────────────
    return jsonResponse({ success: false, error: 'Not found. Use POST /upload' }, 404, cors)
  },
}
