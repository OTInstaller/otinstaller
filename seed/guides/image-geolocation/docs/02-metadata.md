# Read the metadata

Cameras and phones write a lot into the file: GPS coordinates, the device, the software that edited it, and several
timestamps.

```
ot run osintverse-community/exif-meta --url "https://raw.githubusercontent.com/ianare/exif-samples/master/jpg/gps/DSCN0010.jpg"
```

The result has a `location` entity when GPS is present (with an OpenStreetMap link), the device, the authors and the
dates. The full ExifTool output is in `metadata`.

## What to check

| Field | Why |
| --- | --- |
| GPS latitude and longitude | The capture position, if the phone had location on. Check it against the content of the picture; it can be edited. |
| `DateTimeOriginal` vs `ModifyDate` | When it was taken vs last saved. A large gap means it was edited or re-exported. |
| `Software`, `CreatorTool` | Editing software (Photoshop, Snapseed) or a messaging app that re-encoded it |
| `Make`, `Model`, `SerialNumber` | The device; the same serial on two images means the same camera |
| `Artist`, `Copyright`, `Creator` | Authors, often a photographer or agency |

> [!NOTE]
> Facebook, Instagram, X, WhatsApp and most other platforms strip metadata on upload. Look for originals: the
> photographer's website, cloud shares, forum attachments, documents. `gallery-dl` can fetch the original files of many
> gallery and social sites:
> `ot run osintverse-community/gallery-dl --url "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_Wikimedia_Commons.jpg"`

Next: [find earlier copies](03-copies.md).
