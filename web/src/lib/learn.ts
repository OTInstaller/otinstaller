// The /learn page and its Markdown twin (/learn.md): how an investigation runs, opsec for the investigator, legal
// and ethical basics, and a reading order through the guides and docs. One source for both; learn.test.ts checks
// that every guide page, docs page and input type it links to exists. Text is Markdown-lite (lib/agents.ts inline).
import type { MarkdownPage } from "./markdown";

/** Where the launch guides are published. */
export const GUIDES_NS = "osintverse-community";
const guide = (name: string, page?: string) => `/guides/${GUIDES_NS}/${name}${page ? `/${page}` : ""}`;

export interface LearnLink {
  label: string;
  href: string;
}

export interface Stage {
  name: string;
  text: string;
  links: LearnLink[];
}

/** The six stages of an investigation, each with where the registry helps. */
export const METHOD: Stage[] = [
  {
    name: "Scope",
    text: "Write down the question you need answered and why you may ask it, before you run anything. A scope keeps you from collecting what you don't need, and tells you when you're done.",
    links: [
      { label: "Scope and legal, from the username playbook", href: guide("username-investigation", "01-scope-and-legal") },
      { label: "Acceptable use", href: "/policy/acceptable-use" },
    ],
  },
  {
    name: "Collect",
    text: "Start from what you have: an email address, a username, a phone number, a domain, an IP address or an image. Use passive tools first: ones that work offline or read public sources without touching the target. Each tool page says what it contacts under Behaviour.",
    links: [
      { label: "Email tools", href: "/input/email" },
      { label: "Username tools", href: "/input/username" },
      { label: "Domain tools", href: "/input/domain" },
      { label: "Phone tools", href: "/input/phone" },
    ],
  },
  {
    name: "Pivot",
    text: "Every result holds new identifiers: an email address in a profile, a domain in an email address, a username in a bio. `ot pivot <run>` and the \"What next\" list on each tool page name the tools that take them.",
    links: [
      { label: "Saved results and pivots", href: "/docs/results" },
      { label: "Pivoting from an email address", href: guide("email-investigation", "05-pivot") },
    ],
  },
  {
    name: "Verify",
    text: "A hit is a lead, not an identification. Confirm each finding with at least two independent links to what you already know, and mark it confirmed, likely or unrelated, with why.",
    links: [
      { label: "Verify and pivot", href: guide("username-investigation", "04-verify-and-pivot") },
      { label: "Finding earlier copies of an image", href: guide("image-geolocation", "03-copies") },
    ],
  },
  {
    name: "Record",
    text: "Keep what answers the question, with the date, the tool and version, and how you found it. `ot run` saves every run with its `run_id`, the tool's digest and a hash of exactly what the tool printed; `--case` keeps a case's runs together.",
    links: [
      { label: "What a run saves", href: "/docs/results" },
      { label: "Preserving what a profile shows", href: guide("social-media-profiles", "04-preserve") },
    ],
  },
  {
    name: "Report",
    text: "Say what you found, how sure you are and how you know. Cite runs by their `run_id` so someone else can check them. When the case closes, delete what you collected and no longer need.",
    links: [
      { label: "Pulling indicators out of saved runs", href: "/docs/results" },
    ],
  },
];

/** What `ot` protects for the investigator, and what it doesn't. */
export const OPSEC = [
  "`ot` runs each tool in a container that can't read your files, with no network unless the tool needs it, and passes each API key only to the tool that declares it.",
  "It doesn't hide your IP address. The sites and services a tool contacts see where the request came from. If that matters for your case, run `ot` from a server or through a VPN you are allowed to use.",
  "Some tools contact the target or may notify them, such as a password-reset or sign-up check. The tool page and `ot info` say so under Behaviour, and agents and scripts must ask before running them.",
  "Keep investigation accounts and API keys apart from personal ones. `ot keys` stores keys in your system keychain.",
  "Results can hold personal data. Keep them on an encrypted disk, grouped by case, and out of folders that sync to the cloud.",
];

