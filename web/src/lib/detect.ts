// Guesses what kind of value someone pasted, with the same rules as `ot auto` (cli/internal/runner/detect.go):
// url, ip, email, phone, domain by IANA top-level domain, then crypto address and hash by shape. Anything else is
// a word to search by name, which the person can override to "username". Runs on the server (the search page
// redirects typed values to their input page) and in the browser (the paste box's chip).
import tldList from "./tlds.txt?raw";

export type Detected = "url" | "ip" | "email" | "phone" | "domain" | "crypto_address" | "hash" | null;

const tlds = new Set(
  tldList
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#")),
);
const emailRe = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const domainLabel = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const phoneRe = /^\+[0-9][0-9 ().-]{6,20}$/;
const ipv4Re = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ipv6Re = /^[0-9a-fA-F:]{2,39}$/;
const hashRe = /^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const btcRe = /^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{25,62})$/;
const ethRe = /^0x[a-fA-F0-9]{40}$/;

function isIPv6(s: string): boolean {
  if (!ipv6Re.test(s) || !s.includes(":")) return false;
  const parts = s.split("::");
  if (parts.length > 2) return false;
  const groups = s.split(":").filter(Boolean);
  return groups.length <= 8 && groups.every((g) => g.length <= 4);
}

export function isDomain(s: string): boolean {
  const labels = s.replace(/\.$/, "").split(".");
  if (labels.length < 2 || !tlds.has(labels[labels.length - 1]!.toLowerCase())) return false;
  return labels.every((l) => domainLabel.test(l));
}

/** The input type a value looks like, or null when it is just a word. */
export function detect(value: string): Detected {
  const t = value.trim();
  // Spaces only make sense inside an international phone number ("+44 20 …").
  if (!t || (/\s/.test(t) && !t.startsWith("+"))) return null;
  const lower = t.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return "url";
  if (ipv4Re.test(t) || isIPv6(t)) return "ip";
  if (emailRe.test(t)) return "email";
  if (phoneRe.test(t)) {
    const digits = t.replace(/\D/g, "").length;
    if (digits >= 7 && digits <= 15) return "phone";
  }
  if (isDomain(t)) return "domain";
  if (hashRe.test(t)) return "hash";
  if (btcRe.test(t) || ethRe.test(t)) return "crypto_address";
  return null;
}

/** Where a typed value goes: its input page with the value kept for the run commands, or a name search. */
export function destination(value: string, type: string): string {
  const v = value.trim();
  const kind = type === "auto" ? detect(v) : type === "name" ? null : type;
  if (!v) return "/search";
  if (!kind) return `/search?q=${encodeURIComponent(v)}`;
  return `/input/${kind}?value=${encodeURIComponent(v)}`;
}
