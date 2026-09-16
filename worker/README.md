# Mobile R2 Image Uploader

This Worker receives an image from an iPhone Shortcut, writes it to Cloudflare R2, and returns a Markdown image link.

## Deploy

Edit `worker/wrangler.jsonc` first:

- `r2_buckets[0].bucket_name`: your R2 bucket, for example `quiet-edge-images`
- `PUBLIC_BASE_URL`: the fixed public image domain, for example `https://img.example.com`

Current configured values:

- R2 bucket: `freetu`
- Public image base URL: `https://images.example.com`
- Worker upload URL: `https://blog-image-uploader.your-subdomain.workers.dev`

Set the upload token as a Worker secret:

```sh
cd worker
npx wrangler secret put UPLOAD_TOKEN
```

Deploy:

```sh
cd worker
npx wrangler deploy
```

The Worker returns JSON shaped like this:

```json
{
  "key": "images/2026-05-16-ab12cd34-mobile-cafe-menu.jpg",
  "url": "https://img.example.com/images/2026-05-16-ab12cd34-mobile-cafe-menu.jpg",
  "markdown": "![mobile cafe menu](https://img.example.com/images/2026-05-16-ab12cd34-mobile-cafe-menu.jpg)"
}
```

## iPhone Shortcut

Create a Shortcut with these actions:

1. Select Photos
2. Convert Image
   - Format: `JPEG`
   - Preserve Metadata: off, unless you explicitly want EXIF data
3. Get Contents of URL
   - URL: `https://blog-image-uploader.your-subdomain.workers.dev`
   - Method: `POST`
   - Headers:
     - `Authorization`: `Bearer <UPLOAD_TOKEN>`
   - Request Body: `Form`
   - Form field:
     - Name: `file`
     - Type: `File`
     - Value: converted image
4. Get Dictionary Value
   - Key: `markdown`
5. Copy to Clipboard
6. Show Notification
   - Text: `Markdown image link copied`

After running it, paste the clipboard into a Markdown post.

## Local Test

```sh
npm run test:worker
```
