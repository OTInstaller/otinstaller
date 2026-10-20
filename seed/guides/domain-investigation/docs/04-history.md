# History

Web archives keep pages the owner has since removed: old staff lists, product pages, documents, contact details.

## Every archived URL

```
ot run osintverse-community/gau --domain example.com
```

gau collects the URLs the Wayback Machine, AlienVault OTX and urlscan.io have seen for the domain, with images and
fonts left out. Look for:

- documents (`.pdf`, `.docx`, `.xlsx`): read their metadata with
  [osintverse-community/exif-meta](https://otinstaller.com/osintverse-community/exif-meta)
- parameters that leak structure (`?user=`, `/api/v1/`)
- paths that no longer exist on the live site

## Oldest and newest captures

```
ot run osintverse-community/waybackpy --url https://example.com --mode oldest
ot run osintverse-community/waybackpy --url https://example.com --mode newest
```

The oldest capture shows roughly when a site went live and what it was first about, which is useful for a
domain that changed owner. `--mode known-urls` lists everything archived under a URL.

## Unpacking URLs

Long tracking and search URLs often encode timestamps and IDs. `unfurl` decodes them:

```
ot run osintverse-community/unfurl --url "https://www.google.com/search?q=example&ei=Lp4pYNHzE4mn5NoP8pKTqAw"
```

Next: [look-alike domains](05-lookalikes.md).
