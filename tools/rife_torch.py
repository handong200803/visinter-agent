# -*- coding: utf-8 -*-
"""
rife_torch.py -- 用真 RIFE（PyTorch 版，flownet.pkl）做视频插帧

来源：hf-mirror 的 r3gm/RIFE（RIFEv4.25lite 包，含 train_log/flownet.pkl + IFNet_HDv3.py）
为什么不用 rife-ncnn-vulkan：GitHub 不可达，ncnn 二进制拿不到；
  PyTorch 版权重可用 ComfyUI venv 的 torch 直接推理，画质等价（同一模型的另一后端）。
纪律：这是真 RIFE，返回值标 backend="rife-torch"，不写 substitution。

用法：
  python tools/rife_torch.py --in a.mp4 --out b.mp4 --fps 60 [--model D:/云盘/03-文档/tools/rife]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np
import torch

FFMPEG = os.environ.get("AVP_FFMPEG", "C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe")
_TMP = os.environ.get("AVP_CV_TMP", "D:/avp_cv_tmp")
MODEL_DIR = os.environ.get("AVP_RIFE_MODEL", r"D:/云盘/03-文档/tools/rife")


def ascii_copy(path):
    if all(ord(c) < 128 for c in path):
        return path, None
    tmp = tempfile.mkdtemp(prefix="avp_rife_")
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
    ap.add_argument("--model", default=MODEL_DIR)
    args = ap.parse_args()

    os.makedirs(_TMP, exist_ok=True)
    tempfile.tempdir = _TMP

    model_root = args.model
    train_log = os.path.join(model_root, "train_log")
    if not os.path.isdir(train_log):
        # 兼容把包解到 model_root 目录本身的布局
        if os.path.exists(os.path.join(model_root, "flownet.pkl")):
            train_log = model_root
        else:
            print(json.dumps({"ok": False, "error": "RIFE_MODEL_MISSING", "dir": model_root}))
            return 2
    sys.path.insert(0, model_root)
    try:
        from train_log.RIFE_HDv3 import Model  # noqa: E402
    except Exception as e:
        print(json.dumps({"ok": False, "error": "RIFE_IMPORT_FAILED", "detail": str(e)[:200]}))
        return 2

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = Model()
    model.load_model(train_log, -1)
    model.eval()
    model.device()

    src, cleanup = ascii_copy(args.src)
    try:
        w, h, src_fps = probe(src)
        if not w or not h:
            print(json.dumps({"ok": False, "error": "PROBE_FAILED"}))
            return 2
        if src_fps <= 0:
            src_fps = 24.0
        n_mid = max(0, int(round(args.fps / src_fps)) - 1)
        if n_mid <= 0:
            print(json.dumps({"ok": False, "error": "NO_UPSAMPLE_NEEDED", "src_fps": src_fps, "target_fps": args.fps}))
            return 2

        cap = cv2.VideoCapture(src)
        ok, prev = cap.read()
        if not ok:
            print(json.dumps({"ok": False, "error": "READ_FAILED"}))
            return 2

        tmpdir = tempfile.mkdtemp(prefix="avp_rife_frames_")
        written = 0

        def dump(frame):
            nonlocal written
            cv2.imwrite(os.path.join(tmpdir, "f%05d.png" % written), frame)
            written += 1

        def to_tensor(bgr):
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            t = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0)
            return t.to(device)

        def to_bgr(t):
            arr = (t.clamp(0, 1)[0].permute(1, 2, 0).cpu().numpy() * 255.0).astype(np.uint8)
            return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)

        dump(prev)
        with torch.no_grad():
            while True:
                ok, cur = cap.read()
                if not ok:
                    break
                t0 = to_tensor(prev)
                t1 = to_tensor(cur)
                for k in range(1, n_mid + 1):
                    ts = k / float(n_mid + 1)
                    mid = model.inference(t0, t1, timestep=ts)
                    dump(to_bgr(mid))
                dump(cur)
                prev = cur
        cap.release()

        if not written:
            print(json.dumps({"ok": False, "error": "NO_FRAMES"}))
            return 2

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
            "ok": True, "backend": "rife-torch", "model": train_log, "device": device,
            "src_fps": src_fps, "out_fps": ofps, "size": [ow, oh], "frames_out": written,
        }, ensure_ascii=False))
        return 0
    finally:
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
