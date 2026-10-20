# image-hash

Downloads an image and computes its average, perceptual, difference, wavelet and colour hashes, plus the SHA-256 of the exact file. Perceptual hashes stay nearly the same when a picture is resized, recompressed or lightly edited, so they show whether two images are the same photo.

```
ot run osintverse/image-hash --url https://example.com/a.jpg --compare https://example.org/b.jpg
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `url` | yes | URL of the image |
| `compare` | no | URL of a second image to compare with |

## Notes

With `--compare`, the second image carries the Hamming distance for each hash; a pHash distance of 8 or less usually means the same picture. Crops and mirror images change the hashes a lot.

## Next steps

Search the web for copies with [osintverse/reverse-image-links](https://otinstaller.com/osintverse/reverse-image-links).

## Development

```
pip install ImageHash==4.3.2 Pillow==13.0.0
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
