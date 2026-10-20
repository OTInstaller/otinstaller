# eth-address

Looks up an Ethereum address on the public Blockscout API and reports its ETH balance, ENS name, whether it is a contract (and which token), its transaction counts, its 25 most recent transactions and the addresses on the other side of them.

```
ot run osintverse-community/eth-address --address 0x314159265dD8dbb310642f98f50C066173C1259b
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `address` | yes |  |

## Notes

Token transfers are counted but not listed. No API key is needed; Blockscout sees the addresses you look up.

## Next steps

For Bitcoin, use [osintverse-community/btc-address](https://otinstaller.com/osintverse-community/btc-address).

## Development

```
pip install # no dependencies
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
