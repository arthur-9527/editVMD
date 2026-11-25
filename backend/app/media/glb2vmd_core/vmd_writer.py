# coding: utf-8
"""VMD 输出 —— 薄封装 pymeshio.vmd.writer。

VMD 骨骼帧结构（pymeshio 已实现）：
    name[15] + frame(u32) + pos(3f) + quat(4f, x,y,z,w) + interp[64]
插值曲线用线性：4 条曲线 × ((20,20),(107,107)) → 前 16 字节 + 0x01，其余补 0。
"""
import contextlib

import numpy as np
import io

import pymeshio.vmd as vmd
from pymeshio.vmd import writer as vmd_writer
from pymeshio import common

# 线性插值 64 字节
LINEAR_INTERP = bytes(
    [20, 20, 20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107, 1]
    + [0] * 47
)


def write_vmd(res, out_path, model_name="", frame_start=0):
    """把 RetargetResult 写成 VMD。"""
    motion = vmd.Motion()
    motion.model_name = model_name

    names = sorted(set(res.rot.keys()) | set(res.pos.keys()))
    frames = []
    for name in names:
        enc = name.encode("cp932", errors="replace")
        if len(enc) > 15:
            raise ValueError("骨名超过 15 字节(cp932): %s" % name)
        rot = res.rot.get(name)
        pos = res.pos.get(name)
        for f in range(res.frames):
            bf = vmd.BoneFrame(enc)
            bf.frame = f + frame_start
            if pos is not None:
                bf.pos = common.Vector3(
                    float(pos[f][0]), float(pos[f][1]), float(pos[f][2])
                )
            if rot is not None:
                bf.q = common.Quaternion(
                    float(rot[f][0]), float(rot[f][1]),
                    float(rot[f][2]), float(rot[f][3]),
                )
            bf.complement = LINEAR_INTERP
            frames.append(bf)

    frames.sort(key=lambda x: (x.name, x.frame))
    motion.motions = frames

    # pymeshio 的 writer 里有 print()，压掉
    with open(out_path, "wb") as f:
        with contextlib.redirect_stdout(io.StringIO()):
            vmd_writer.write(f, motion)
    return len(frames)


def parse_vmd(path):
    """按 VMD 规范严格解析（仅用于校验我们自己的输出）。

    说明：pymeshio 的 vmd.reader 是 py2 遗留实现（用 str 和 bytes 比较签名，
    Python3 下永远返回 None），无法用于校验，故此处按规范+对齐做严格自检：
    每个骨骼帧固定 111 字节，最后三段（morph / camera / light）计数必须为 0，
    且文件必须被完整消费。
    """
    import struct

    with open(path, "rb") as f:
        data = f.read()
    if not data[:25] == b"Vocaloid Motion Data 0002":
        raise ValueError("VMD 签名错误: %r" % data[:30])
    o = 30
    model_name = data[o:o + 20].split(b"\x00")[0].decode("cp932", "replace")
    o += 20
    (count,) = struct.unpack_from("<I", data, o)
    o += 4
    frames = []
    for _ in range(count):
        name = data[o:o + 15].split(b"\x00")[0].decode("cp932", "replace")
        o += 15
        (fr,) = struct.unpack_from("<I", data, o)
        o += 4
        px, py, pz, qx, qy, qz, qw = struct.unpack_from("<7f", data, o)
        o += 28
        interp = data[o:o + 64]
        o += 64
        frames.append({
            "name": name, "frame": fr, "pos": (px, py, pz),
            "quat": (qx, qy, qz, qw), "interp": interp,
        })
    tail = {}
    for key in ("morph", "camera", "light"):
        (n,) = struct.unpack_from("<I", data, o)
        o += 4
        tail[key] = n
    return {
        "model_name": model_name, "frames": frames, "tail": tail,
        "consumed": o, "size": len(data),
    }


def verify_vmd(path, res):
    """回读并与 RetargetResult 逐帧比对。"""
    p = parse_vmd(path)
    frames = p["frames"]
    names = sorted(set(fr["name"] for fr in frames))
    problems = []
    if p["consumed"] != p["size"]:
        problems.append("文件未完整消费: %d / %d" % (p["consumed"], p["size"]))
    for k, v in p["tail"].items():
        if v != 0:
            problems.append("尾部 %s 段计数非 0: %d" % (k, v))
    if p["model_name"] != "":
        problems.append("model name 非空: %r" % p["model_name"])

    max_q_err = 0.0
    max_p_err = 0.0
    bad_q = 0
    ok_interp = True
    # 建索引：(name, frame)
    written = {(fr["name"], fr["frame"]): fr for fr in frames}
    for name in sorted(set(res.rot.keys()) | set(res.pos.keys())):
        for f in range(res.frames):
            fr = written.get((name, f))
            if fr is None:
                problems.append("缺少帧: %s @%d" % (name, f))
                continue
            if fr["interp"] != LINEAR_INTERP:
                ok_interp = False
            q = np.array(fr["quat"])
            n = np.linalg.norm(q)
            if not np.isfinite(q).all() or abs(n - 1.0) > 1e-3:
                bad_q += 1
            if name in res.rot:
                qr = res.rot[name][f]
                max_q_err = max(max_q_err, float(np.abs(q - qr).max()))
            if name in res.pos:
                pr = res.pos[name][f]
                max_p_err = max(max_p_err, float(np.abs(np.array(fr["pos"]) - pr).max()))
    if bad_q:
        problems.append("%d 个四元数模长异常" % bad_q)
    if not ok_interp:
        problems.append("插值曲线字节不符合线性模板")
    if len(written) != len(frames):
        problems.append("存在重复 (骨名,帧) 键")
    return {
        "count": len(frames),
        "names": names,
        "frame_min": min(fr["frame"] for fr in frames),
        "frame_max": max(fr["frame"] for fr in frames),
        "max_quat_err": max_q_err,
        "max_pos_err": max_p_err,
        "problems": problems,
    }
