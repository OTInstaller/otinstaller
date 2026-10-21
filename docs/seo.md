# SEO and AI search

How otinstaller.com is set up for search engines and AI assistants, what each page type says about itself, which
searches each page is meant to answer, and what to check every month. Written on 21 October 2026 from an audit of
production and the source in `web/`; the changes it describes landed on the `claude/web-seo` branch. Keep it in step
with `web/src/lib/seo.ts`, `web/src/lib/landing.ts`, `web/src/layouts/Base.astro` and `web/src/pages/sitemap.xml.ts`.

The constraints come first, because every rule below exists to keep them:

- **The edge cache and the crawler protections stay.** After crawlers walking every filter combination used up D1's
  daily reads on 21 October 2026, filter and sort links are `rel="nofollow"`, any page with a query string is
  `noindex`, and `robots.txt` disallows `/*?`. Nothing here adds a crawlable query-string URL, and every new API call a
  page makes is a public, edge-cached read.
- **The strict CSP stays.** No inline styles or scripts, no third-party scripts. Structured data is JSON-LD in a
  `<script type="application/ld+json">`, which the CSP allows because it is not executed.
- **One canonical address per page**, so the cache and the index agree on what a page is.

## 1. Audit of production (21 October 2026)

Checked with `curl`, the desktop app's browser and Lighthouse 12 (mobile, Edge headless) against
`https://otinstaller.com`.

