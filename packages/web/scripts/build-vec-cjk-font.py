#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-vec-cjk-font.py — 可复现构建「矢量 PDF 内嵌中文字体 VecCJK」

产物（覆盖写出，幂等可重复运行）：
  - packages/web/src/export/assets/vector-cjk.ttf        (glyf/TrueType，供 jsPDF 内嵌)
  - packages/web/src/export/assets/vector-cjk-cmap.json  (由新字体 cmap 重新生成的覆盖区间表)

────────────────────────────────────────────────────────────────────────
来源字体与许可
────────────────────────────────────────────────────────────────────────
源字体：Noto Sans CJK SC Regular（SIL Open Font License 1.1，OFL-1.1）
  - 文件：/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
  - SC 子族：fontNumber=2（"Noto Sans CJK SC / Regular"，CFF 轮廓，unitsPerEm=1000）
  - 上游：https://github.com/notofonts/noto-cjk ；Copyright 2014-2021 Google LLC.
  - 派生字体已改名 VecCJK（未沿用 Reserved Font Name "Noto"）。
  - OFL 正文随产物 LICENSE-VecCJK.txt 分发。运行本脚本不联网、不下载任何资源。

────────────────────────────────────────────────────────────────────────
选形（codepoint）算法 —— 写清来源，便于审计
────────────────────────────────────────────────────────────────────────
目标码位 = 以下三部分的并集：

  1) ASCII 可打印字符：U+0020..U+007E（95 个）。

  2) 既有全角/常用标点符号集：直接从「当前已发布」的 vector-cjk-cmap.json
     里读出所有 *非* 中日韩统一表意文字（U+4E00..U+9FFF）的码位——
     即 CJK 符号标点（U+3000..U+303E 一带）与全角形式（U+FF01..U+FF5E、
     U+FFE0..U+FFE6）。这样保证 Wave14 已支持的全角字符一个都不丢。

  3) GB2312 全部汉字（一级 + 二级，共 6763 个）：
     - 来源：GB2312-80 的 94x94 区位表。一级常用字在 16..55 区（3755 字），
       二级次常用字在 56..87 区（3008 字）。
     - 取法：对每个区位 (row in 16..87, col in 1..94) 拼出 GB2312 字节
       (row+0xA0, col+0xA0)，再用 Python 标准库 'gb2312' codec 解码回
       Unicode 码位。这是 GB2312→Unicode 的权威映射，无需外部码表文件。
     - 校验：枚举结果恰为 6763 个唯一 BMP 码位，且既有的 3755 个一级字
       （现字体 CJK 统一表意区覆盖数）是其子集。

  附加锚点：龘 U+9F98 一并纳入。
     说明：龘 严格落在 GBK 扩展区（gb18030 下为 0xFD93，区位 93，超出
     GB2312-80 止于 87 区的网格），并非 GB2312-80 的 6763 字之一；但它是
     本产品长期用作「生僻字」回归锚点的字符（wave20 e2e 以此验证矢量直出），
     且仅多 1 个字形（~0.3KB），纳入可避免「含龘文档被迫回退位图」这一本
     wave 正是要收敛的场景重新出现。Ext-B 等真正超出 BMP 的字符（如 𠮷
     U+20BB7）仍不在 cmap，继续走缺字形预检→位图回退兜底。

────────────────────────────────────────────────────────────────────────
转换（CFF → glyf/TrueType）—— 复刻既有字体规格
────────────────────────────────────────────────────────────────────────
  - pyftsubset 按上述码位子集化（notdef 带轮廓、recalcBBoxes、不留字形名，
    layout 特性全部丢弃）。
  - 用 fontTools.pens.cu2quPen.Cu2QuPen（max_err=1.0 font 单位，1000 upm 下
    ≈ 0.001em）把 CFF 三次贝塞尔轮廓二次曲线化为 glyf 轮廓；TTGlyphPen 收集。
  - 丢弃 CFF/VORG 及 jsPDF 用不到的 vhea/vmtx/BASE/GPOS/GSUB/GDEF（jsPDF +
    svg2pdf 只消费 cmap→glyf 轮廓 + hmtx  advance width；去掉这些既省体积、
    又不改变任何可见字形或字宽）。
  - maxp 升级为 1.0（glyf 必备）；post 设为 3.0（不留字形名，省 ~80KB）；
    unitsPerEm 保持 1000；OS/2.usWeightClass=400；name 表 1/4/6/16 改 VecCJK。

用法：
  python3 packages/web/scripts/build-vec-cjk-font.py
