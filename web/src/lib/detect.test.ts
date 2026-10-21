import { describe, expect, it } from "vitest";
import { destination, detect } from "./detect";

describe("detect", () => {
  it("matches the CLI's first-match order", () => {
    expect(detect("https://example.com/x")).toBe("url");
    expect(detect("192.0.2.1")).toBe("ip");
    expect(detect("2001:db8::1")).toBe("ip");
    expect(detect("ada@example.com")).toBe("email");
    expect(detect("+44 20 7946 0958")).toBe("phone");
    expect(detect("example.com")).toBe("domain");
    expect(detect("sub.example.co.uk")).toBe("domain");
  });
  it("knows hashes and wallets", () => {
    expect(detect("d41d8cd98f00b204e9800998ecf8427e")).toBe("hash");
    expect(detect("0x742d35Cc6634C0532925a3b844Bc454e4438f44e")).toBe("crypto_address");
    expect(detect("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe("crypto_address");
  });
  it("leaves words and handles alone", () => {
    expect(detect("whois")).toBeNull();
    expect(detect("jane_doe")).toBeNull();
    expect(detect("jane.doe")).toBeNull();
    expect(detect("two words")).toBeNull();
    expect(detect("example.notatld")).toBeNull();
    expect(detect("")).toBeNull();
  });
});

describe("destination", () => {
  it("sends typed values to their input page and words to search", () => {
    expect(destination("ada@example.com", "auto")).toBe("/input/email?value=ada%40example.com");
    expect(destination("whois", "auto")).toBe("/search?q=whois");
    expect(destination("jane_doe", "username")).toBe("/input/username?value=jane_doe");
    expect(destination("example.com", "name")).toBe("/search?q=example.com");
    expect(destination("  ", "auto")).toBe("/search");
  });
});