| Area | Found | Done about it |
| --- | --- | --- |
| Hosts | `www.otinstaller.com` and plain `http://` answered 200 with the full page (duplicates of every URL). The canonical tag pointed at the apex, which limits the damage, but a redirect is what crawlers expect. | The middleware answers 301 to `https://otinstaller.com` for both (`web/src/lib/redirects.ts`). Cloudflare's **Always Use HTTPS** should also be on for the zone (dashboard setting, not in this repo). |
| Trailing slashes | `/docs/` and `/input/email/` answered 200 with a canonical of `/docs/` (the canonical tag used the request path). | 301 to the slash-less path, everywhere but the root. |
| Old URLs | None broke: the redesign kept every public URL. Pre-redesign guesses (`/tools`, `/tool/x`, `/getting-started`) never existed and answer 404. | Nothing. |
| Removed packages | 410 with a `noindex` page, as intended. | Nothing. |
| robots.txt | Correct: `/dashboard`, `/settings/`, `/import`, `/*?` disallowed; sitemap and llms.txt pointers. | Kept as is. |
| sitemap.xml | 100 URLs. Listed `/input/string`, `/input/integer`, `/input/boolean` and `/input/enum` (no tools, no story) and `/input/hash`, `/input/company` (no tools yet). No `lastmod` (the API's list endpoints carry no dates). | Generic value types and input types or categories with zero tools are left out (91 URLs). Their pages are `noindex`. |
| Canonicals | Guide first pages declared `/guides/ns/name/index` while the sitemap and every link say `/guides/ns/name`. | The first page's canonical is the guide's address. |
| Titles | Tool pages were `ns/name · OTInstaller` (no words a searcher types); input pages `Email OSINT tools`; docs `FAQ · OTInstaller`. | See the inventory below. |
| Descriptions | One generic description for the home page; the summary alone for tools; the same sentence for every page of a guide. | Per page type, with counts where they are facts. |
| Headings | Tool pages had two `h1`s (the title and the README's), guide pages too (the title and the page body's). | Body headings are demoted (`web/src/lib/html.ts`): a leading `h1` that repeats the page title is dropped, and any other `h1` moves every body heading down a level. |
| Structured data | Tools: `SoftwareApplication` (valid). Guides: `TechArticle` without dates or publisher. Home: `WebSite` with `SearchAction`. Nothing else. | See the inventory. |
| Open Graph | Complete, with the generated `og.png`; no `twitter:title`/`description`. | Added, plus `og:type=article` for guides, docs and policies. |
| Mobile | Renders well at 375 px; Lighthouse accessibility 100 on every page checked. | Nothing. |
| hreflang | One language; not needed. | Nothing. |
| Analytics | The Cloudflare Web Analytics beacon is **not** in the HTML, although the CSP allows it. Either the zone's "Web Analytics" toggle is off or it does not inject into this Worker's responses. | Needs the dashboard (section 5). |
| Search Console | Not verifiable from this session (needs the owner's Google account). | Steps in section 5. |

### Lighthouse before (production, mobile, 21 October 2026)

| Page | Performance | Accessibility | Best practices | SEO | LCP |
| --- | --- | --- | --- | --- | --- |
| `/` | 86 | 100 | 96 | 100 | 3.2 s |
| `/osintverse-community/sherlock` | 95 | 100 | 96 | 100 | 2.4 s |
| `/input/email` | 100 | 100 | 96 | 100 | 1.2 s |
| `/guides/osintverse-community/email-investigation` | 92 | 100 | 96 | 100 | 2.1 s |
| `/docs/getting-started` | 96 | 100 | 96 | 100 | 2.6 s |

Best practices loses 4 points everywhere for "errors in console" (the `/me` request from a page without a session is
answered 401 and logged by the browser; harmless).

### Lighthouse after (preview build on localhost, mobile, 22 October 2026)

| Page | Performance | Accessibility | Best practices | SEO | LCP |
| --- | --- | --- | --- | --- | --- |
| `/` | 92 | 100 | 96 | 100 | 2.3 s |
| `/osintverse-community/sherlock` | 97 | 100 | 96 | 100 | 2.1 s |
| `/input/email` | 99 | 100 | 96 | 100 | 1.6 s |
| `/guides/osintverse-community/email-investigation` | 94 | 100 | 96 | 100 | 1.9 s |
| `/docs/getting-started` | 98 | 100 | 96 | 100 | 2.3 s |

The preview server is uncompressed and local, so performance numbers are not comparable with production ones (they
say only that nothing got heavier: no new scripts or fonts, a few hundred bytes of HTML per page). SEO and
accessibility stay at 100 on every page with one `h1` each. Re-run against production after deploying.

## 2. Page inventory

Every public page type, what it emits, and whether it is meant to be indexed. "Cache" is the edge TTL set with
`cacheFor`; a change to a page is visible after at most that long.

| Page | Title pattern | Description | JSON-LD | Index | Cache |
| --- | --- | --- | --- | --- | --- |
| `/` | OTInstaller: free OSINT tools and guides, run with one command | Counts of tools and guides, what you can paste, what `ot` does | `WebSite` (+ `SearchAction`), `Organization`, `SoftwareApplication` for `ot` | yes | 5 min |
| `/search` | All N OSINT tools, free and open source | Browse by input and output | none | yes (query forms `noindex`) | 1 min |
| `/input/{type}` | From `INPUT_LANDING` (e.g. *Username OSINT tools: find accounts with the same handle across sites*) | From `INPUT_LANDING` + "N tools listed today" | `CollectionPage`, `BreadcrumbList`, `ItemList` of the tools | yes; `noindex` for string, integer, boolean, enum | 10 min |
| `/category/{slug}` | {Category} OSINT tools | From `CATEGORY_LANDING` + count | same as input pages | yes; `noindex` when empty | 10 min |
| `/{ns}/{name}` | {name}: {summary, cut at 48 chars} | Summary; takes/finds; "Install and run {name} with one command"; key or no key | `SoftwareApplication` (version, license, repository, publisher, `datePublished`, keywords), `BreadcrumbList` | yes | 1 min |
| `/{ns}/{name}/security`, `/versions`, `/docs/…` | {ns}/{name} security / versions / {page} · docs | Short, specific | none | yes | 5–10 min |
| `/{ns}` | {publisher}: N OSINT tools and M guides | Counts, input types covered | `ProfilePage`, `BreadcrumbList`, `ItemList` | yes (`?input=` forms `noindex`) | 5 min |
| `/guides` | OSINT investigation guides and playbooks | Count and the topics | none | yes | 5 min |
| `/guides/{ns}/{name}` | {title}: {topics} OSINT, step by step | Summary, level, tool count, version, licence | `TechArticle` (dates, author namespace, publisher, `mentions` the tools), `BreadcrumbList` | yes | 10 min (pinned `?v=` forms `noindex`) |
| `/guides/{ns}/{name}/{page}` | {page title} · {guide title} | "{page}: page N of M in the {guide}. {summary}" | same, `headline` = page title | yes | 10 min |
| `/docs`, `/docs/{page}` | Documentation: install ot, run OSINT tools, publish your own / {title} | Frontmatter | `TechArticle`, `BreadcrumbList`; `/docs/faq` also `FAQPage` built from its `##` questions | yes | 1 h |
| `/policy/{page}` | {title} | Frontmatter | `WebPage` with `dateModified`, `BreadcrumbList` | yes | 1 h |
| `/publish` | Publish a tool or guide | as before | none | yes | 1 h |
| `/feedback`, `/import`, `/dashboard…`, `/settings…`, `/admin…`, `/transfers/…`, claim and report pages, 404, 410, 500 | — | — | — | `noindex` | — |

Every docs, policy, tool and guide page also has a Markdown twin (`.md` suffix or `Accept: text/markdown`) announced
with `<link rel="alternate" type="text/markdown">`, and a JSON twin (`rel="alternate" type="application/json"`) where
the API has the same data. `/llms.txt` maps the docs, schemas, policies, the input landing pages and the most-installed
tools and guides; `/llms-full.txt` holds every docs and policy page.

Title length: Google shows about 60 characters, so the part before " · OTInstaller" carries the words that matter.
Tool titles put the name first, then the summary cut at a word; landing-page titles put the search phrase first.

### What is deliberately not done

- **No prerendering of docs or policy pages.** They are static, but the middleware negotiates `Accept: text/markdown`
  on the same URL and sets `Vary: Accept`; a prerendered page is served as a static asset before the middleware runs,
  which would break the agent-facing twins. The pages are edge-cached for an hour instead, which keeps D1 out of the
  picture (they read no API).
- **No FAQ rich-result markup outside `/docs/faq`.** The input landing pages show their questions and answers in the
  page, but Google only shows FAQ rich results for government and health sites now, and marking up marketing copy as
  FAQ is the kind of thing that gets a site a manual action. The FAQ doc is a real FAQ.
- **No ratings, review counts or "aggregateRating".** The registry does not collect them.
- **No blog or changelog.** The release notes on `OTInstaller/ot` and the guides are the content that can be kept
  current; a blog that goes quiet after launch hurts more than it helps. If a changelog is wanted later, generate it
  from the `ot` releases rather than writing it by hand.
- **No "X vs Y" pages.** The "Other {input} tools" section on every tool page (the alternatives, linked to the input
  landing page) answers "sherlock alternative" searches with real, maintained content instead of thin comparison
  pages that would need rewriting with every release.

## 3. Keyword map

What investigators search for, from the registry's own vocabulary and a look at the pages that rank for these
queries today (alternativeto.net lists, "top OSINT tools" roundups, GitHub topic pages, vendor guides). Volumes are
not available without a paid tool; the ordering is a judgement of intent and fit.

| Searches | Page that answers | Why it fits |
| --- | --- | --- |
| *sherlock osint*, *maigret*, *holehe*, *phoneinfoga*, *subfinder*, *theharvester*, *dnstwist*, *yt-dlp osint* … (every tool name) | `/{ns}/{name}` | Name first in the title, the summary, the install and run command, evidence, README, alternatives |
| *how to install sherlock*, *install holehe*, *run maigret without python* | `/{ns}/{name}` (the Run block and "Don't have ot?") and `/docs/getting-started` | One command, no dependency setup, sandboxed |
| *sherlock alternative*, *maigret vs sherlock*, *tools like holehe* | `/{ns}/{name}` "Other {input} tools" and `/input/{type}` | Alternatives that take the same input, with the differences in the FAQ |
| *username osint tool*, *username search open source*, *find accounts by username* | `/input/username` | |
| *email osint tool*, *email lookup open source*, *check where an email is registered*, *email header analysis tool* | `/input/email`, `/category/email` | |
| *phone number osint*, *phone number lookup open source*, *phoneinfoga alternative* | `/input/phone` | |
| *domain osint tools*, *subdomain enumeration tool*, *passive dns recon*, *typosquatting detection tool* | `/input/domain`, `/category/domain-dns` | |
| *ip address osint*, *shodan cli*, *who owns an ip* | `/input/ip`, `/category/ip-network` | |
| *reverse image search tool*, *exif gps tool*, *image geolocation osint* | `/input/image`, `/category/images-geo` | |
| *bitcoin address lookup*, *ethereum address osint*, *crypto tracing tool* | `/input/crypto_address`, `/category/crypto` | |
| *wayback machine cli*, *find all urls of a domain* | `/category/web-archive` | |
| *osint investigation guide*, *email investigation playbook*, *username investigation steps* | `/guides`, `/guides/{ns}/{name}` | |
| *osint tool registry*, *osint package manager*, *osint tools sandbox*, *run osint tools in docker* | `/`, `/docs/security` | |
| *osint tools for ai agents*, *mcp osint*, *claude osint tools* | `/docs/agents`, `/docs/mcp-tools` | |
| *publish osint tool*, *otinstaller.yaml* | `/publish`, `/docs/publishing`, `/docs/manifest` | |

Gaps worth content rather than markup, in order:

1. **Input pages with one or two tools** (`/input/email` lists one tool today, `/input/name` one, `/input/hash` and
   `/input/company` none). Seeding more email tools (the seed has candidates) does more for "email OSINT tools" than
   any copy change; until then the page's guide link and copy carry it.
2. **Tool READMEs.** The community wrappers' READMEs are short; a paragraph on *when* to use the tool and what the
   output looks like, in the wrapper repository, is what AI assistants quote.
3. **Guide pages** already answer the question at the top (the summary is the first paragraph); keep that rule for new
   guides.

## 4. AI search

- Every page's first paragraph states what the page is for in plain words (the lead on landing pages, the summary on
  tool and guide pages, the frontmatter description on docs).
- `/llms.txt` and the `.md` twins are generated from the same sources as the HTML, so they cannot drift; `llms.txt`
  now lists the input landing pages with their titles and descriptions.
- JSON-LD names the same facts the page shows (inputs, outputs, version, licence, publisher, dates), nothing more.
- Agent-facing details (MCP server, `ot mcp`, the run block's Agent tab) are owned by the agent-friendly work; this
  document does not change them.

## 5. Measurement

**Cloudflare Web Analytics.** The CSP already allows `static.cloudflareinsights.com` and `cloudflareinsights.com`, but
the beacon is not in production HTML. In the Cloudflare dashboard: Analytics & Logs → Web Analytics → add
`otinstaller.com` with automatic setup (the zone injects the beacon). If injection does not work for the Worker's
custom domain, use the manual snippet: add `<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
data-cf-beacon='{"token":"…"}'></script>` to `Base.astro` (an external script, allowed by the CSP as it stands). It
reports Core Web Vitals from real visits, which Lighthouse cannot.

**Google Search Console.** Verify the domain property `otinstaller.com` with the DNS TXT record Google gives (added in
Cloudflare DNS; no change to the site), then submit `https://otinstaller.com/sitemap.xml`. The launch checklist asks
for the sitemap to be resubmitted after the 21 October outage; do that once the redirects above are deployed, so the
first crawl sees one host. Also add the property to Bing Webmaster Tools (it imports from Search Console).

**Monthly checklist** (15 minutes):

1. Search Console → Pages: indexed count should track the sitemap's URL count (91 today). "Excluded by noindex" should
   be only query-string URLs and the generic input pages; "Duplicate without user-selected canonical" should be zero
   after the redirects.
2. Search Console → Sitemaps: last read date is recent and the URL count matches `curl -s https://otinstaller.com/sitemap.xml | grep -c '<loc>'`.
3. Search Console → Performance: top queries against the keyword map above; a tool name that gets impressions but no
   clicks usually means its title or summary needs a better first clause (the summary is in the manifest).
4. Search Console → Enhancements: zero errors for Breadcrumbs, Software apps, FAQ.
5. Web Analytics: Core Web Vitals pass (LCP under 2.5 s, CLS under 0.1) on `/`, a tool page and a guide page.
6. Lighthouse on the same five pages as the table above (`npx lighthouse <url> --form-factor=mobile`); any score under
   90 is a regression to find.
7. `curl -sI https://www.otinstaller.com/` is a 301; `curl -sI http://otinstaller.com/` is a 301; `curl -s https://otinstaller.com/robots.txt` still disallows `/*?`.
8. Validate one tool page and one guide page in the Rich Results Test (`https://search.google.com/test/rich-results`)
   or the Schema Markup Validator after any change to `web/src/lib/seo.ts`.

## 6. Changing things

- **A new page type** needs a row in the inventory, a title and description that say what a searcher would type,
  `cacheFor`, and a line in `sitemap.xml.ts` if it is public.
- **New landing copy** goes in `web/src/lib/landing.ts`; `landing.test.ts` checks every input type and category in the
  schema has an entry and that titles and descriptions fit in a results page.
- **New JSON-LD** goes through the builders in `web/src/lib/seo.ts`, so every page uses the same `Organization`,
  breadcrumb and list shapes.
- **Anything with a query string** stays `nofollow` on the link and `noindex` on the page. Do not add a path-style
  alias for a filter to get around that: the D1 read budget is the reason.
