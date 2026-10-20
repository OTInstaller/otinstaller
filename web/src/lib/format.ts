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
