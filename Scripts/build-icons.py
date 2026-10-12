#!/usr/bin/env python3
"""Export the approved artwork to the iPad and Mac app-icon asset slots."""
from pathlib import Path
import json
import subprocess

root = Path(__file__).resolve().parent.parent
source = root / 'Artwork/app-icon-source.png'
catalog = root / 'App/Assets.xcassets'
icons = catalog / 'AppIcon.appiconset'
icons.mkdir(parents=True, exist_ok=True)
images = []
for idiom, sizes in [('ipad', [20, 29, 40, 76]), ('mac', [16, 32, 128, 256, 512])]:
    for size in sizes:
        for scale in [1, 2]:
            images.append(dict(idiom=idiom, size=f'{size}x{size}', scale=f'{scale}x',
                               filename=f'icon-{size * scale}.png'))
images += [dict(idiom='ipad', size='83.5x83.5', scale='2x', filename='icon-167.png'),
           dict(idiom='ios-marketing', size='1024x1024', scale='1x', filename='icon-1024.png')]
for filename in sorted({image['filename'] for image in images}):
    pixels = filename.removeprefix('icon-').removesuffix('.png')
    subprocess.run(['sips', '-z', pixels, pixels, str(source), '--out', str(icons / filename)],
                   check=True, stdout=subprocess.DEVNULL)
info = dict(author='xcode', version=1)
(icons / 'Contents.json').write_text(json.dumps(dict(images=images, info=info), indent=2) + '\n')
(catalog / 'Contents.json').write_text(json.dumps(dict(info=info), indent=2) + '\n')
print(f'Exported {len(images)} icon slots from {source.name}.')
