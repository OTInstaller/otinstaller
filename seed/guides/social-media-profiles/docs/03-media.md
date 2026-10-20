# Videos, images and their metadata

## Videos and channels

```
ot run osintverse-community/yt-dlp --url "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

yt-dlp prints the metadata the site holds for a video (or the first 20 videos of a channel or playlist): title,
description, upload date and time, uploader and channel ID, duration, view and like counts, tags, chapters,
thumbnails and, where the site has them, location and subtitles. Nothing is downloaded.

## Image posts and galleries

```
ot run osintverse-community/gallery-dl --url "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_Wikimedia_Commons.jpg"
```

gallery-dl lists the files of a post, album or profile (the first 20) with the post metadata and the URL of each
original file. Feed those URLs to [osintverse-community/exif-meta](https://otinstaller.com/osintverse-community/exif-meta) and the
[image playbook](https://otinstaller.com/guides/osintverse-community/image-geolocation).

## IDs hidden in URLs

Post and share URLs often encode IDs and timestamps:

```
ot run osintverse-community/unfurl --url "https://twitter.com/x/status/1234567890123456789"
```

For X (Twitter), Discord and other platforms that use snowflake IDs, unfurl decodes the exact creation time from the
ID, even for deleted posts you only have a link to.

Next: [preserve](04-preserve.md).
