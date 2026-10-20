# geo-links

Takes coordinates in decimal or degrees-minutes-seconds form and gives you links to the same spot on OpenStreetMap, Google Maps, Earth and Street View, Bing aerial, Apple Maps, Mapillary street photos, the Copernicus satellite archive, Wikimapia, Overpass Turbo and SunCalc. Runs offline.

```
ot run osintverse/geo-links --coordinates "48°51'30\"N 2°17'40\"E"
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `coordinates` | yes | "lat,lon" in decimal degrees, or degrees-minutes-seconds |

## Notes

Use the satellite archive to date a photo by construction or seasons, and SunCalc to check a time of day against shadow directions.

## Next steps

Get coordinates from a photo with [osintverse/exif-meta](https://otinstaller.com/osintverse/exif-meta).

## Development

```
pip install # no dependencies
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
