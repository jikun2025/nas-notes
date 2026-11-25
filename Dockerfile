FROM python:3.13-alpine

ENV PYTHONUNBUFFERED=1 \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

WORKDIR /app
COPY server.py /app/server.py
COPY static /app/static
RUN mkdir -p /data

EXPOSE 8080
VOLUME ["/data"]

CMD ["python", "/app/server.py"]
