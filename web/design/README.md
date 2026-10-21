# Site redesign mockups

Static HTML and CSS for the direction proposed in [docs/web-redesign-plan.md](../../docs/web-redesign-plan.md).
They are not part of the site build (nothing imports them) and need no server: open the files in a browser.

| File | What |
| --- | --- |
| `design.css` | The proposed tokens and components (§4.9 of the plan): light by default, dark via `prefers-color-scheme` or `data-theme="dark"` on `<html>`, reduced motion honoured. |
| `home.html` | The home page: paste-what-you-have box with a detected-type chip, install block with "what this script does", one row per input type, guides, recently verified working. |
| `tool.html` | A tool page (`osintverse-community/maigret`): run block, evidence panel, facts rail, sample output, README, guides, pivots. |

To see the dark theme, add `data-theme="dark"` to the `<html>` element or switch the OS theme. The fonts fall
back to the system's monospace and sans; the plan proposes self-hosting Geist Mono (display and UI) and keeping
Inter (prose). Nothing here uses JavaScript; the copy buttons and the tabs are visual only. All data shown is
from production on 21 Oct 2026 except the install counts, which are illustrative, and the digest, which is
truncated and fake.
