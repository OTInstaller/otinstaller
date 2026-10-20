# reverse-image-links

Gives you ready-made reverse image search links for one image URL on Google Lens, Bing Visual Search, Yandex, TinEye, Baidu, SauceNAO and IQDB. It only builds the links, so it runs offline and nothing is uploaded until you open them.

```
ot run osintverse/reverse-image-links --url https://example.com/a.jpg --format table
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `url` | yes | URL of the image |
| `engines` | no | Comma-separated engines, such as yandex,tineye |

## Notes

Engines differ a lot: Yandex is strongest on faces and places in Eastern Europe, TinEye sorts by first appearance, and SauceNAO and IQDB cover artwork. Opening a link sends the image URL to that engine.

## Next steps

Compare the matches you find with [osintverse/image-hash](https://otinstaller.com/osintverse/image-hash).

## Development

```
pip install # no dependencies
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
