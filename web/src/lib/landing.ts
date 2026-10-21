// Copy for the input-type and category landing pages (/input/{type}, /category/{slug}): what an investigator can
// find from that starting point, how a first pass usually goes, and the questions people ask before picking a
// tool. Written for the searches these pages answer ("email OSINT tools", "username lookup open source"…); the
// keyword map is in docs/seo.md. Facts about tools (counts, what each finds) come from the API at render time;
// this file holds only what is true whatever the registry lists.

export interface Landing {
  /** The <title> without the site name. */
  title: string;
  /** The meta description (under 160 characters). */
  description: string;
  /** The first paragraph: the answer to "what can I find from this?", in two or three sentences. */
  lead: string;
  /** How a first pass usually goes, one step per item. Left empty for generic types. */
  steps: string[];
  /** Questions people ask on the way in, answered honestly. */
  faq: [question: string, answer: string][];
}

/** Generic value types have no investigation story and are kept out of search engines (noindex). */
export const GENERIC_INPUTS = new Set(["string", "integer", "boolean", "enum"]);

const SANDBOX_FAQ: [string, string][] = [
  ["Do these tools send my search anywhere?", "No. ot runs each tool on your own machine in a read-only container that can only reach the sites the tool declares, and results stay in your results folder. The registry only counts installs."],
  ["Do I need an API key?", "Most tools here work without one; the row says \"Key required\" when one is needed, and ot keys set stores it in your OS keychain so only that tool's container sees it."],
];

