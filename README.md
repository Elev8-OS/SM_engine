# SM_engine

Render service for The R Villas Bali social media. It turns photos and short texts into
finished files, ready to be uploaded to GoHighLevel (GHL) as drafts:

- **Photo reels** (9:16, 1080x1920, about 14 s): hook, panning photos with crossfades, end card.
- **Carousel slides** (4:5, 1080x1350 JPG): photo with a text band, optional CTA button.

The service only renders. Strategy, copywriting and the GHL draft are handled by the
automation (Make) that calls it.

## API

All endpoints except `/health` need the header `x-api-key: <API_KEY>`.

### `POST /render/reel`

```json
{
  "hook": "Wake up to rice fields.",
  "subhook": "Villa Patuha · Pererenan, Bali",
  "photos": [
    { "url": "https://.../hero.jpg" },
    { "url": "https://.../pool.jpg", "line": "Pool. Rice fields. Nothing in between." },
    { "base64": "...", "line": "3 en-suite bedrooms.", "sub": "240 m² · up to 8 guests" }
  ],
  "endCard": { "title": "Book direct. Best rate guaranteed.", "subtitle": "Skip the middleman.", "cta": "Link in bio" },
  "music": "optional-track-name",
  "secondsPerPhoto": 2.7
}
```

- The first photo carries the hook. 2 to 8 photos.
- With S3 storage configured the answer is `{ "url", "durationSeconds", "music" }`.
  Without it (or with `?return=file`) the MP4 itself is returned.
- Text stays inside the safe zone (top 250 px and bottom 340 px stay free for the app UI).

### `POST /render/carousel`

```json
{
  "slides": [
    { "photo": { "url": "https://.../hero.jpg" }, "headline": "Wake up to rice fields.", "sub": "Villa Patuha · Pererenan, Bali" },
    { "photo": { "url": "https://.../dining.jpg" }, "headline": "3 en-suite bedrooms.", "focus": "left" },
    { "photo": { "url": "https://.../hero.jpg" }, "headline": "Pick your dates. We'll hold the villa.", "cta": "Link in bio", "darken": true }
  ]
}
```

Returns `{ "slides": [{ "name": "01.jpg", "url" | "base64" }] }`.

### Photo sources

Each photo is `{ "url" }` (https only) or `{ "base64" }`. SharePoint links need a login,
so let Make download the file with its own connection and pass it as base64.
Optional `ALLOWED_PHOTO_HOSTS` restricts the hosts. Private addresses are blocked.

## Configuration

See `.env.example`. `API_KEY` is mandatory, the service refuses requests without it.

| Variable | Purpose |
|---|---|
| `API_KEY` | Shared secret for the `x-api-key` header |
| `ALLOWED_PHOTO_HOSTS` | Optional host allow list |
| `MAX_CONCURRENT` | Parallel renders (default 1) |
| `S3_*` | Optional S3 bucket (Railway bucket). Presigned links are valid for 7 days |

Music: add royalty-free `.mp3` files to `assets/music/` (see the README there).
Without tracks, reels are silent.

## Run

```bash
npm install
API_KEY=dev npm start
npm test        # renders a sample reel and carousel into ./out
```

FFmpeg must be installed locally. The Dockerfile installs FFmpeg and the Inter font.

## Deploy on Railway

Create a service from this repo (the Dockerfile is used), set `API_KEY`, optionally attach a
bucket and set the `S3_*` variables, then generate a domain.

## Roadmap

- Upload straight into the GHL media library (stable URLs instead of 7-day links).
- Footage clips (video input) next to photo reels.
- Fact table and photo catalogue as inputs for the daily automation.
