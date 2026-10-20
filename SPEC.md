# Compress Image to Exact KB — specification

**Tagline:** Shrink a photo to a target size like 50, 100 or 200 KB in your browser, with no upload.

**Category:** Images

**Free alternative to:** iLoveIMG Compress Image and ReduceImages (uploads photos to its servers, ads, daily limits and sign-up prompts for batches, no exact target size)

**Search phrases:** compress image to 100kb, reduce image size in kb, compress jpg to 50kb, resize photo to 200kb, image size reducer online, compress photo for form upload, reduce jpeg file size without losing quality

**Allowed libraries:** none (browser APIs only)

**Published at:** https://turhe123.github.io/compress-image-to-kb/

## Acceptance checks (each must have a test)

- Loading the bundled sample photo of about 3 MB with the 100 KB target produces a downloadable JPEG whose size is at most 100 KB and larger than 20 KB
- The result panel shows original size, new size, percent saved and the final quality and dimensions used
- Switching the target to 50 KB and pressing compress again yields a file under 50 KB
- Dropping a text file shows a clear unsupported file message and no download button
- Preview before and after is visible and the layout works at 390px wide
- Downloaded filename follows the pattern name-100kb.jpg

## Spec

People type phrases like compress image to 100kb into search engines constantly because government portals, job applications, exam forms, visa sites and email systems reject photos above a fixed size, usually between 20 and 500 KB. The popular incumbents, such as iLoveIMG, ReduceImages and similar compressor sites, ask you to upload your passport photo or ID scan to a remote server, show ads, cap batch counts, and mostly offer only a vague quality slider so you have to guess repeatedly until the file fits. Our version does exactly one job: hit a chosen file size, entirely on the device, with nothing uploaded and no account.

Feature set: drop or pick one or many JPG, PNG, WebP or HEIC-free standard browser images. Choose a target size from presets of 20, 50, 100, 200, 500 KB and 1 MB, or type a custom number in KB or MB. The tool searches automatically for the highest quality that fits under the target, and if quality alone cannot get there it reduces dimensions in small steps, never below a user-set minimum width. Output format options are JPEG (default, best for size targets), WebP, or keep original type PNG input is flattened onto a white background when converted to JPEG, with a background colour option. A lock for maximum width or height is optional. Batch mode processes several files and offers each download plus a zip-free sequential download all button.

UI: above the fold is a large drop zone with the text Drop photos here, then a row with the target size chips and a custom field, a format select and an advanced disclosure holding minimum width, background colour and strip metadata toggle (on by default, so GPS data is removed, which is a privacy benefit worth stating). After processing, each file appears as a card with a before and after thumbnail, original size, new size, percent saved, final quality and pixel dimensions, and a Download button. If the target cannot be reached even at the minimum width, the card says so plainly and offers the smallest achieved result. Empty state shows a sample photo link to try. Errors cover unsupported types, decode failures and zero byte files. Keyboard use: the drop zone is a focusable button that opens the file picker with Enter or Space, chips are radio buttons, and Ctrl or Cmd plus V pastes an image from the clipboard. Download names are the original base name plus a dash, the target and the extension, for example passport-100kb.jpg.

Technical approach: decode with createImageBitmap using the imageOrientation from-image option so EXIF rotation is applied, draw to an OffscreenCanvas (fall back to a regular canvas on older Safari), and encode with convertToBlob or toBlob. The size search is a binary search on quality between 0.05 and 0.95 with about seven iterations, which is cheap. If even the lowest acceptable quality of 0.4 exceeds the target, scale dimensions by 0.9 per round and repeat the search, stopping at the minimum width. Work runs in a Web Worker when OffscreenCanvas is available, otherwise on the main thread with yields between files so the page stays responsive. Canvas re-encoding drops all metadata including EXIF and GPS, which matches the strip option the toggle to keep metadata is deliberately not offered to stay simple. Object URLs are revoked after download to limit memory. No library is required.

Edge cases: very large photos above 40 megapixels may exceed mobile Safari canvas limits, so downscale to at most 16 megapixels before the first encode and tell the user. Animated GIFs and WebP are flattened to the first frame with a notice. Transparent PNGs get the chosen background colour when output is JPEG. If the original is already smaller than the target the tool says so and offers the original unchanged rather than inflating it. Non-ASCII filenames are preserved. Very small targets such as 10 KB on a large image will force heavy downscaling, and the card shows the final dimensions so the user understands.

Demo data: a bundled generated sample photo, a synthetic gradient landscape with a fictional lighthouse named Harbor Point, about 3000 by 2000 pixels, and a second tiny PNG logo for the transparency case. Use the fictional file names harbor-point.jpg and demo-logo.png.
