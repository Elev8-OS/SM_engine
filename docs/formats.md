# Formats

| Format | Endpoint | Output |
|---|---|---|
| Reel | `POST /render/reel` | MP4, 1080x1920, about 14 s |
| Single image post | `POST /render/carousel` with one slide | JPG, 1080x1350 (4:5) |
| Carousel | `POST /render/carousel` with 2 to 10 slides | JPGs, 1080x1350 (4:5) |
| Story | `POST /render/carousel` with `"format": "story"` | JPGs, 1080x1920, text lifted above the bottom 340 px |

Example story:

```json
{ "format": "story", "slides": [{ "photo": { "url": "https://.../pool.jpg" }, "headline": "Which villa for 8 friends?", "cta": "See villas" }] }
```
