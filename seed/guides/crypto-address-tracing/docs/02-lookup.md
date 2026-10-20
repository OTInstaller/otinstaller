# Look up the address

Tell the chains apart by format: Bitcoin addresses start with `1`, `3` or `bc1`; Ethereum (and EVM chains) with `0x`
and 40 hexadecimal characters.

## Bitcoin

```
ot run osintverse-community/btc-address --address 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
```

You get the balance, total received and sent, the number of transactions, the 25 most recent transactions (with
block time and the net amount for this address) and the counterparties: the addresses that paid in, and the ones paid
out to. Data comes from the public Blockstream Esplora API.

## Ethereum

```
ot run osintverse-community/eth-address --address 0x314159265dD8dbb310642f98f50C066173C1259b
```

You get the ETH balance, the ENS name if one points back to the address, whether it is a contract (and which token),
transaction and token-transfer counts, recent transactions and counterparties, from the public Blockscout API.

## First reading

| Pattern | Often means |
| --- | --- |
| Many small incoming payments, few large outgoing | Collection address: donations, ransom, scam payments |
| Funds leave within minutes of arriving | Automated forwarding, often towards a mixer or exchange |
| Balance zero, history long | A spent address; follow where the funds went |
| A contract | Not a person's wallet: a token, exchange or protocol |

Next: [follow the funds](03-follow.md).
