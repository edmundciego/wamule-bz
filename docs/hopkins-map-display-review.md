# Hopkins map display review

## Observed source and browser rendering

Read-only inspection of the Hopkins public map response and the local candidate preview found:

- Desktop and phone both select Hopkins’s full masterplan image. The scoped response returns no phone preview URL, so no alternate image is selected.
- The loaded image URL is `https://kvocwmrcuhiaezlcgzjf.supabase.co/storage/v1/object/public/project-map-public/2cefb56f-b834-4d44-9177-e8abd8abc1c6/dde17305-2a89-4d58-8d59-c756880eba6b/fbc1ae08-ef46-4d80-85f5-8e3a8d049116/maps/hopkins-d82e5880371e8de7.webp`.
- Its response was `200 image/webp`, with `Content-Length: 1,868,498` bytes (about 1.78 MiB) and intrinsic dimensions of 5700 × 4800 pixels.
- The same URL and dimensions loaded at 1440px desktop and 390px phone widths. At 390px the map SVG measured 340 × 286 CSS pixels. At 320px the homepage map measured 270 × 227px and the application map 236 × 199px. These dimensions retain the source aspect ratio of 1.1875.
- The SVG background spans 100 × 84.210526 source-space units. The outline overlay uses the same normalized, aspect-corrected coordinate frame. The candidate changes only the initial viewBox to fit the valid outline bounds; the image URL, source image, geometry and identities are unchanged. Zoom-in changed the viewBox while keeping the background and polygons in the same SVG transform. Reset zoom returned to `0 0 100 84.21052631578948`, making the entire source plan accessible.
- The public response supplied 775 valid outlines. The active version identifier was not present in the current response, so `/version` reports it as unavailable rather than inferring it. The owner-provided staging baseline identifies this image as Hopkins masterplan version 1; Wamule’s inactive version 4 was not selected or touched.

The reduced display size at initial fit is downsampling of the full-resolution raster, not a 3000px source image. Native-size inspection remains available by zooming. There is no published Hopkins phone rendition or tile pyramid in the current response.

## Proposal only; not implemented

Keep the original raster and its coordinate frame immutable. For a later, separately reviewed enhancement:

1. Generate a static 256px or 512px WebP tile pyramid from the exact Hopkins version-1 source, keyed by source checksum and version. Keep the full source extent, orientation, color profile, and normalized outline coordinates identical.
2. Publish a phone fallback rendition capped at about 1600px on the long edge. Treat it as an overview image only; switch to tiles for close inspection. Measure its transfer size and compare its colors and labels against the original before publishing.
3. Select tiles or the fallback strictly from the same tenant/project/phase and active masterplan response. Retain the full-resolution source for desktop and reset/full-plan behavior.

No tiles or fallback were generated, uploaded, activated, or deployed during this work.
