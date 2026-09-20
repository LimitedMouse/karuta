import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import unicodedata

import imageio_ffmpeg
from mutagen import File

ROOT = Path(__file__).resolve().parents[1]
ALIASES = {
    16: 'You (Vocal Version)', 101: 'YOASOBI - 怪物',
    39: 'bios', 55: 'ふわふわ时间', 60: '光るなら',
    82: 'CHA-LA HEAD-CHA-LA', 94: '紅蓮華', 134: '白金ディスコ',
    151: '運命のルーレット廻して', 156: '回レ', 271: 'ウィーアー',
    273: '世界が終るまでは',
}


def normalized(value):
    value = unicodedata.normalize('NFKC', value).casefold().replace('β', 'b')
    return ''.join(c for c in value if c.isalnum())


def main():
    parser = argparse.ArgumentParser(description='Match and compress the first 60 seconds of the curated songs.')
    parser.add_argument('source', type=Path)
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    songs = json.loads((ROOT / 'src/songs.json').read_text(encoding='utf-8'))
    files = sorted(p for p in args.source.iterdir() if p.suffix.lower() in {'.mp3', '.flac', '.m4a', '.ogg', '.wav'})
    matches = []
    used = set()
    for song in songs:
        needle = normalized(ALIASES.get(song['id'], song['title']))
        candidates = [p for p in files if needle in normalized(p.stem)]
        if len(candidates) != 1:
            raise ValueError(f'{song["id"]}: {song["title"]}: expected one match, found {candidates}')
        source = candidates[0]
        if source in used:
            raise ValueError(f'Duplicate source: {source}')
        used.add(source)
        duration = File(source).info.length
        if duration < 60:
            raise ValueError(f'{source.name}: only {duration:.2f}s, requires at least 60s')
        matches.append(dict(id=song['id'], title=song['title'], source=source.name,
                            source_seconds=round(duration, 3), source_bytes=source.stat().st_size))
    unmatched = [p.name for p in files if p not in used]
    print(f'Matched {len(matches)}/{len(songs)} songs; unused files: {unmatched}', flush=True)
    if args.check_only:
        for match in matches:
            print(f'{match["id"]}: {match["title"]} <- {match["source"]} ({match["source_seconds"]}s)')
        return

    target = ROOT / 'public/audio'
    target.mkdir(parents=True, exist_ok=True)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

    def convert(match):
        output = target / f'{match["id"]}.mp3'
        result = subprocess.run([
            ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
            '-i', str(args.source / match['source']), '-map', '0:a:0', '-vn',
            '-t', '60', '-af', 'atrim=duration=60,loudnorm=I=-16:TP=-1.5:LRA=11',
            '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '96k',
            '-threads', '1', '-map_metadata', '-1', str(output),
        ], capture_output=True, text=True, encoding='utf-8', errors='replace')
        if result.returncode:
            raise RuntimeError(f'{match["source"]}: {result.stderr}')
        info = File(output).info
        if not 59.9 <= info.length <= 60.1:
            raise ValueError(f'Unexpected output duration: {output}: {info.length}')
        match.update(audio=f'/audio/{output.name}', output_seconds=round(info.length, 3),
                     output_bytes=output.stat().st_size, bitrate=info.bitrate)
        print(f'Converted {match["id"]}: {match["title"]}', flush=True)
        return match

    with ThreadPoolExecutor(max_workers=4) as pool:
        report = list(pool.map(convert, matches))
    by_id = {item['id']: item for item in report}
    for song in songs:
        song['audio'] = by_id[song['id']]['audio']
    (ROOT / 'src/songs.json').write_text(json.dumps(songs, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    report_path = ROOT / 'output/audio-report.json'
    report_path.parent.mkdir(exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    original = sum(item['source_bytes'] for item in report)
    compressed = sum(item['output_bytes'] for item in report)
    print(f'Complete: {len(report)} clips; {original:,} -> {compressed:,} bytes ({100 * (1 - compressed / original):.1f}% smaller)')


if __name__ == '__main__':
    main()
