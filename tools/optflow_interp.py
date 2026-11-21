# -*- coding: utf-8 -*-
"""
optflow_interp.py -- 用 OpenCV 光流做帧率插值（RIFE 不可得时的本地替代）

为什么需要它：
  postprocess 的 interp 步骤在严格版里要求真 RIFE（AVP_RIFE 指向 rife-ncnn-vulkan）。
  本机 GitHub 不可达、ncnn 包下载不稳，于是增强层长期 BLOCKED（0 秒失败）。
  这个脚本用 cv2 的 Farneback 稠密光流 + 帧间双向加权合成中间帧，
  零新增依赖（系统 Python 已有 cv2 5.0），能把 24fps 补到 48/60fps。

诚实边界：
  画质低于 RIFE（无学习型光流），快速运动会有轻微撕裂；
  返回值里带 backend="optflow-farneback" 与 substitution 说明，绝不冒充 RIFE。

用法：
  python tools/optflow_interp.py --in a.mp4 --out b.mp4 --fps 60
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import shutil

import cv2
import numpy as np

FFMPEG = os.environ.get("AVP_FFMPEG", "C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe")
_TMP = os.environ.get("AVP_CV_TMP", "D:/avp_cv_tmp")


def ascii_copy(path):
    """中文路径在 Windows 上会让 ffmpeg/OpenCV 读不到，先复制到 ASCII 临时目录。"""
    if all(ord(c) < 128 for c in path):
        return path, None
    tmp = tempfile.mkdtemp(prefix="avp_interp_")
    dst = os.path.join(tmp, "src" + (os.path.splitext(path)[1] or ".mp4"))
    shutil.copy2(path, dst)
    return dst, tmp


def probe(path):
    r = subprocess.run([FFMPEG.replace("ffmpeg.exe", "ffprobe.exe"), "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=width,height,avg_frame_rate", "-of", "json", path],
                       capture_output=True, text=True, errors="ignore")
    j = json.loads(r.stdout or "{}")
    st = (j.get("streams") or [{}])[0]
    num, den = str(st.get("avg_frame_rate", "0/1")).split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    return int(st.get("width") or 0), int(st.get("height") or 0), fps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    ap.add_argument("--fps", type=float, default=60.0)
    args = ap.parse_args()

    os.makedirs(_TMP, exist_ok=True)
    tempfile.tempdir = _TMP

    src, cleanup = ascii_copy(args.src)
    try:
        w, h, src_fps = probe(src)
        if not w or not h:
            print(json.dumps({"ok": False, "error": "PROBE_FAILED"}))
            return 2
        if src_fps <= 0:
            src_fps = 24.0
        # 每两帧之间要插多少帧
        step = args.fps / src_fps
        if step <= 1.001:
            print(json.dumps({"ok": False, "error": "NO_UPSAMPLE_NEEDED", "src_fps": src_fps, "target_fps": args.fps}))
            return 2

        cap = cv2.VideoCapture(src)
        ok, prev = cap.read()
        if not ok:
            print(json.dumps({"ok": False, "error": "READ_FAILED"}))
            return 2

        tmpdir = tempfile.mkdtemp(prefix="avp_frames_")
        idx = 0
        written = 0

        def dump(frame):
            nonlocal written
            p = os.path.join(tmpdir, "f%05d.png" % written)
            cv2.imwrite(p, frame)
            written += 1

        dump(prev)
        while True:
            ok, cur = cap.read()
            if not ok:
                break
            gray_prev = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
            gray_cur = cv2.cvtColor(cur, cv2.COLOR_BGR2GRAY)
            flow = cv2.calcOpticalFlowFarneback(gray_prev, gray_cur, None, 0.5, 3, 21, 5, 7, 1.5, 0)
            # 中间帧：按 t 双向重采样（前向 + 反向平均，减少遮挡撕裂）
            n_mid = int(round(step)) - 1
            for k in range(1, n_mid + 1):
                t = k / float(n_mid + 1)
                grid_x, grid_y = np.meshgrid(np.arange(w), np.arange(h))
                map_x = (grid_x + flow[..., 0] * t).astype(np.float32)
                map_y = (grid_y + flow[..., 1] * t).astype(np.float32)
                mid = cv2.remap(prev, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                # 与 cur 反向对齐做混合（简单双向），压一下边缘拖影
                mid2 = cv2.remap(cur, (grid_x - flow[..., 0] * (1 - t)).astype(np.float32),
                                 (grid_y - flow[..., 1] * (1 - t)).astype(np.float32),
                                 interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                blend = cv2.addWeighted(mid, 1 - t, mid2, t, 0)
                dump(blend)
            dump(cur)
            prev = cur
            idx += 1
        cap.release()

        if not written:
            print(json.dumps({"ok": False, "error": "NO_FRAMES"}))
            return 2

        # 用 ffmpeg 编码回 mp4（保留原音轨）
        r = subprocess.run([FFMPEG, "-y", "-v", "error", "-framerate", str(args.fps),
                            "-i", os.path.join(tmpdir, "f%05d.png"), "-i", src,
                            "-map", "0:v:0", "-map", "1:a?", "-c:v", "libx264", "-crf", "18",
                            "-pix_fmt", "yuv420p", "-c:a", "copy", "-shortest", args.dst],
                           capture_output=True, text=True, errors="ignore")
        shutil.rmtree(tmpdir, ignore_errors=True)
        if r.returncode != 0 or not os.path.exists(args.dst):
            print(json.dumps({"ok": False, "error": "ENCODE_FAILED", "detail": (r.stderr or "")[:300]}))
            return 2

        ow, oh, ofps = probe(args.dst)
        print(json.dumps({
            "ok": True, "backend": "optflow-farneback", "src_fps": src_fps, "out_fps": ofps,
            "size": [ow, oh], "frames_out": written,
            "substitution": "非 RIFE：OpenCV Farneback 光流插帧（快速运动可能有轻微撕裂）",
        }, ensure_ascii=False))
        return 0
    finally:
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