export const INPUT_LANDING: Record<string, Landing> = {
  email: {
    title: "Email OSINT tools: find accounts, breaches and the sender behind an address",
    description: "Free, open-source email OSINT tools you run with one command: check where an address is registered, trace a message's headers and find linked accounts, without alerting the owner.",
    lead: "An email address is one of the best starting points in an investigation: it is reused across services, tied to a person or organisation, and often sits in the headers of a message you already have. The tools below take an address and tell you where it is registered, what the sending infrastructure looks like and which usernames and domains it connects to. Every one runs on your own machine in a sandbox, and the ones that query services do it through password-reset and sign-up checks that do not notify the owner.",
    steps: [
      "Check where the address is registered to learn which platforms to look at next.",
      "If you have the message itself, parse its headers for the real sending server, relays and SPF/DKIM results.",
      "Take the local part as a username and the domain as a domain, and pivot into those tools.",
    ],
    faq: [
      ["Can I find out who owns an email address?", "Not directly from an address alone. What these tools give you is where it is registered and what it links to; the owner usually emerges from the accounts and the domain you pivot into."],
      ["Will the owner be notified?", "The tools listed here check registration through endpoints that do not send mail, and each tool's page says whether it contacts the target. Nothing in the registry sends a message to the address."],
      ...SANDBOX_FAQ,
    ],
  },
  username: {
    title: "Username OSINT tools: find accounts with the same handle across sites",
    description: "Open-source username search tools (sherlock, maigret and more) that find where a handle is in use across thousands of sites. Install and run them in a sandbox with one command.",
    lead: "People reuse handles. A username search checks one handle against hundreds or thousands of sites and returns the profiles that exist, which is usually the fastest way from a single account to a person's wider footprint. The tools below differ in coverage, speed and how much they extract from each profile; most need no API key. Treat every hit as a lead to verify, because common handles belong to more than one person.",
    steps: [
      "Run a broad check (sherlock, maigret or naminter) to list the sites where the handle exists.",
      "Verify the hits by hand: same avatar, bio, links or time zone across profiles.",
      "Generate variants of the handle or the person's name and run the check again.",
    ],
    faq: [
      ["What is the difference between sherlock and maigret?", "Both check a username across many sites. sherlock reports whether an account exists; maigret also extracts what the profile page shows (names, links, IDs) and follows new handles it finds. naminter uses the WhatsMyName site list. Running two of them and comparing is a common first step."],
      ["Why do I get false positives?", "Some sites answer the same way for every name, and common handles belong to several people. Each tool's page says what it checks; confirm hits by looking at the profile."],
      ...SANDBOX_FAQ,
    ],
  },
  phone: {
    title: "Phone number OSINT tools: carrier, country, line type and linked accounts",
    description: "Free phone number OSINT tools: parse a number offline for country, carrier and line type, then find the accounts and pages it is linked to. Run them sandboxed with one command.",
    lead: "A phone number tells you less than people expect from the number alone, and more once you look at where it is registered. Offline parsing gives you the country, original carrier, line type and valid formats with no network request; registration checks then show which services have an account on that number. The tools here do both, and none of them calls or messages the number.",
    steps: [
      "Parse the number offline to normalise it and learn its country, carrier and line type.",
      "Check which services have an account registered on it.",
      "Search the normalised formats on the web and in the results of your other runs.",
    ],
    faq: [
      ["Can I find the owner of a phone number?", "Not from the number by itself. These tools return what the number is (country, carrier, type) and where it is registered; a name comes from the accounts you find and verify."],
      ["Is a lookup visible to the person?", "No. Parsing is offline, and registration checks use sign-up and recovery endpoints that do not send an SMS. Each tool's page states whether it contacts the target."],
      ...SANDBOX_FAQ,
    ],
  },
  domain: {
    title: "Domain OSINT tools: DNS, subdomains, certificates, history and look-alikes",
    description: "Open-source domain OSINT and recon tools: DNS records, passive subdomain enumeration, certificate transparency, archived URLs, email security and typosquat detection, run sandboxed with one command.",
    lead: "A domain is the most connected thing you can start from: its DNS records point at hosting and mail providers, certificate logs and passive sources list its subdomains, archives hold its past pages, and look-alike domains show who is impersonating it. The tools below cover each of those passively, so you learn about a domain without sending it traffic beyond ordinary DNS and public datasets.",
    steps: [
      "Pull the DNS records and email security records (SPF, DMARC, MX) to see where it is hosted and who handles its mail.",
      "Enumerate subdomains from certificate transparency and passive sources, then probe the live ones.",
      "Check archived URLs for what the site used to say, and look-alike domains for impersonation.",
    ],
    faq: [
      ["Is this passive reconnaissance?", "Mostly. DNS lookups and certificate-log queries touch public infrastructure, not the target's servers; probing a host's web server does. Each tool's page says whether it contacts the target, and the guide orders the passive steps first."],
      ["Can I run these against a domain I don't own?", "Looking up public records is lawful in most places; scanning or probing may not be. The acceptable-use policy and each tool's behaviour notes are there so you can decide before you run."],
      ...SANDBOX_FAQ,
    ],
  },
  ip: {
    title: "IP address OSINT tools: ownership, open ports, services and CDN detection",
    description: "Free IP address OSINT tools: RDAP ownership and ASN, what Shodan has seen, open ports from passive sources, CDN and WAF detection. Run them sandboxed with one command.",
    lead: "From an IP address you can learn who holds the range, which organisation and country it belongs to, what services have been seen on it, and whether it is really a CDN or cloud edge rather than the target's own machine. The tools below answer those questions from registries and passive datasets, so you do not have to scan the host yourself.",
    steps: [
      "Look up the holder through RDAP: network, ASN, organisation and abuse contacts.",
      "Check passive sources (Shodan InternetDB and similar) for open ports and services.",
      "Find out whether the address is a CDN, cloud provider or WAF before drawing conclusions.",
    ],
    faq: [
      ["Does this scan the IP?", "The listed tools read registries and passive datasets rather than sending packets to the host; the row and the tool page say when a tool contacts the target."],
      ["Can I get a location from an IP?", "Only roughly: the country and often the city of the network, from registry data and Shodan's records. It is the location of the infrastructure, not of a person."],
      ...SANDBOX_FAQ,
    ],
  },
  url: {
    title: "URL OSINT tools: unpack links, archives, web servers, images and video metadata",
    description: "Open-source URL tools for investigators: decode what a link encodes, find archived copies, probe the server behind it, and pull metadata from images, galleries and videos. Run sandboxed with one command.",
    lead: "A URL carries more than its page: timestamps and IDs inside the link itself, earlier versions in web archives, the server and technologies behind it, and metadata in the images or videos it points to. The tools below take a URL and return each of those, which makes them the second step after almost any other search.",
    steps: [
      "Unpack the URL for the IDs, timestamps and tracking parameters it encodes.",
      "Check the Wayback Machine for the oldest and newest captures.",
      "Probe the host, or pull the metadata of the image, gallery or video the link shows.",
    ],
    faq: [
      ["Which tool do I use for a social media post?", "A post or profile URL goes to the media tools (gallery-dl, yt-dlp) for its images, metadata and channel details; the social media profiles guide walks through preserving a public profile."],
      ...SANDBOX_FAQ,
    ],
  },
  name: {
    title: "Name OSINT tools: from a person's name to usernames and accounts",
    description: "Open-source tools that turn a person's name into likely usernames to check across sites, run sandboxed with one command.",
    lead: "A name on its own is ambiguous, so the useful first move is to generate the handles a person is likely to use and check those. The tools below take a name and produce username candidates; feed them into the username tools to find the accounts that exist.",
    steps: [
      "Generate likely usernames from the name (first.last, initials, with and without numbers).",
      "Run the candidates through a username search and keep the handles that exist.",
      "Verify by matching avatars, bios and locations across the profiles you found.",
    ],
    faq: [
      ["Can I search a name directly?", "Not with the registry's tools: name search sites are mostly commercial and paywalled, so the registry lists the tools that get you from a name to handles, and from handles to accounts."],
      ...SANDBOX_FAQ,
    ],
  },
  image: {
    title: "Image OSINT tools: metadata, reverse image search and geolocation",
    description: "Free image verification tools: read EXIF and GPS metadata, build reverse image search links, hash images to find copies, and check a location on maps. Run them sandboxed with one command.",
    lead: "An image can give up where and when it was taken, what camera made it, where else it has been published, and whether a copy has been edited. The tools below read metadata, prepare reverse image searches across the engines that matter, compute perceptual hashes to match near-duplicates, and turn coordinates into map and sun-position links for verifying a place.",
    steps: [
      "Read the metadata: GPS, camera, software and dates, if the platform kept them.",
      "Reverse image search it on Google Lens, Bing, Yandex and TinEye to find earlier copies.",
      "Hash it to match copies, and check the location on map and satellite views.",
    ],
    faq: [
      ["Why is there no GPS in the metadata?", "Most platforms strip metadata on upload. The original file, or a copy from a site that keeps it, is what you need; otherwise geolocation comes from the picture's content."],
      ...SANDBOX_FAQ,
    ],
  },
  crypto_address: {
    title: "Crypto address OSINT tools: balance, history and counterparties of a Bitcoin or Ethereum address",
    description: "Free blockchain OSINT tools: look up a Bitcoin or Ethereum address for balance, totals, recent transactions, ENS names and counterparties, one hop at a time. Run them sandboxed with one command.",
    lead: "Blockchains are public ledgers, so an address gives you its balance, how much it has received and sent, its recent transactions and the addresses on the other side of them. The tools below read that from public explorers for Bitcoin and Ethereum (including ENS names and contract details), which is enough to follow funds one hop at a time.",
    steps: [
      "Look up the address: balance, totals and the latest transactions.",
      "List the counterparties and repeat the lookup on the ones that matter.",
      "Record each hop; the crypto tracing guide shows how to keep that readable.",
    ],
    faq: [
      ["Can these tools identify the owner of an address?", "No. They show what the public ledger shows. Attribution to a person or exchange comes from other sources, such as an address being published somewhere you can find."],
      ...SANDBOX_FAQ,
    ],
  },
  hash: {
    title: "Hash OSINT tools",
    description: "Tools that take a file or content hash and tell you what is known about it, run sandboxed with one command.",
    lead: "A hash identifies a file or an image without sharing it. Tools that take one can tell you whether the same content has been seen elsewhere.",
    steps: [],
    faq: SANDBOX_FAQ,
  },
  company: {
    title: "Company OSINT tools",
    description: "Tools that take a company name and return what public records and the web say about it, run sandboxed with one command.",
    lead: "A company name leads to its registrations, domains, people and filings. Tools that take a name start that chain; the domain and email tools continue it once you have the company's domain.",
    steps: [],
    faq: SANDBOX_FAQ,
  },
};

