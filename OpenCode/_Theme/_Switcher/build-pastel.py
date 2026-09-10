from pathlib import Path
import os
import re
import json
from PIL import Image

base = Path(__file__).parent
css = (base / 'arknights-theme.css').read_text(encoding='utf-8')
css = css.replace('color-scheme: dark', 'color-scheme: light').replace('--ark-', '--pastel-')
css = css.replace('snow-background.jpg', 'pastel-background.png')
rgb = {
 '36,29,25':'255,248,241', '70,50,40':'255,248,241',
 '58,44,34':'251,239,228', '153,109,69':'188,145,196',
 '171,148,109':'205,167,207', '28,27,26':'255,248,241',
 '66,51,40':'255,248,241', '209,167,112':'205,167,207',
 '218,206,172':'135,99,143', '80,66,56':'251,239,228',
 '24,21,18':'89,67,80', '50,40,32':'255,248,241',
 '24,23,22':'255,248,241', '201,154,96':'188,145,196',
 '95,139,128':'155,184,145',
}
for a,b in rgb.items(): css=css.replace('rgba('+a+',','rgba('+b+',')
colors = {
 '#463228':'#fbefe4', '#65584a':'#eedfeb', '#322820':'#fff8f1',
 '#46372b':'#fbefe4', '#564431':'#f7eada', '#d1a770':'#cda7cf',
 '#e4c28e':'#dfbedf', '#c99a60':'#bc91c4', '#996d45':'#87638f',
 '#241d19':'#000000', '#fff5e4':'#000000', '#ffffff':'#000000',
 '#f0e0c4':'#000000', '#eadcc4':'#000000', '#f6e3c1':'#000000',
 '#fff3db':'#000000', '#daceac':'#000000', '#e4d3b4':'#000000',
 '#a3c8be':'#52734b',
}
css=re.sub(r'#[0-9a-fA-F]{6}',lambda m:colors.get(m[0],m[0]),css)
css=re.sub(r'(--(?:text-(?:base|strong|weak|weaker|interactive-base|on-interactive-base|on-interactive-weak)|v2-text-text-[a-z-]+):) [^;]+;',r'\1 #000000 !important;',css)
css=css.replace('color: white','color: #000000')
css=css.replace('rgba(255,248,241,.76),rgba(255,248,241,.74) 46%,rgba(255,248,241,.72)',
 'rgba(255,248,241,.54),rgba(255,248,241,.52) 46%,rgba(255,248,241,.50)')
css=css.replace('/* Local Arknights warm-gold theme. Original image unchanged; no application logic modified. */',
 '/* Pastel wallpaper with black interface text. Original image bytes preserved. */')
css=css.replace('/* Image-derived warm palette: carry sampled image colors through interactive UI states. */',
 '/* Lavender and peach interactive states sampled from the supplied artwork. */')
css+='''
/* Additional verified text tokens, including input placeholders and inverted labels. */
html, body, #root {
  --text-stronger: #000000 !important;
  --text-link-base: #000000 !important;
  --text-invert-base: #000000 !important;
  --text-invert-strong: #000000 !important;
  --text-invert-stronger: #000000 !important;
  --text-invert-weak: #000000 !important;
  --text-invert-weaker: #000000 !important;
  --text-on-brand-base: #000000 !important;
  --text-on-brand-strong: #000000 !important;
  --text-on-brand-weak: #000000 !important;
  --text-on-brand-weaker: #000000 !important;
  --syntax-variable: #000000 !important;
  --syntax-punctuation: #000000 !important;
  --syntax-operator: #000000 !important;
  --syntax-comment: #4d454f !important;
  --syntax-keyword: #71376f !important;
  --syntax-string: #376536 !important;
  --syntax-constant: #754818 !important;
  --syntax-primitive: #754818 !important;
  --syntax-type: #354f81 !important;
  --syntax-property: #71376f !important;
  --syntax-object: #354f81 !important;
  --syntax-regexp: #754818 !important;
  caret-color: #000000;
}
input, textarea, [contenteditable="true"] { color: #000000 !important; }
input::placeholder, textarea::placeholder { color: #000000 !important; opacity: 1; }
'''
# Terminal colors are controlled by its renderer: preserve its existing dark canvas.
css=css.replace('[data-component="markdown-code"], [data-component="code"], .xterm {',
 '[data-component="markdown-code"], [data-component="code"] {')
(base/'pastel-theme.css').write_text(css,encoding='utf-8')

tool=(base/'arknights-tool.cjs').read_text(encoding='utf-8')
tool=tool.replace('80fbd6a98935542dd2ac45bc98b2f9f1a8e40c47a76200ef29856f82742dad7b','545a6e0a1aeb4ba28c7616a813ac199add7d7c674b17caf4b6d27db23921aa55')
tool=tool.replace('55ea3a45f84edf7528ad3c3c3f11d56868a94532f75a95d6735e0d4ca72ab1d5','7d36e0a78e2cd1aadd046230e38c0085313c4b87aee86f96e97c6914491fd7cd')
tool=tool.replace('arknights-theme.css','pastel-theme.css').replace('app.arknights.asar','app.pastel-v2.asar').replace('arknights-manifest.json','pastel-v2-manifest.json')
tool=tool.replace("assert.equal(image.toString('hex',0,3),'ffd8ff');", "assert.equal(image.toString('hex',0,8),'89504e470d0a1a0a');")
tool=tool.replace('snow-background.jpg','pastel-background.png')
tool=tool.replace('assert.equal(current.entries.size,after.entries.size);','assert.equal(current.entries.size + 1,after.entries.size);')
tool=tool.replace("'arknights-'+", "'pastel-'+").replace("theme:'snowfield-v2'", "theme:'arknights-warm-gold'")
tool=tool.replace("prev.themeRevision=3;prev.themeName='arknights-warm-gold'", "prev.themeRevision=4;prev.themeName='pastel-black-text'")
tool=tool.replace('restored-snow-theme','restored-arknights-theme').replace('Accepted snow wallpaper and palette restored','Previous Arknights wallpaper and palette restored')
(base/'pastel-tool.cjs').write_text(tool,encoding='utf-8')

def contrast(pixel):
    rgb=[v/255 for v in pixel]
    rgb=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb]
    return (sum(a*b for a,b in zip(rgb,[.2126,.7152,.0722]))+.05)/.05
im=Image.open(os.environ['OPENCODE_THEME_IMAGE']).convert('RGB')
# Conservative: least opaque point of the body mask, before any light panel overlays.
minimum=min(contrast(tuple(.50*c+.50*p for c,p in zip((255,248,241),pixel))) for pixel in im.getdata())
report={'text':'#000000','background':'#fff8f1','primary':'#cda7cf','hover':'#dfbedf','pressed':'#bc91c4',
 'min_black_text_contrast_over_all_image_pixels_with_50_percent_mask':round(minimum,3),
 'button_contrasts':{c:round(contrast(tuple(bytes.fromhex(c[1:]))),3) for c in ['#cda7cf','#dfbedf','#bc91c4']},
 'visual_ui_verified':False,'terminal':'Existing terminal renderer theme retained','syntax':'Base text black; syntax and status distinctions retained'}
assert minimum>=4.5
(base/'pastel-palette.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,indent=2))
