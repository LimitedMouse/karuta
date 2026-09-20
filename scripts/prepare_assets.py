import hashlib
import json
from pathlib import Path

import openpyxl
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
target = ROOT / 'public' / 'covers'
target.mkdir(parents=True, exist_ok=True)
(ROOT / 'src').mkdir(exist_ok=True)
images = {int(p.stem): p for p in (ROOT / 'img').iterdir() if p.stem.isdigit()}
# Curated for familiarity among Chinese anime fans, mixing classics and recent hits.
POPULAR_IDS = {
    5, 10, 16, 25, 26, 28, 29, 30, 32, 34,
    35, 39, 43, 46, 47, 50, 53, 54, 55, 57,
    58, 60, 64, 66, 67, 69, 70, 74, 80, 81,
    82, 85, 86, 88, 94, 97, 101, 102, 106, 111,
    113, 114, 115, 117, 123, 129, 133, 134, 136, 142,
    151, 156, 206, 209, 210, 224, 271, 272, 273, 282,
}
rows = [row for row in list(openpyxl.load_workbook(ROOT / 'index.xlsx', data_only=True).active.values)[2:]
        if row[0] in POPULAR_IDS]
if len(POPULAR_IDS) != 60 or len(rows) != 60 or {row[0] for row in rows} != POPULAR_IDS:
    raise ValueError('Expected exactly 60 unique popular songs in the workbook')
songs = []
original = 0
for number, character, title, work, kind in rows:
    if number == 60:
        title = '光るなら'
    source = images[number]
    original += source.stat().st_size
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image).convert('RGB')
        image.resize((336, 480), Image.Resampling.LANCZOS).save(target / f'{number}.webp', 'WEBP', quality=78, method=6)
    audio = f'/audio/{number}.mp3' if (ROOT / 'public/audio' / f'{number}.mp3').is_file() else None
    revision = hashlib.sha256((target / f'{number}.webp').read_bytes()).hexdigest()[:12]
    cover = f'/covers/{number}.webp?v={revision}'
    songs.append(dict(id=number, character=(character or '').strip(), title=title.strip(), work=work.strip(), kind=kind.strip(), cover=cover, audio=audio))
(ROOT / 'src' / 'songs.json').write_text(json.dumps(songs, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
compressed = sum((target / f'{song["id"]}.webp').stat().st_size for song in songs)
print(f'{len(songs)} songs; covers: {original:,} -> {compressed:,} bytes ({100 * (1 - compressed / original):.1f}% smaller)')
