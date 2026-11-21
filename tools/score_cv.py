# -*- coding: utf-8 -*-
"""
score_cv.py -- real frame-level metrics with OpenCV (face box stability + dense optical flow).

Why a separate Python script:
  The Node scorer's Sface/Sflow are rule proxies. To claim "measured" you need real face
  detection and dense flow. OpenCV is available in the system Python (cv2 5.0.0); we do NOT
  touch ComfyUI's venv (hard rule).

Output JSON on stdout:
  { faces:{detected,rate,box_std,area_cv}, flow:{mean_mag,jitter,jerk,big_ratio},
    luma:{mean,std,flicker}, meta:{w,h,fps,frames,sampled}, backend:"opencv" }

Windows note: cv2.VideoCapture cannot open non-ASCII (Chinese) paths, so when it fails we
extract frames with ffmpeg into an ASCII temp dir and read PNGs instead.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import math

import cv2
import numpy as np

FFMPEG = os.environ.get("AVP_FFMPEG", "C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe")

# Windows 上 Python 的 tempfile 对中文临时目录（D:\缓存\临时）会判定"不可用"，
# 这里显式指定一个 ASCII 临时目录，避免 FileNotFoundError。
_CV_TMP = os.environ.get("AVP_CV_TMP", "D:/avp_cv_tmp")
try:
    os.makedirs(_CV_TMP, exist_ok=True)
    tempfile.tempdir = _CV_TMP
except Exception:
    pass


def frames_via_ffmpeg(path, sample=24, width=320):
    tmp = tempfile.mkdtemp(prefix="avp_cv_")
    try:
        duration = 5.0
        try:
            probe = subprocess.run(
                [FFMPEG.replace("ffmpeg.exe", "ffprobe.exe"), "-v", "error",
                 "-show_entries", "format=duration", "-of", "csv=p=0", path],
                capture_output=True, text=True, errors="ignore")
            duration = float((probe.stdout or "5").strip() or 5)
        except Exception:
            pass
        fps = max(0.5, sample / max(0.3, duration))
        cmd = [FFMPEG, "-v", "error", "-i", path, "-vf",
               "fps=%.4f,scale=%d:-2" % (fps, width), "-frames:v", str(sample),
               os.path.join(tmp, "f%03d.png")]
        subprocess.run(cmd, check=False, capture_output=True)
        out = []
        for f in sorted(glob.glob(os.path.join(tmp, "f*.png"))):
            im = cv2.imread(f)
            if im is not None:
                out.append(im)
        return out, duration
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def read_frames(path, sample=24, width=320):
    frames, fps, total, w0, h0 = [], 0.0, 0, 0, 0
    cap = cv2.VideoCapture(path)
    if cap.isOpened():
        fps = cap.get(cv2.CAP_PROP_FPS) or 0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        w0 = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        h0 = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        idx = list(range(total)) if total <= sample else [int(i * (total - 1) / (sample - 1)) for i in range(sample)]
        for fi in idx:
            cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
            ok, fr = cap.read()
            if not ok:
                continue
            scale = float(width) / max(1, fr.shape[1])
            frames.append(cv2.resize(fr, (width, max(2, int(fr.shape[0] * scale))), interpolation=cv2.INTER_AREA))
        cap.release()
    if not frames:
        frames, duration = frames_via_ffmpeg(path, sample, width)
        total = len(frames)
        fps = round(len(frames) / duration, 2) if duration else 0
        if frames:
            h0, w0 = frames[0].shape[0], frames[0].shape[1]
    return frames, fps, total, w0, h0


def ascii_copy(path):
    """ffmpeg/OpenCV on Windows 无法可靠处理中文路径 → 先复制到 ASCII 临时路径。"""
    if all(ord(c) < 128 for c in path):
        return path, None
    tmp = tempfile.mkdtemp(prefix="avp_src_")
    dst = os.path.join(tmp, "src" + (os.path.splitext(path)[1] or ".mp4"))
    shutil.copy2(path, dst)
    return dst, tmp


def main(path, sample=24, width=320):
    src, tmpdir = ascii_copy(path)
    try:
        return _main(src, path, sample, width)
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


def _main(src, original, sample=24, width=320):
    frames, fps, total, w0, h0 = read_frames(src, sample, width)
    if not frames:
        print(json.dumps({"error": "OPEN_FAILED", "path": original}))
        return 2

    # 人脸检测：cv2 5.0 已移除 CascadeClassifier；YuNet 需 ONNX 模型（镜像限流暂不可得）。
    # 因此这里只输出「人脸是否可测」的标记，Sface 仍由 Node 侧代理计算并在 provenance 标注。
    faces = {"detected": 0, "rate": 0.0, "box_std": 0.0, "area_cv": 0.0, "available": False,
             "reason": "cv2 5.0 无 CascadeClassifier；YuNet 模型需外网（hf-mirror 限流）"}

    mags, jerks, big, pairs, prev = [], [], 0, 0, None
    for fr in frames:
        gray = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        if prev is not None:
            flow = cv2.calcOpticalFlowFarneback(prev, gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
            m = float(np.mean(mag))
            mags.append(m)
            jerks.append(float(np.mean(np.abs(mag - np.median(mag)))))
            big += int(np.mean(mag > 8.0) > 0.05)
            pairs += 1
        prev = gray

    lumas = [float(np.mean(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY))) for fr in frames]
    flick = float(np.mean(np.abs(np.diff(lumas)))) if len(lumas) > 1 else 0.0

    out = {
        "faces": faces,
        "flow": {"mean_mag": round(float(np.mean(mags)) if mags else 0.0, 3),
                 "jitter": round(float(np.std(mags)) if len(mags) > 1 else 0.0, 3),
                 "jerk": round(float(np.mean(jerks)) if jerks else 0.0, 3),
                 "big_ratio": round(big / float(max(1, pairs)), 3)},
        "luma": {"mean": round(float(np.mean(lumas)), 2), "std": round(float(np.std(lumas)), 2), "flicker": round(flick, 2)},
        "meta": {"w": w0, "h": h0, "fps": round(fps, 2), "frames": total, "sampled": len(frames)},
        "backend": "opencv",
        "cv_version": cv2.__version__,
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 24))
