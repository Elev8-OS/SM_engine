# Video clips in reels

A reel item can be a video segment instead of a photo:

```json
{
  "hook": "Walk through Villa Samalas.",
  "photos": [
    { "video": { "url": "https://...sharepoint.com/...download.aspx?...", "start": 12.5, "focus": 0.5 } },
    { "video": { "url": "https://...", "start": 40 }, "line": "Open living, pool and garden." },
    { "url": "https://.../pool.jpg", "line": "Rice field views." }
  ]
}
```

- `start`: second where the clip begins. The clip runs for the slot length (2.7 s by default, 2.5 s for the hook) plus the crossfade.
- `focus`: 0 to 1, where the vertical crop sits horizontally in a landscape video (0 left, 0.5 centre, 1 right).
- A 16:9 or 4K landscape video is cropped to 9:16 and scaled to 1080x1920. The original sound is removed.
- The video URL must be https and its host must be listed in `VIDEO_HOSTS` (default `sharepoint.com`). Use the temporary download URL of the SharePoint file (`@microsoft.graph.downloadUrl`).
- The renderer seeks to `start` before reading, so only the needed part of a large file is fetched, as long as the server supports HTTP range requests.

Local test with a file: `node test/video.js /path/to/video.mp4`.
