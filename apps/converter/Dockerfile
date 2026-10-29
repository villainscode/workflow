# 문서 탐색 워크플로우 변환 컨테이너(4.0 P7): PPTX·DOCX·XLSX → PDF (LibreOffice headless)
# 한글이 빠지지 않게 Noto CJK 글꼴을 넣는다(로컬 macOS에서 겪은 "한글 빠진 PDF"와 같은 문제를 막는다)
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-impress libreoffice-writer libreoffice-calc fonts-noto-cjk fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs .
ENV HOME=/tmp
EXPOSE 8080
CMD ["node", "server.mjs"]
