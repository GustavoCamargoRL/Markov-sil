FROM python:3.12-slim

WORKDIR /app

# dependências primeiro (aproveita cache de camada)
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# código do backend e frontend
COPY backend/ ./backend/
COPY frontend/ ./frontend/

WORKDIR /app/backend
EXPOSE 8000

# a porta pode ser injetada pela plataforma via $PORT (default 8000)
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
