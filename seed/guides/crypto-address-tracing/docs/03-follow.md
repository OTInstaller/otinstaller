# Follow the funds

Each counterparty is another address to look up. Work outward one hop at a time and keep a table: address, how you
reached it, amounts and dates, and what you think it is.

## Bitcoin specifics

- **Change.** A Bitcoin payment spends whole inputs and sends the remainder back to the sender, usually to a new
  address. Among the outputs of an outgoing transaction, one is often the sender's own change. Hints: it is the
  output with an odd amount, the same address type as the inputs, and spent later together with the sender's other
  coins.
- **Common input ownership.** Addresses spent together as inputs of one transaction usually belong to the same
  wallet. CoinJoin transactions (many equal outputs) deliberately break this rule.

## Where trails end

- **Exchanges**: deposits to large, very active addresses. Block explorers and public label lists often name them.
- **Mixers and bridges**: funds enter and something equivalent leaves elsewhere, or on another chain. Tracing through
  them is a specialist job.
- **Contracts on Ethereum**: tokens, DEX swaps and bridges. Follow the token transfers, not only ETH.

## Write it up

Draw the flow as a simple diagram (addresses as boxes, transactions as arrows with amount and date). Say which links
are certain (on-chain) and which are inferred (change, common ownership, labels), and where the trail ends.