/** Category pages share the sandbox answers and get a lead each; their titles come from the category label. */
export const CATEGORY_LANDING: Record<string, { description: string; lead: string }> = {
  email: { description: "Open-source email OSINT tools: registration checks, header analysis, mail security and address discovery, run sandboxed with one command.", lead: "Tools for everything around an email address: where it is registered, what a message's headers reveal, which addresses exist for a handle, and whether a domain's mail is protected." },
  username: { description: "Open-source username OSINT tools that check a handle across thousands of sites and generate variants to try, run sandboxed with one command.", lead: "Username search and enumeration tools, from broad checks across thousands of sites to generating the handles a person is likely to use." },
  phone: { description: "Free phone number OSINT tools: offline parsing, carrier and line type, and the accounts registered on a number, run sandboxed with one command.", lead: "Tools that parse a phone number offline and find where it is registered, without calling or messaging it." },
  "domain-dns": { description: "Open-source domain and DNS reconnaissance tools: records, subdomains, certificates, archived URLs, email security and look-alike domains, run sandboxed with one command.", lead: "Passive reconnaissance for a domain: DNS and mail records, subdomain enumeration from certificate logs and public datasets, TLS certificates, archived URLs and typosquats." },
  "ip-network": { description: "Free IP and network OSINT tools: RDAP ownership, Shodan data, passive port lists, CDN detection and CIDR maths, run sandboxed with one command.", lead: "Tools that tell you who holds an IP, what has been seen on it, whether it is a CDN edge, and how to work with ranges." },
  "social-media": { description: "Open-source social media OSINT tools: find profiles by username, email or phone, and preserve what a public profile shows, run sandboxed with one command.", lead: "Tools that find profiles from a handle, an address or a number, and collect the public posts, media and metadata of a profile for preservation." },
  people: { description: "Open-source people OSINT tools that take a name and lead to usernames and accounts, run sandboxed with one command.", lead: "Tools that start from a person's name and lead to the handles and accounts to check next." },
  company: { description: "Open-source company OSINT tools, run sandboxed with one command.", lead: "Tools that start from a company name and lead to its domains, people and records." },
  "images-geo": { description: "Free image verification and geolocation tools: EXIF and GPS metadata, reverse image search links, perceptual hashes and map links, run sandboxed with one command.", lead: "Tools for verifying a photo or video: its metadata, earlier copies, near-duplicates, and the place and time it shows." },
  crypto: { description: "Free blockchain OSINT tools for Bitcoin and Ethereum addresses: balance, history, counterparties and ENS names, run sandboxed with one command.", lead: "Tools that read what the public ledger says about a Bitcoin or Ethereum address, to follow funds one hop at a time." },
  "breach-data": { description: "Open-source tools for checking exposure in breach data, run sandboxed with one command.", lead: "Tools that check whether an address or account appears in breach datasets." },
  "web-archive": { description: "Open-source web archive tools: Wayback Machine captures and every known URL of a site from archives and crawls, run sandboxed with one command.", lead: "Tools that find what a site used to show: the oldest and newest captures, and every archived URL of a domain." },
  "documents-metadata": { description: "Open-source document and image metadata tools (ExifTool and more), run sandboxed with one command.", lead: "Tools that read the metadata of documents and images: authors, software, dates, GPS and camera details." },
  utilities: { description: "Utilities for OSINT workflows: parse URLs and hostnames, expand IP ranges, unpack links, run sandboxed with one command.", lead: "Small tools that prepare and transform values between the bigger steps: splitting hostnames, unpacking URLs, expanding ranges." },
};
