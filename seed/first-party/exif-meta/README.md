# exif-meta

Downloads an image or document (up to 25 MB) and reads all of its metadata with [ExifTool](https://exiftool.org): GPS coordinates, camera make, model and serial number, editing software, author and copyright fields, and when it was taken and changed.

```
ot run osintverse-community/exif-meta --url https://example.com/photo.jpg
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `url` | yes | URL of the image or document |

## Notes

Most social networks strip metadata on upload, so originals from websites, cloud shares and email attachments are more useful. The file is downloaded into the container's temporary storage and deleted when the run ends. The full ExifTool output is in the `metadata` field of the raw result.

## Next steps

Open the coordinates with [osintverse-community/geo-links](https://otinstaller.com/osintverse-community/geo-links) and look for other copies with [osintverse-community/reverse-image-links](https://otinstaller.com/osintverse-community/reverse-image-links).

## Development

```
pip install # no dependencies
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
