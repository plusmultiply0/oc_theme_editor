# Findings

Image: local wallpaper file (1709733 bytes); path supplied via OPENCODE_THEME_IMAGE.
Electron installation: %LOCALAPPDATA%\Programs\@opencode-aidesktop.
Running app. resources/app.asar is 143757523 bytes; renderer CSS is out/renderer/assets/main-C-FJvlHS.css.
Upstream issue 40177 reports missing desktop CSS override hook. Local implementation needs inspection.
Existing root plan concerns unrelated Relax work and is preserved.

Local package version is 1.18.29. CSS has both legacy and v2 semantic tokens. The original image is 2800x1200; dominant sampled colors include #404558, #787e9f, #a0a7c9, #abb1d0. Electron embedded ASAR integrity enforcement is already disabled by the distributor; no executable/fuse changes are required or permitted by this patch. The image is copied byte-for-byte into the archive. Only index.html and two new assets change; all existing JavaScript and unpacked files remain unchanged.

Reusable skill scope: image-theme-styler. Portable palette helper emits JSON; stage-only ASAR helper refuses output inside the installation and enabled integrity enforcement. No automatic installation, personal paths, original image or backup included. Synthetic tests use new OS temporary directories only. Initial skill directory creation was denied by read-only sandbox; created exact requested directories after explicit tool approval, then wrote files with apply_patch.

New requested image 314827.jpg: bright indoor Arknights illustration; warm gold lighting and creamy surfaces, charcoal clothing, small teal accents. Existing patch uses one snow-theme.css link and snow-background.jpg; replace these known asset bytes in place to avoid stacking conflicting themes. Existing version/hash and current processes require fresh verification.

Verified version 1.18.29 and hash 55ea3a45... unchanged; no desktop processes from privileged read. Original backup hash verified. Palette: #996d45, #d1a770, #1c1b1a, #daceac, #f6e3c1, #65584a, #ab946d, #463228. New image SHA256 80fbd6a98935542dd2ac45bc98b2f9f1a8e40c47a76200ef29856f82742dad7b, 4106x2310. Helper ran successfully with nonblocking Pillow getdata deprecation warning. Initial faint-text contrast at 68% wash was below target; increased minimum wash to 72%, lightened faint/link colors, darkened active raised panel. Native UI still needs user review.
