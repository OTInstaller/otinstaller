# Find earlier copies

Most misleading images are real photos from another time or place. Finding the earliest copy usually settles it.

## Search

```
ot run osintverse-community/reverse-image-links --url "https://upload.wikimedia.org/wikipedia/commons/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg" --format table
```

Open the links one by one. Each engine has strengths:

- **Google Lens**: objects, products, landmarks, text in the image.
- **Yandex**: faces and places, especially in Eastern Europe and Central Asia.
- **Bing**: a good general second opinion.
- **TinEye**: sort by *oldest* to find the first appearance.
- **SauceNAO** and **IQDB**: artwork, anime and illustrations.

Crop to the interesting part (a building, a sign) and search again if the whole image gives nothing.

## Compare

When you find a candidate original, check it is really the same picture:

```
ot run osintverse-community/image-hash --url "https://example.org/candidate.jpg" --compare "https://example.com/suspect.jpg"
```

A pHash distance of 8 or less means the same photo, even if resized or recompressed. A larger distance with the same
scene suggests a different shot from the same place or an edit; compare them side by side.

Next: [place and time](04-place-and-time.md).
