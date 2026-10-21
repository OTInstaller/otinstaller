# btc-address

Looks up a Bitcoin address (legacy, P2SH or bech32) on the public Blockstream Esplora API and reports its balance, total received and sent, transaction count, its 25 most recent transactions and the addresses on the other side of them.

```
ot run osintverse-community/btc-address --address 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `address` | yes |  |

## Notes

Counterparties are the input addresses of incoming transactions and the outputs of outgoing ones; outputs include change addresses that belong to the same wallet. No API key is needed; Blockstream sees the addresses you look up.

## Next steps

For Ethereum, use [osintverse-community/eth-address](https://otinstaller.com/osintverse-community/eth-address).

## Development

```
pip install # no dependencies
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
