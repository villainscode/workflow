# Markdown 편집기 이미지 업로드 서버 (Cloudflare Worker + R2)

사이트 Markdown 편집기(`web/src/viewers/markdown-editor/`)의 이미지 올리기·끌어 놓기·붙여넣기가 쓰는 업로드 서버다.
MarkFlow 에디터의 `apps/worker`를 가져왔다. 이미지를 R2 버킷에 저장하고 공개 주소를 돌려준다. 편집기는 그 주소를 `![파일 이름](주소)`로 문서에 넣는다.

> 이미지는 리포 밖(Cloudflare R2)에 저장된다. 문서 버전 폴더에 들어가지 않으므로, 버킷을 지우면 문서의 이미지가 깨진다.

## 배포

1. **R2 버킷 만들기**: Cloudflare 대시보드 → R2 Object Storage → Create bucket(예: `workflow-images`). Settings → Public access를 켜고 공개 주소(`https://pub-xxxxxxxx.r2.dev`)를 확인한다.
2. **`wrangler.toml` 고치기**: `account_id`, `bucket_name`, `PUBLIC_URL`, `ALLOWED_ORIGINS`(사이트를 여는 주소. 기본 `http://localhost:8000,http://127.0.0.1:8000`).
3. **배포**
   ```bash
   cd site/cloudflare/r2-uploader
   npm install
   npx wrangler login
   npm run deploy      # 출력된 https://workflow-r2-uploader.<계정>.workers.dev 를 복사
   ```
4. **편집기에 연결**: Markdown 문서 편집 툴바의 설정(톱니바퀴) → Worker 주소 입력 → "테스트 업로드"가 성공하면 저장. 주소는 브라우저 localStorage(`mf-cf-worker-url`)에 저장되므로 브라우저마다 한 번 넣는다.

`API_SECRET`(Bearer 인증)은 Worker가 지원하지만 편집기는 토큰을 보내지 않는다. 설정하면 업로드가 403으로 막힌다.

## API

- `POST /upload` (multipart, 필드 `file`): png·jpg·gif·webp·svg, 최대 10MB → `{ "success": true, "url": "https://pub-…/images/<시각>-<uuid>.png" }`. 실패하면 `{ "success": false, "error": "…" }`.
- `GET /`, `GET /health`: 상태 확인.

로컬 시험: `npm run dev`(http://localhost:8787) 후 `curl -F "file=@test.png" http://localhost:8787/upload`.

무료 한도(2024 기준): R2 저장 10GB, 읽기 월 1,000만 회, 쓰기 월 100만 회, Worker 요청 하루 10만 회.
