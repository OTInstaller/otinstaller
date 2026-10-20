# What it exposes

Internet-wide scanners already probe every IPv4 address. Reading their data is passive.

## Free: Shodan InternetDB

```
ot run osintverse-community/naabu --ip 1.1.1.1
```

This runs naabu in passive mode: it reads the open ports Shodan's InternetDB lists for the address, without sending
anything to it.

## With a Shodan key: services and banners

```
ot keys set SHODAN_API_KEY
ot run osintverse-community/shodan-host --ip 1.1.1.1
```

You get each open port with the service banner, software versions, TLS certificate details, host names Shodan has
seen, and known vulnerabilities for the versions it detected. The key is stored in your OS keychain and passed to the
tool only for that run.

## Reading it

- **Remote access** (SSH, RDP, VNC) and **admin panels** say what the machine is for.
- **Certificates and host names** in banners are the best pivot: they name the domains served from the machine.
- **Default pages** of web servers or appliances often show the product and version.

> [!NOTE]
> Scanner data is days or weeks old. Check the timestamps before drawing conclusions about the machine today.

Next: [ranges and neighbours](04-ranges.md).
