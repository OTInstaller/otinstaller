// Labels and formatting shared by pages and islands.

const INPUT_LABELS: Record<string, string> = {
  email: "Email", username: "Username", phone: "Phone", domain: "Domain", ip: "IP address", url: "URL", name: "Name",
  image: "Image", crypto_address: "Crypto address", hash: "Hash", company: "Company",
};

const CATEGORY_LABELS: Record<string, string> = {
  email: "Email", username: "Usernames", phone: "Phone numbers", "domain-dns": "Domains and DNS", "ip-network": "IP and networks",
  "social-media": "Social media", people: "People", company: "Companies", "images-geo": "Images and geolocation", crypto: "Crypto",
  "breach-data": "Breach data", "web-archive": "Web archives", "documents-metadata": "Documents and metadata", utilities: "Utilities",
};

export const inputLabel = (t: string) => INPUT_LABELS[t] ?? t.replace(/_/g, " ");
export const categoryLabel = (c: string) => CATEGORY_LABELS[c] ?? c;
export const entityLabel = (t: string) => t.replace(/_/g, " ");

/** The "I have a…" tiles on the home page. */
export const START_INPUTS = ["email", "username", "phone", "domain", "ip", "image", "crypto_address"];

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/** An example `ot run` line built from a tool's required inputs. */
export function exampleRun(ref: string, inputs: { name: string; type: string; required: boolean }[] = []): string {
  const args = inputs.filter((i) => i.required).map((i) => `--${i.name} <${i.type}>`);
  return ["ot run", ref, ...args].join(" ");
}

/** A guide page's address on this site; the version only when it is not the latest. */
export function guidePageHref(ref: string, path: string, version?: string): string {
  return `/guides/${ref}/${path.replace(/\.md$/, "")}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

export type HintPart = string | { href: string; label: string };

/**
 * Splits an API error hint into text and links. A sign-in link on the API ("sign in again at …?scope=api") is
 * labelled "this link" and gets `redirect` set to the current page, so the user comes back to what they were doing.
 */
export function hintParts(text: string, apiUrl: string, here?: string): HintPart[] {
  const out: HintPart[] = [];
  text.split(/(https:\/\/\S+)/).forEach((part, i) => {
    if (i % 2 === 0) {
      if (part) out.push(part);
      return;
    }
    const url = part.replace(/[.,;)]+$/, "");
    const signIn = url.startsWith(`${apiUrl}/v1/auth/`);
    let href = url;
    if (signIn && here) {
      const u = new URL(url);
      if (!u.searchParams.has("redirect")) u.searchParams.set("redirect", here);
      href = u.toString();
    }
    out.push({ href, label: signIn ? "this link" : url });
    if (part.length > url.length) out.push(part.slice(url.length));
  });
  return out;
}

/** Where an upstream project lists its releases, from a repository homepage on GitHub or GitLab; null otherwise. */
export function upstreamReleasesUrl(homepage: string | null | undefined): string | null {
  const gh = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/.exec(homepage ?? "");
  if (gh) return `https://github.com/${gh[1]}/releases`;
  const gl = /^https:\/\/gitlab\.com\/([^?#]+?)\/?$/.exec(homepage ?? "");
  return gl && gl[1]!.includes("/") && !gl[1]!.includes("/-/") ? `https://gitlab.com/${gl[1]}/-/releases` : null;
}

/** "last night", "3 days ago", or a date, for health checks and similar timestamps. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "last night";
  if (days < 14) return `${days} days ago`;
  return `on ${formatDate(ms)}`;
}
