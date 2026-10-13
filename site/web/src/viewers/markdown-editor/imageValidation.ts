// MarkFlow 에디터에서 가져온 코드. 올리기 전에 이미지 형식·크기를 확인한다(Worker와 같은 기준).

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB (matches Worker limit)

export interface ValidationResult {
  valid: boolean
  error?: string
}

export function validateImageFile(file: File): ValidationResult {
  if (!ALLOWED_TYPES.includes(file.type)) {
    const allowed = ALLOWED_TYPES.map((t) => t.replace('image/', '')).join(', ')
    return { valid: false, error: `지원하지 않는 파일 형식입니다. (${allowed})` }
  }

  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
    return { valid: false, error: `파일 크기가 너무 큽니다. (${sizeMB}MB / 최대 10MB)` }
  }

  if (file.size === 0) {
    return { valid: false, error: '빈 파일은 업로드할 수 없습니다.' }
  }

  return { valid: true }
}
