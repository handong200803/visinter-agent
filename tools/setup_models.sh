#!/usr/bin/env bash
# setup_models.sh —— 一键拉取 MiniMax H3 / Wan2.2 权重到 ComfyUI/models
#
# 用法：
#   bash tools/setup_models.sh            # 全部（H3 + Wan2.2，约 60GB）
#   bash tools/setup_models.sh h3         # 只拉 H3（约 45GB）
#   bash tools/setup_models.sh wan        # 只拉 Wan2.2（约 17GB）
#
# 源：ModelScope（实测 10–12MB/s；hf-mirror 对 Wan 文件限速 1.3MB/s）
# 断点续传；小于 1GB 的残片会被删除重下（踩过：207MB 残片被 -s 判为完整）。
set -u

COMFY="${COMFY_DIR:-/d/云盘/01-代码/AI视频/ComfyUI}"
MODELS="$COMFY/models"
LOG="${CACHE_ROOT:-/d/缓存}/avp/setup_models.log"
mkdir -p "$MODELS"/{diffusion_models,text_encoders,vae,loras} "$(dirname "$LOG")"
: > "$LOG"

H3_BASE="https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master"
WAN_BASE="https://www.modelscope.cn/models/Comfy-Org/Wan-2.2/resolve/master"

get () { # $1=url $2=dest_path $3=min_bytes(默认1GB)
  local url="$1" out="$2" min="${3:-1000000000}" name
  name="$(basename "$out")"
  if [ -s "$out" ]; then
    local sz; sz=$(stat -c %s "$out" 2>/dev/null || echo 0)
    if [ "$sz" -ge "$min" ]; then echo "SKIP $name $(du -h "$out" | cut -f1)" | tee -a "$LOG"; return 0; fi
    echo "TRUNCATE $name ($sz bytes < $min)" | tee -a "$LOG"; rm -f "$out"
  fi
  echo "GET $name ← $url" | tee -a "$LOG"
  for i in 1 2 3 4 5; do
    curl -L --fail -C - --connect-timeout 15 --max-time 3600 \
         --speed-limit 300000 --speed-time 30 --retry 2 --retry-all-errors \
         -o "$out" "$url" >>"$LOG" 2>&1 && { echo "OK $name $(du -h "$out" | cut -f1)" | tee -a "$LOG"; return 0; }
    echo "retry $i $name" | tee -a "$LOG"; sleep 3
  done
  echo "FAILED $name" | tee -a "$LOG"; return 1
}

h3 () {
  get "$H3_BASE/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors" "$MODELS/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors" 20000000000
  get "$H3_BASE/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"        "$MODELS/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" 15000000000
  get "$H3_BASE/vae/minimax_h3_video_vae_fp16.safetensors"                         "$MODELS/vae/minimax_h3_video_vae_fp16.safetensors" 5000000000
  get "$H3_BASE/vae/minimax_h3_audio_vae_fp32.safetensors"                         "$MODELS/vae/minimax_h3_audio_vae_fp32.safetensors" 500000000
  get "$H3_BASE/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors" "$MODELS/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors" 1800000000
}

wan () {
  get "$WAN_BASE/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"      "$MODELS/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors" 9000000000
  get "$WAN_BASE/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" "$MODELS/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" 6000000000
  get "$WAN_BASE/split_files/vae/wan2.2_vae.safetensors"                           "$MODELS/vae/wan2.2_vae.safetensors" 1300000000
}

case "${1:-all}" in
  h3) h3 ;;
  wan) wan ;;
  all) h3; wan ;;
  *) echo "用法：bash tools/setup_models.sh [h3|wan|all]"; exit 2 ;;
esac

echo "完成。校验：node tools/h3.mjs check（期望 MEASURED）" | tee -a "$LOG"
