# Karuta Demo

60 popular tracks curated from `index.xlsx`, mixing familiar anime classics and recent hits. Each match randomly draws 12, 18, or 30 distinct cards. Rooms support 2-8 participants plus spectators on Cloudflare Durable Objects. The curated IDs live in `scripts/prepare_assets.py`.

## Run

```sh
npm install
npm run build
npm run preview
```

Open http://127.0.0.1:8787 in separate browser profiles. Choose a nickname and enter as a participant or spectator. The default nickname opens a rename dialog. New arrivals during the starting countdown or an ongoing match automatically join as spectators, regardless of the role selected before entry. Existing participants reconnecting within the grace period keep their role. Spectators do not occupy the eight participant seats. Roles can change in the waiting room or after a match, subject to seat availability.

With at least two participants, everyone being online and ready starts a 10-second countdown automatically. Cancelling readiness, changing participant membership or settings, or disconnecting cancels the countdown; it restarts when the conditions are met again. The host chooses 12/18/30 cards, a 30/60-second round limit, and whether card captions show work names. These settings apply to the whole room. There is no manual start button.

The host can switch between solo scoring and free teams in the lobby. Team mode supports up to eight teams, including empty teams, within the eight-player limit. Participants can create and join a team or join an existing one. The host can add empty teams, delete empty teams, move individual players, and repeatedly shuffle everyone evenly across the existing teams (team sizes differ by at most one). Team members and the host can rename teams. All participants must be assigned, at least two teams must have members, and everyone must be ready to start; unused empty teams do not block the match. Grouping or team changes clear readiness and cancel a pending start.

In team mode, a correct claim scores +1 for the team; an incorrect claim scores -1 and locks the entire team for that round. Further submissions from locked teammates cannot incur more penalties. SKIP only locks the player who used it. Individual scores track contributions, while team scores determine the winners, including ties. Teams cannot change during play; reconnection preserves membership and locks, and leaving does not remove earned points. Results retain team names and member contributions as they were during the match, even if the next lobby is rearranged. Resetting preserves the mode and groups while clearing scores. TPZ intros remain personal in both modes.

Each match adds one off-board song for every six cards: 12+2, 18+3, or 30+5 rounds. These decoys are distinct songs outside the initial board, shuffled into the playback queue. The last round is reserved for a real card so the board never empties before all decoys play. Correct claims score +1; wrong claims score -1 and lock that participant for the round. First correct claim received by the server wins. Every participant, including the host, has the same SKIP action: no score change, but no further claims that round. Once all online participants have either skipped or answered incorrectly, the round reveals immediately. Earlier penalties are retained. Real answers are removed even if nobody scores; decoys never remove cards. The host can reset the entire match but cannot force a round skip.

Audio preloads during the initial 10-second countdown and subsequent 3-second countdowns, and seeks against the server clock for late loads and reconnections. The selected 30/60-second duration limits playback. Card positions remain fixed. Mobile boards use six columns with card heights capped to fit the entire match board and its controls within a viewport, including two-line work captions. Final standings are stored separately from room membership.

The optional random-start variant defaults to off. When enabled by the host, each round (including decoys) starts at a server-selected integer offset from 0 through 10 seconds and plays for up to 30 seconds. The 60-second duration is unavailable in this variant because the source clips contain only 60 seconds. Every participant and spectator hears the same segment; reconnecting or joining late seeks to that offset plus the elapsed round time. Changing the variant clears readiness and cancels a pending start. Resetting a match preserves the variant setting; disabling it leaves the duration at 30 seconds, with 60 seconds available again.

Participants whose nickname contains consecutive `TPZ` letters (case-insensitive), after converting Chinese characters to pinyin initials with `pinyin-pro`, hear `public/audio/tpz-intro.mp3` before the song on the first round of each match, then independently with 20% probability per subsequent round. Mixed Chinese/Latin names are supported; spaces, digits, and punctuation remain separators, and polyphonic characters use the library's contextual pronunciation. The server persists each round's decision. Only the matching participant hears the intro; spectators are excluded. The intro consumes the shared round time without extending the deadline, then the song begins at the configured audio offset. Reconnection resumes the combined timeline, and revealing or resetting stops both clips.

Explicitly leaving frees the seat immediately. Detected disconnections have a 15-second reconnection grace period, shown in the room. Reconnecting during that period preserves the seat and round lock. A silent connection is detected after 90 seconds without a heartbeat, then receives the same grace period; backgrounding alone does not trigger immediate removal. Temporary disconnection of everyone does not immediately reset the match. Expired players cannot rejoin an ongoing match as participants, but can spectate. Existing persisted matches finish their original queue without retroactively inserting decoys.

## Assets

```sh
python -m pip install openpyxl pillow
npm run assets
```

The converter builds 336x480 WebP covers and `src/songs.json`, preserving references to generated audio clips. Source image filenames match the workbook IDs: 122 is Tamako Market and 123 is Blood Blockade Battlefront. Cover URLs carry content revisions to invalidate old browser caches when images change. Source music is left untouched. To verify and process a local music folder:

```sh
python -m pip install imageio-ffmpeg mutagen
python scripts/prepare_audio.py "path/to/music" --check-only
python scripts/prepare_audio.py "path/to/music"
```

The audio script requires one unique match per song and at least 60 seconds per source, then generates 44.1 kHz stereo MP3 at 96 kbps with loudness normalization and source metadata removed. Outputs are in `public/audio`; the source mapping, durations and sizes are recorded in `output/audio-report.json`. Re-run `npm run build` after processing. Some supplied files are TV edits or mixes, recorded by their original filenames in the report.

During matches, audio uses a random per-round URL that expires on reveal or cancellation. The Worker streams bytes without redirecting to the public song ID, and excludes identifying response headers. Target IDs, future song queues, and decoy flags are not broadcast before reveal. This prevents reading the answer directly from the match audio URL; it does not prevent fingerprinting or early playback of preloaded audio. The public library still provides named previews, so this remains a casual game rather than a cheat-proof competitive platform.

## Deploy

```sh
npx wrangler whoami
npm run deploy
```

Wrangler deploys static assets and the room Worker together, including its SQLite Durable Object migration. No R2, D1, or account system is required for this demo. Round state is persisted, alarms drive transitions, and WebSockets support hibernation. Reconnection uses a per-tab secret, whose SHA-256 digest is the public player ID. This demo does not implement ranked matchmaking or latency compensation.
