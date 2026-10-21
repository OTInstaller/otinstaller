# Place and time

When metadata and earlier copies don't give a location, the picture itself usually does.

## Narrow down the area

List what you can read or recognise: languages and scripts on signs, road markings, the side of the road traffic
drives on, plug sockets, licence plate formats, vegetation, architecture, shop chains. Each one cuts the possible
area.

## Check a candidate spot

Once you have coordinates (from GPS, a landmark, or a guess), get every view of the place:

```
ot run osintverse-community/geo-links --coordinates "48.8584,2.2945"
```

You get links to OpenStreetMap, Google Maps, Earth and Street View, Bing aerial, Apple Maps, Mapillary street
photos, the Copernicus satellite archive, Wikimapia, Overpass Turbo and SunCalc for that spot. Degrees, minutes and
seconds work too: `48°51'30"N 2°17'40"E`.

Match at least three independent features (a building outline, a road layout, a skyline) before you call a location
confirmed.

## Date it

- **Satellite history** (Copernicus Browser) shows when buildings went up or came down, and seasons.
- **SunCalc** draws the sun's direction for any date and time at the spot. Compare it with the shadows in the photo
  to estimate the time of day, or rule out a claimed time.
- **Street View history** shows the place at several dates, with shops and signs that change.

## Write it up

State the location and time with the evidence for each, how confident you are, and what you could not confirm.
