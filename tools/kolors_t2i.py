# -*- coding: utf-8 -*-
"""
kolors_t2i.py -- 用 Kolors（快手可图）做中文原生文生图

为什么单独一个脚本：
  Kolors 是 SDXL 架构 + ChatGLM3 文本编码器，ComfyUI 主线没有它的加载器；
  与其装第三方自定义节点（GitHub 在本机不可达），不如用 diffusers 直接跑。

显存策略（8G 卡）：必须 enable_model_cpu_offload。unet 5.1G + 文本编码器 8.5G
同时上卡会 OOM；offload 后单张耗时明显增加，这是硬件代价，不优化掉。

用法：
  python tools/kolors_t2i.py --prompt "一只英短银渐层幼猫坐在木质窗台上" --out D:/tmp/kf.png
  python tools/kolors_t2i.py --prompt "..." --count 4 --width 832 --height 1216 --seed 42
"""
import argparse
import json
import os
import sys
import time

KOLORS_DIR = os.environ.get("KOLORS_DIR", r"D:\云盘\03-文档\tools\models\Kolors")

# Windows 上 tempfile 对中文临时目录（D:\缓存\临时）会判定"不可用"直接抛错，
# diffusers/torch 内部会用到临时目录，这里显式指到 ASCII 路径。
_TMP = os.environ.get("AVP_KOLORS_TMP", r"D:/avp_cv_tmp")
try:
    os.makedirs(_TMP, exist_ok=True)
    import tempfile as _tempfile
    _tempfile.tempdir = _TMP
except Exception:
    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--negative", default="模糊, 低质量, 水印, 文字, 畸形, 多余肢体, 重复图案, 拼贴")
    ap.add_argument("--out", default=r"D:\缓存\avp\kolors_out")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=1216)
    ap.add_argument("--steps", type=int, default=28)
    ap.add_argument("--cfg", type=float, default=5.0)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--prefix", default="kolors")
    args = ap.parse_args()

    if not os.path.isdir(KOLORS_DIR):
        print(json.dumps({"error": "KOLORS_DIR_MISSING", "dir": KOLORS_DIR}))
        return 2

    import torch
    from diffusers import KolorsPipeline

    t0 = time.time()
    # variant="fp16" 需要目录里恰好有 fp16 权重；缺失时 diffusers 的 variant 扫描会抛
    # IndexError（目录内有 extensionless 文件时）。这里带梯子：先 fp16，失败回退默认。
    try:
        pipe = KolorsPipeline.from_pretrained(KOLORS_DIR, torch_dtype=torch.float16, variant="fp16")
    except Exception as e:
        print(json.dumps({"warn": "FP16_VARIANT_FAILED", "detail": str(e)[:200]}), flush=True)
        pipe = KolorsPipeline.from_pretrained(KOLORS_DIR, torch_dtype=torch.float16)
    # 8G 卡必须 offload：SDXL unet + ChatGLM3 同时驻卡会 OOM
    pipe.enable_model_cpu_offload()
    # diffusers 0.43 的 KolorsPipeline 没有 enable_vae_slicing；退到底层 vae 上也行，失败就跳过
    try:
        pipe.enable_vae_slicing()
    except AttributeError:
        try:
            pipe.vae.enable_slicing()
        except Exception:
            pass
    load_sec = round(time.time() - t0, 1)

    os.makedirs(args.out, exist_ok=True)
    results = []
    base_seed = args.seed if args.seed is not None else int(time.time()) % 1000000
    for i in range(max(1, min(8, args.count))):
        seed = base_seed + i * 7919
        gen = torch.Generator(device="cpu").manual_seed(seed)
        t1 = time.time()
        img = pipe(
            prompt=args.prompt,
            negative_prompt=args.negative,
            width=args.width,
            height=args.height,
            num_inference_steps=args.steps,
            guidance_scale=args.cfg,
            generator=gen,
        ).images[0]
        path = os.path.join(args.out, f"{args.prefix}_{seed}_{i}.png")
        img.save(path)
        results.append({"file": path, "seed": seed, "sec": round(time.time() - t1, 1)})
        print(json.dumps({"done": i + 1, "file": path, "sec": results[-1]["sec"]}), flush=True)

    print(json.dumps({"ok": True, "backend": "kolors", "model_dir": KOLORS_DIR, "load_sec": load_sec,
                      "size": [args.width, args.height], "steps": args.steps, "cfg": args.cfg,
                      "images": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