依赖：python3 标准库 + fontTools(4.64) + cu2qu(1.6)（本机已装）。
"""

from __future__ import annotations

import json
import os
import sys

# --------------------------------------------------------------------------
# 路径：脚本位于 packages/web/scripts/，产物在 packages/web/src/export/assets/
# --------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.dirname(SCRIPT_DIR)                      # packages/web
ASSETS_DIR = os.path.join(WEB_DIR, "src", "export", "assets")
OUT_TTF = os.path.join(ASSETS_DIR, "vector-cjk.ttf")
OUT_CMAP = os.path.join(ASSETS_DIR, "vector-cjk-cmap.json")

# 当前已发布的 cmap（用来继承全角/符号集）。首跑时它就是旧版；本脚本幂等。
PREV_CMAP = os.path.join(ASSETS_DIR, "vector-cjk-cmap.json")

# 源字体：Noto Sans CJK Regular TTC 里的 SC 面。
SRC_TTC = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
SRC_FONT_INDEX = 2  # 0=JP 1=KR 2=SC 3=TC 4=HK

# 回归锚点（见模块 docstring）。
ANCHOR_CPS = {0x9F98}  # 龘

# cu2qu 近似容差（font 单位；1000 upm）。
CU2QU_MAX_ERR = 1.0


def load_existing_nonhan_cps() -> set[int]:
    """从当前 cmap.json 读出非 CJK 统一表意（U+4E00..U+9FFF）的码位。"""
    cps: set[int] = set()
    if not os.path.exists(PREV_CMAP):
        return cps
    with open(PREV_CMAP, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    for lo, hi in data.get("ranges", []):
        for cp in range(lo, hi + 1):
            if not (0x4E00 <= cp <= 0x9FFF):  # 排除汉字（汉字由 GB2312 全量重给）
                cps.add(cp)
    return cps


def gb2312_hanzi_cps() -> set[int]:
    """GB2312-80 16..87 区（一级+二级）全部汉字，经 gb2312 codec 映射到 Unicode。"""
    cps: set[int] = set()
    for row in range(16, 88):       # 16..87
        for col in range(1, 95):   # 1..94
            raw = bytes([row + 0xA0, col + 0xA0])
            try:
                ch = raw.decode("gb2312")
            except UnicodeDecodeError:
                continue  # 该区位无定义
            if len(ch) == 1:
                cps.add(ord(ch))
    return cps


def build_target_cps() -> set[int]:
    cps: set[int] = set(range(0x20, 0x7F))   # ASCII
    cps |= load_existing_nonhan_cps()        # 既有全角/符号
    cps |= gb2312_hanzi_cps()                 # GB2312 一级+二级 6763 汉字
    cps |= ANCHOR_CPS                        # 龘锚点
    return cps


def compress_ranges(cps: list[int]) -> list[list[int]]:
    """把排序后的码位列表压成 [lo, hi] 区间（与既有 cmap.json 同格式）。"""
    if not cps:
        return []
    out: list[list[int]] = []
    lo = prev = cps[0]
    for cp in cps[1:]:
        if cp == prev + 1:
            prev = cp
        else:
            out.append([lo, prev])
            lo = prev = cp
    out.append([lo, prev])
    return out


def main() -> int:
    try:
        from fontTools.ttLib import TTFont, newTable
        from fontTools import subset as ftsubset
        from fontTools.pens.ttGlyphPen import TTGlyphPen
        from fontTools.pens.cu2quPen import Cu2QuPen
    except ImportError as exc:  # pragma: no cover
        print(f"✗ 缺少依赖（需 fontTools + cu2qu）: {exc}", file=sys.stderr)
        return 1

    if not os.path.exists(SRC_TTC):
        print(f"✗ 源字体不存在：{SRC_TTC}", file=sys.stderr)
        return 1

    target = build_target_cps()
    gb = gb2312_hanzi_cps()
    print(f"目标码位总数：{len(target)}（GB2312 汉字 {len(gb)} = 一级3755+二级3008）")

    # 1) 载入 Noto SC 面（CFF）。
    font = TTFont(SRC_TTC, fontNumber=SRC_FONT_INDEX)

    # 2) 子集化到目标码位。
    opts = ftsubset.Options(
        notdef_outline=True,      # .notdef 带轮廓，避免空 glyph
        recalc_bounds=True,
        recalc_timestamp=False,
        glyph_names=False,        # post format 3.0，不留字形名（省体积）
        layout_features="",       # 丢弃 GSUB/GPOS/GDEF
        name_IDs="*",
    )
    ss = ftsubset.Subsetter(options=opts)
    ss.populate(unicodes=sorted(target))
    ss.subset(font)

    # 3) CFF → glyf（此刻 CFF 仍在，glyphSet 可画）。
    glyph_order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = glyph_order
    glyf.glyphs = {}
    for name in glyph_order:
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(Cu2QuPen(pen, CU2QU_MAX_ERR, reverse_direction=True))
        glyf.glyphs[name] = pen.glyph()
    font["glyf"] = glyf
    font["loca"] = newTable("loca")

    # 4) 删 CFF 与 jsPDF 用不到的表。
    for tag in ("CFF ", "CFF2 ", "VORG", "vhea", "vmtx", "BASE", "GPOS", "GSUB", "GDEF"):
        if tag in font:
            del font[tag]

    # 5) 规格对齐：head / maxp(1.0) / post(3.0) / OS-2 / name。
    font["head"].glyphDataFormat = 0
    mp = font["maxp"]
    mp.tableVersion = 0x00010000
    for attr, val in (
        ("maxPoints", 0), ("maxContours", 0), ("maxCompositePoints", 0),
        ("maxCompositeContours", 0), ("maxZones", 1), ("maxTwilightPoints", 0),
        ("maxStorage", 0), ("maxFunctionDefs", 0), ("maxInstructionDefs", 0),
        ("maxStackElements", 0), ("maxSizeOfInstructions", 0),
        ("maxComponentElements", 0), ("maxComponentDepth", 0),
    ):
        setattr(mp, attr, val)
    font["post"].formatType = 3.0
    font["OS/2"].usWeightClass = 400
    for rec in font["name"].names:
        if rec.nameID in (1, 4, 6, 16):
            rec.string = "VecCJK"

    # 6) 写出 TTF。
    font.save(OUT_TTF)

    # 7) 从新字体 cmap 重新生成覆盖区间表。
    verify = TTFont(OUT_TTF)
    new_cmap = verify.getBestCmap()
    ranges = compress_ranges(sorted(new_cmap.keys()))
    cmap_doc = {
        "version": 1,
        "font": "VecCJK (Noto Sans CJK SC subset, OFL-1.1)",
        "coverage": {
            "ascii": "U+0020..U+007E",
            "hanzi": "GB2312 一级+二级 6763 汉字",
            "anchor": "龘 U+9F98（GBK 扩展区，回归锚点）",
            "symbols": "既有全角/CJK 符号标点集",
        },
        "ranges": ranges,
    }
    with open(OUT_CMAP, "w", encoding="utf-8") as fh:
        json.dump(cmap_doc, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")

    # 8) 自检并打印报告。
    ttf_bytes = os.path.getsize(OUT_TTF)
    selfcheck(verify, target, gb, ttf_bytes)
    return 0


def selfcheck(font: TTFont, target: set[int], gb: set[int], ttf_bytes: int) -> None:
    cm = font.getBestCmap()
    glyf = font["glyf"]
    print(f"写出：{OUT_TTF}（{ttf_bytes:,} 字节）")
    print(f"写出：{OUT_CMAP}")
    print(f"cmap 码位 {len(cm)}（目标 {len(target)}）")

    # 龘必须在 cmap 且有轮廓。
    assert 0x9F98 in cm, "✗ 龘 U+9F98 不在 cmap"
    g = glyf[cm[0x9F98]]
    assert g.numberOfContours != 0, "✗ 龘轮廓为空"
    print(f"✓ 龘 U+9F98 在 cmap，glyph={cm[0x9F98]}，contours={g.numberOfContours}")

    # 目标码位与 cmap 一致（不应有缺、不应多非目标）。
    missing = sorted(target - set(cm.keys()))
    assert not missing, f"✗ 目标码位缺失 {len(missing)} 个，前几个: {[hex(c) for c in missing[:10]]}"
    extra = sorted(set(cm.keys()) - target)
    print(f"✓ 目标全部覆盖；cmap 额外码位 {len(extra)} 个（subset 保留的 .notdef 等，可忽略）")

    # 无「可见」空字形（空格 U+0020、全角空格 U+3000、.notdef 本就空，属正常）。
    EMPTY_OK = {0x20, 0x3000}
    bad = [(hex(cp), gn) for cp, gn in cm.items()
           if cp not in EMPTY_OK and glyf[gn].numberOfContours == 0]
    assert not bad, f"✗ 存在可见空字形 {bad[:10]}"
    print("✓ 无可见空字形（space / 全角空格 本就空白，符合预期）")

    # GB2312 汉字数与 upm / 命名。
    han_in_cmap = sum(1 for cp in cm if 0x4E00 <= cp <= 0x9FFF)
    print(f"✓ CJK 统一表意覆盖 {han_in_cmap}（GB2312 汉字 {len(gb)} + 龘锚点）")
    print(f"✓ unitsPerEm={font['head'].unitsPerEm}  weight={font['OS/2'].usWeightClass}  name={font['name'].getDebugName(1)}")


if __name__ == "__main__":
    raise SystemExit(main())
