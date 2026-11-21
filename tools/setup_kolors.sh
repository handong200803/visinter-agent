#!/usr/bin/env bash
# 下载 Kolors（快手可图，中文原生文生图）diffusers 权重
# 体积约 14GB（unet fp16 5.1G + ChatGLM3 文本编码器 ~8.5G + vae）
set -u
DEST="${KOLORS_DIR:-/d/云盘/03-文档/tools/models/Kolors}"
LOG="${CACHE_ROOT:-/d/缓存}/avp/kolors_download.log"
mkdir -p "$DEST" "$(dirname "$LOG")"
: > "$LOG"

PY="D:/云盘/01-代码/AI视频/ComfyUI/.venv/Scripts/python.exe"

echo "下载 Kolors → $DEST" | tee -a "$LOG"
"$PY" - <<'PY' 2>&1 | tee -a "$LOG"
import os, sys
try:
    from modelscope import snapshot_download
except Exception as e:
    print('IMPORT_FAIL', e); sys.exit(1)
dest = os.environ.get('KOLORS_DIR', r'D:\云盘\03-文档\tools\models\Kolors')
try:
    p = snapshot_download('Kwai-Kolors/Kolors', local_dir=dest)
    print('OK', p)
except Exception as e:
    print('DOWNLOAD_FAIL', type(e).__name__, str(e)[:300]); sys.exit(1)
PY

echo "DONE" | tee -a "$LOG"
du -sh "$DEST" 2>/dev/null | tee -a "$LOG"
