"""
生成真实的动图测试夹具（A2 覆盖缺口补验）。

背景：A2 实现了多帧拒绝（IMAGE_ANIMATED），但当时本机 sharp 无法生成多帧输出
（webp/gif 的 pageHeight 构造读回 pages 恒为 1），只能对谓词 isAnimatedFrameCount
做单测，「真实动图被 analyzeImage 拒绝」这条路径缺真实样本。

sharp 是解码器，不是编码器问题的解 —— 用 Pillow 生成真实的双帧 GIF / 动画 WebP，
提交为固定夹具（几十到几百字节），测试直接读文件，不让测试依赖 Pillow。

产物：
  tests/fixtures/animated/sample.gif       双帧 GIF（64x64，红/蓝两帧）
  tests/fixtures/animated/sample.webp     双帧动画 WebP（同上）
  tests/fixtures/animated/sample-apng.png 双帧 APNG（PNG 容器，同上）

层次说明：GIF 不在支持格式白名单里，会在格式检查就被拒（IMAGE_INVALID_FORMAT）；
真正走到多帧分支（IMAGE_ANIMATED）的是「白名单容器里的多帧」——动画 WebP 与 APNG。
APNG 夹具因此不可省：它伪装成普通 PNG 通过格式检查，只能靠帧数拦下来。

用法：venv 的 python 运行本脚本即可；产物已提交，正常开发无需重跑。
"""

from PIL import Image
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures', 'animated')
os.makedirs(OUT, exist_ok=True)

# 两帧颜色差异要大，确保真的有帧间变化（单色全帧可能被编码器优化成单帧）
frames = [
    Image.new('RGB', (64, 64), (220, 60, 60)),   # 红
    Image.new('RGB', (64, 64), (60, 110, 220)),  # 蓝
]

gif_path = os.path.join(OUT, 'sample.gif')
frames[0].save(gif_path, save_all=True, append_images=frames[1:], duration=400, loop=0)

webp_path = os.path.join(OUT, 'sample.webp')
frames[0].save(webp_path, save_all=True, append_images=frames[1:], duration=400, loop=0, format='WEBP')

apng_path = os.path.join(OUT, 'sample-apng.png')
frames[0].save(apng_path, save_all=True, append_images=frames[1:], duration=400, default_image=False)

for p in (gif_path, webp_path):
    with Image.open(p) as im:
        # n_frames 是 Pillow 自己读回的帧数，先自证夹具确实是多帧
        print(f"{os.path.basename(p)}: format={im.format} size={im.size} n_frames={getattr(im, 'n_frames', 1)} bytes={os.path.getsize(p)}")
