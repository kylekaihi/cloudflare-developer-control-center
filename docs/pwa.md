# Dashboard PWA

The Developer Control Center can be installed from Chromium browsers and from Safari's **Add to Home Screen** flow.

## Offline and privacy behavior

- The Service Worker caches only the Dashboard shell, manifest, icons, offline page, and same-origin hashed `/_astro/*` build assets already loaded by the page.
- `/dashboard/api/*` is always network-only. VPS metrics, incidents, Access assertions, and API responses are never written to Cache Storage.
- An offline API request receives a local `503` JSON response so the UI can show a clear offline state.
- Navigation falls back to the cached Dashboard shell and then to the dedicated bilingual offline page.

## Updates

New Service Worker versions install in the background. The running app shows an update notice and activates the new version only after the operator selects **Update now**. This avoids refreshing the Dashboard unexpectedly during an incident.

## Install assets

The manifest includes 192 px, 512 px, maskable, scalable SVG, and 180 px Apple touch icons. Mobile layouts include safe-area handling for notches and the standalone bottom navigation.
