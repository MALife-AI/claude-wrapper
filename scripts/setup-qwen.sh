#!/usr/bin/env bash
# ===================================================================
# Qwen 3.6-27B-fp8 vLLM 서빙 설정 스크립트
# GPU 인스턴스(A100 40GB+ 권장)에서 실행
# ===================================================================
set -euo pipefail

echo "=== 1. vLLM 설치 ==="
pip install --upgrade pip
pip install vllm>=0.8.0

echo "=== 2. Qwen 3.6-27B-fp8 모델 서빙 시작 ==="
echo "모델을 자동으로 다운로드하고 서빙합니다 (약 27GB 디스크 필요)..."

# vLLM OpenAI-compatible API 서버 실행
# - 포트: 8000
# - FP8 양자화 모델이므로 별도 quantization 설정 불필요
# - max-model-len: 메모리에 따라 조정
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen3-27B-FP8 \
  --served-model-name qwen3-27b-fp8 \
  --host 0.0.0.0 \
  --port 8000 \
  --max-model-len 8192 \
  --trust-remote-code \
  --dtype auto \
  --gpu-memory-utilization 0.90

# 서버 실행 후 확인:
# curl http://localhost:8000/v1/models
# curl http://localhost:8000/v1/chat/completions \
#   -H "Content-Type: application/json" \
#   -d '{"model":"qwen3-27b-fp8","messages":[{"role":"user","content":"Hello"}]}'
