FROM python:3.12-alpine
WORKDIR /app
COPY learning-service/server.py /app/server.py
COPY learning /app/learning
ENV PYTHONUNBUFFERED=1 LEARNING_DIR=/app/learning
EXPOSE 8091
CMD ["python", "/app/server.py"]
