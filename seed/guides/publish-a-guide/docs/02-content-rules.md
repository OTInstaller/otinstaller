# Write within the content rules

## Markdown

- CommonMark and GitHub-flavoured Markdown: tables, task lists, fenced code with a language.
- Admonitions: start a quote with `[!NOTE]`, `[!TIP]` or `[!WARNING]`:

  > [!TIP]
  > Like this.

- Link between pages with relative links to the files: `[next step](02-headers.md)`. They become links on the site
  and work in `ot guide read`.
- Link to registry tools by their page, `https://otinstaller.com/namespace/name`, rather than to their source
  repositories, so readers get the version they can install.
- Raw HTML is shown as text. Scripts, iframes, forms and styles reject the release.

## Images

PNG, JPEG, WebP or SVG files in the repository, referenced by relative path: `![Headers in Gmail](img/gmail.png)`.
At most 2 MB each and 50 MB per version. The registry strips metadata (EXIF, GPS, author fields) before serving them,
but crop out anything personal on the screenshot itself.

## Personal data

Examples must use fictional data, your own data, or public figures and organisations in their public role:

- emails at `example.com`, `example.org` or `example.net`
- phone numbers in the fictional range, such as `+1 202-555-0123`
- the documentation IP ranges `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`

Email addresses, phone numbers and names next to street addresses that look real are flagged, and a reviewer checks
the release before it goes public.

> [!WARNING]
> Guides that teach techniques touching personal data are expected to have a scope and legal page. The starter
> page from `ot init --guide` is a good base.

## Check before you release

```
ot validate
```

checks the manifest, every page in `nav`, links between pages, images and the personal-data rules, locally and the
same way the registry does.

Next: [release](03-release.md).
