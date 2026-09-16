# ---- build frontend ----
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# ---- runtime ----
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./backend/
COPY --from=web /web/dist ./frontend/dist
ENV FRONTEND_DIST=/app/frontend/dist STATE_FILE=/data/state.json PORT=8000
RUN mkdir -p /data
EXPOSE 8000
WORKDIR /app/backend
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT}
