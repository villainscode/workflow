// MarkFlow 에디터(packages/editor)에서 가져온 코드. Cloudflare Worker(site/cloudflare/r2-uploader)로 이미지를 R2에 올리고 공개 URL을 받는다.

interface CloudflareUploadResponse {
  success: boolean
  url?: string
  error?: string
}

/**
 * Creates an image upload function that uses a Cloudflare Worker + R2 backend.
 *
 * Usage:
 *   const uploader = createCloudflareUploader('https://my-worker.workers.dev')
 *   const url = await uploader(file)
 */
export function createCloudflareUploader(workerUrl: string) {
  return async function uploadToCloudflare(file: File): Promise<string> {
    if (!workerUrl) {
      throw new Error('업로드 서버 주소가 설정되지 않았습니다')
    }

    const baseUrl = workerUrl.replace(/\/+$/, '')
    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      throw new Error(`업로드 실패 (${response.status}): ${errorText}`)
    }

    const result: CloudflareUploadResponse = await response.json()

    if (!result.success || !result.url) {
      throw new Error(result.error || '업로드 실패: 응답 형식이 올바르지 않습니다')
    }

    return result.url
  }
}

/**
 * Creates a tiny 1x1 transparent PNG for testing the upload endpoint.
 * No file picker needed — generated programmatically.
 */
export function createTestImage(): File {
  // Minimal 1x1 transparent PNG (67 bytes)
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], 'test.png', { type: 'image/png' })
}
