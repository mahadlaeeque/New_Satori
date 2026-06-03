FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY drive_to_bq.py .
# Cloud Run Job entrypoint
ENTRYPOINT ["python", "drive_to_bq.py"]
