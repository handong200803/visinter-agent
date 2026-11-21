#!/usr/bin/env bash
# 启动本地 ComfyUI（H3 专用低显存配置）
# 8GB 显存：--lowvram + 预留显存；文本编码器走 CPU（H3 的 32B 文本编码器比扩散主干还大）
set -e
cd "/d/云盘/01-代码/AI视频/ComfyUI"
PORT="${PORT:-8188}"
# 新版 ComfyUI 没有 --cpu-text-encoder：--lowvram 本身就表示「文本编码器跑 CPU、扩散模型低显存换入」
ARGS=(--listen 127.0.0.1 --port "$PORT" --lowvram --reserve-vram 0.5 --preview-method none)
if [ "${CPU_VAE:-0}" = "1" ]; then ARGS+=(--cpu-vae); fi
echo "[comfy] .venv python main.py ${ARGS[*]}"
exec .venv/Scripts/python.exe main.py "${ARGS[@]}"