/** Legal and ethical basics. */
export const LEGAL = [
  "Have a purpose and a lawful basis. Journalism, a fraud investigation, due diligence and a security assessment you were hired for each have their own rules. Check the law where you are and where the person is.",
  "Information about a person is personal data in most places (GDPR in the EU and UK, privacy laws elsewhere). Collect only what answers your question and delete the rest.",
  "Respect the services you use: no fake accounts to see more, no logins you aren't entitled to, no getting round access controls.",
  "Never use what you find to contact, harass, stalk or expose anyone. The [acceptable use policy](/policy/acceptable-use) applies to every tool and guide here.",
  "This page is general information, not legal advice.",
];

export interface PathStep {
  title: string;
  text: string;
  links: LearnLink[];
}

/** The reading order, from the first command to publishing. */
export const PATH: PathStep[] = [
  {
    title: "Start here",
    text: "Install `ot`, run a first tool and see what the registry can do.",
    links: [
      { label: "Quick start", href: "/docs/quick-start" },
      { label: "What you can do", href: "/tour" },
      { label: "Getting started", href: "/docs/getting-started" },
    ],
  },
  {
    title: "Beginner playbooks",
    text: "One identifier each, step by step, passive first.",
    links: [
      { label: "Username investigation", href: guide("username-investigation") },
      { label: "Email investigation", href: guide("email-investigation") },
      { label: "Phone number investigation", href: guide("phone-investigation") },
      { label: "Social media profiles", href: guide("social-media-profiles") },
    ],
  },
  {
    title: "Intermediate playbooks",
    text: "Infrastructure, images and money: more tools, more care with what you touch.",
    links: [
      { label: "Domain investigation", href: guide("domain-investigation") },
      { label: "IP address investigation", href: guide("ip-investigation") },
      { label: "Image verification and geolocation", href: guide("image-geolocation") },
      { label: "Cryptocurrency address tracing", href: guide("crypto-address-tracing") },
    ],
  },
  {
    title: "Go further",
    text: "Batch runs, saved results, automation, AI agents, and tools without Docker.",
    links: [
      { label: "Saved results and pivots", href: "/docs/results" },
      { label: "Scripts, CI and agents", href: "/docs/automation" },
      { label: "AI agents", href: "/agents" },
      { label: "otlite, no Docker", href: "/otlite" },
    ],
  },
  {
    title: "Give back",
    text: "Package a tool you rely on, or write down how you investigate.",
    links: [
      { label: "Publish your first tool", href: guide("publish-your-first-tool") },
      { label: "Publish a guide", href: guide("publish-a-guide") },
      { label: "How publishing works", href: "/docs/publishing" },
    ],
  },
];

/** Every link the page shows, for the existence test. */
export const LEARN_LINKS: LearnLink[] = [...METHOD.flatMap((s) => s.links), ...PATH.flatMap((p) => p.links)];

const list = (links: LearnLink[]) => links.map((l) => `[${l.label}](${l.href})`).join(" · ");

const body = `OSINT means answering a question from information anyone can lawfully get to. The tools are the easy part; the method is what makes a finding hold up. This page is the method in short, what to watch for your own safety and the law, and the order to read the guides in.

## How an investigation runs

${METHOD.map((s, i) => `### ${i + 1}. ${s.name}\n\n${s.text}\n\n${list(s.links)}`).join("\n\n")}

## Opsec for the investigator

${OPSEC.map((o) => `- ${o}`).join("\n")}

## Legal and ethical basics

${LEGAL.map((l) => `- ${l}`).join("\n")}

## What to read, in order

${PATH.map((p) => `### ${p.title}\n\n${p.text}\n\n${p.links.map((l) => `- [${l.label}](${l.href})`).join("\n")}`).join("\n\n")}`;

/** The Markdown twin, served at /learn.md and to `Accept: text/markdown` on /learn. */
export const LEARN_PAGE: MarkdownPage = {
  path: "/learn",
  slug: "learn",
  section: "site",
  title: "Learn OSINT with OTInstaller",
  description: "How an OSINT investigation runs, from scope to report; opsec and legal basics for the investigator; and the order to read the investigation playbooks in.",
  body,
};
