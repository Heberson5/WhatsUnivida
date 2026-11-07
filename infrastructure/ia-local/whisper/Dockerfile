# Transcrição do Assistente Virtual (Whisper large-v3-turbo via faster-whisper, int8 no processador).
# Funciona em x86_64 e ARM (Oracle Ampere): as rodas do faster-whisper/ctranslate2/av existem para os dois.
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/models
# requests: usado pelo faster-whisper 1.1.1 para baixar o modelo, mas não vem como dependência dele.
RUN pip install --no-cache-dir faster-whisper==1.1.1 requests==2.32.3
WORKDIR /app
COPY server.py .
EXPOSE 9000
CMD ["python", "server.py"]
