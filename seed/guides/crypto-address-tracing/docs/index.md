# Cryptocurrency address tracing playbook

Public blockchains are open ledgers: every transaction of an address is visible to anyone. This playbook takes a
Bitcoin or Ethereum address from a ransom note, a scam page or a donation link to its balance, history and
counterparties.

**Steps**

1. [Scope and legal](01-scope-and-legal.md)
2. [Look up the address](02-lookup.md)
3. [Follow the funds](03-follow.md)

**Tools used** (`ot guide tools osintverse-community/crypto-address-tracing`):

| Tool | Used for |
| --- | --- |
| [osintverse-community/btc-address](https://otinstaller.com/osintverse-community/btc-address) | Bitcoin balance, totals, recent transactions and counterparties |
| [osintverse-community/eth-address](https://otinstaller.com/osintverse-community/eth-address) | Ethereum balance, ENS name, contract details, recent transactions |

The examples use the Bitcoin genesis address and the original ENS registry contract, both public.
