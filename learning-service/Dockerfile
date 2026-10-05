FROM python:3.14.8-alpine3.24
WORKDIR /app
COPY learning-service/server.py /app/server.py
COPY learning /app/learning
ENV PYTHONUNBUFFERED=1 LEARNING_DIR=/app/learning
EXPOSE 8091
CMD ["python", "/app/server.py"]
