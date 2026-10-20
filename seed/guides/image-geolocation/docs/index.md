# Image verification and geolocation playbook

Given a photo, answer three questions: is it what it claims to be, where was it taken, and when?

**Steps**

1. [Scope and legal](01-scope-and-legal.md)
2. [Read the metadata](02-metadata.md)
3. [Find earlier copies](03-copies.md)
4. [Place and time](04-place-and-time.md)

**Tools used** (`ot guide tools osintverse-community/image-geolocation`):

| Tool | Used for |
| --- | --- |
| [osintverse-community/exif-meta](https://otinstaller.com/osintverse-community/exif-meta) | EXIF, XMP and IPTC metadata: GPS, camera, software, dates |
| [osintverse-community/reverse-image-links](https://otinstaller.com/osintverse-community/reverse-image-links) | Reverse image search on seven engines |
| [osintverse-community/image-hash](https://otinstaller.com/osintverse-community/image-hash) | Comparing copies with perceptual hashes |
| [osintverse-community/geo-links](https://otinstaller.com/osintverse-community/geo-links) | Maps, satellite history, street-level photos and sun position for a spot |
| [osintverse-community/gallery-dl](https://otinstaller.com/osintverse-community/gallery-dl) | Original files and post metadata from galleries and social sites |

The examples use a public Wikimedia Commons photo of the Eiffel Tower and a sample camera image from the ExifRead test
set.
