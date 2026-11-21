#!/usr/bin/env bash
# 下载一个轻量图像模型（T2I 关键帧用）：SD1.5 fp16 ≈ 2.1GB
set -u
DEST="${COMFY_DIR:-/d/云盘/01-代码/AI视频/ComfyUI}/models/checkpoints"
mkdir -p "$DEST"
OUT="$DEST/v1-5-pruned-emaonly-fp16.safetensors"
URL="https://www.modelscope.cn/models/Comfy-Org/stable-diffusion-v1-5-archive/resolve/master/v1-5-pruned-emaonly-fp16.safetensors"
LOG="${CACHE_ROOT:-/d/缓存}/avp/sd_download.log"
: > "$LOG"

if [ -s "$OUT" ]; then
  sz=$(stat -c %s "$OUT" 2>/dev/null || echo 0)
  if [ "$sz" -gt 1500000000 ]; then echo "SKIP $(du -h "$OUT" | cut -f1)"; exit 0; fi
  rm -f "$OUT"
fi
echo "GET $(basename "$OUT")" | tee -a "$LOG"
for i in 1 2 3 4 5; do
  curl -L --fail -C - --connect-timeout 15 --max-time 1800 \
       --speed-limit 200000 --speed-time 30 --retry 2 --retry-all-errors \
       -o "$OUT" "$URL" >>"$LOG" 2>&1 && { echo "OK $(du -h "$OUT" | cut -f1)" | tee -a "$LOG"; exit 0; }
  echo "retry $i" | tee -a "$LOG"; sleep 3
done
echo "FAILED" | tee -a "$LOG"; exit 1
