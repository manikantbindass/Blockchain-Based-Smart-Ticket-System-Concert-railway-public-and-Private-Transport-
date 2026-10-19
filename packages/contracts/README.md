# Chainpass commitment registry

`TicketRegistry.sol` anchors a ticket issuance commitment on an EVM chain. A commitment is a 32-byte SHA-256 digest produced by the API. The public record contains only the digest, issuer address, timestamp, and block number. Ticket identifiers must include unpredictable random material in the digest preimage; hashing names, emails, or predictable booking numbers is not a privacy measure.

This is an immutable issuance registry, not an NFT, payment processor, or transferable ticket contract. The database remains authoritative for ownership, cancellation, and admission. An anchored ticket may subsequently be cancelled or used. The admission API must check current database state; a chain record alone never grants entry. QR credentials and personal data must never be sent to the registry.

## Local setup

Requirements: Node.js 24 and dependencies installed with `npm ci` from the repository root. These commands are run from the repository root:

```sh
# Terminal 1: local chain, bound to 127.0.0.1:8545
npm run chain:node

# Terminal 2: compile with the installed solc package and deploy locally
npm run chain:deploy
```

The deployment prints a real contract address and writes `packages/contracts/deployments/localhost.json`, which is deliberately ignored by Git. Set the printed address in the root `.env`:

```dotenv
BLOCKCHAIN_ENABLED=true
RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
CONTRACT_ADDRESS=0x_ADDRESS_PRINTED_BY_DEPLOYMENT
# Leave CHAIN_PRIVATE_KEY empty for this local development chain.
```

Restart the API, then run the outbox worker separately:

```sh
npm run worker
```

Local deployment uses the first unlocked development account as both admin and issuer. The deploy script rejects non-loopback URLs and chain IDs other than 31337. The worker may use unlocked accounts only in non-production local development. Hardhat's displayed accounts are public test credentials and must never hold real funds. No wallet extension is needed for the local application.

The development chain exists only in memory. Restarting `chain:node` erases its history. Redeploy after a restart and use a fresh local demo database for a clean end-to-end session; previously anchored database rows do not recreate erased chain history automatically. For persistent environments use a durable chain and reconcile receipts, block hashes, and finality.

## Build and validation

```sh
npm run chain:compile
npm run test -w @chainpass/contracts
```

The compiler is the pinned `solc` npm package, so compilation does not download a compiler. It emits a full ABI, bytecode, and Solidity metadata into the ignored `artifacts/TicketRegistry.json`. Hardhat supplies the local EVM; its compiler task is not used. Tests compile the contract and execute actual EVM calls in an isolated in-process chain, with no running RPC node required.

Coverage includes authorized issuance, original block evidence, duplicate input, retry after a simulated worker crash, unauthorized issuance and role escalation, pause/resume, batch limits, issuer revocation, and delayed governance transfer. Tests also compare the exported worker ABI to the compiled contract.

## Worker interface

```js
import { Contract } from "ethers";
import { ticketRegistryAbi, MAX_ANCHOR_BATCH_SIZE } from "@chainpass/contracts";

const registry = new Contract(address, ticketRegistryAbi, signer);
const anchor = await registry.getAnchor(commitment);
// anchor.timestamp === 0n means this commitment has not been anchored.
const transaction = await registry.anchorBatch(
  commitments.slice(0, MAX_ANCHOR_BATCH_SIZE),
);
const receipt = await transaction.wait(requiredConfirmations);
```

`anchorBatch(bytes32[])` accepts 1–100 nonzero commitments. Existing commitments, including repeats within one batch, are skipped without changing their original evidence or emitting another event. One invalid commitment reverts the entire batch. This permits replay after a worker crashes between transaction confirmation and an outbox update. The worker still needs a database lease, transaction reconciliation, confirmation handling, and bounded retries; contract idempotency does not provide those operational guarantees.

`getAnchor(bytes32)` returns `(uint64 timestamp, uint64 blockNumber, address issuer)`. `TicketAnchored(bytes32 indexed commitment, address indexed issuer, uint64 timestamp)` is emitted exactly once per commitment. To recover the original transaction after a crash, read `getAnchor`, then query that commitment's event in the recorded block. An all-duplicate transaction succeeds with zero new events.

## Governance and deployment boundaries

The contract uses OpenZeppelin `AccessControlDefaultAdminRules` with three authorities:

| Authority            | Capability                                                            |
| -------------------- | --------------------------------------------------------------------- |
| `ISSUER_ROLE`        | Submit issuance commitments while unpaused                            |
| `PAUSER_ROLE`        | Immediately pause new issuance                                        |
| `DEFAULT_ADMIN_ROLE` | Grant/revoke roles, resume issuance, schedule administration transfer |

Reads continue while paused. Governance cannot alter or delete an anchored commitment. Admin transfer is delayed and requires acceptance by the new admin; arbitrary default-admin grants are prohibited. The local deployment sets a 24-hour delay. Transfer of the default-admin role does not automatically migrate other roles: explicitly grant the new pauser and revoke the previous pauser and any obsolete issuer keys after a governance transition. The full governance ABI is available in the compiler artifact.

For any public-chain launch, complete an independent contract/security review, use a multisignature admin distinct from the issuer, choose an appropriate admin delay, protect the issuer with a managed signer, monitor role changes and paused state, and configure confirmation depth and reorganization recovery. The repository provides no public-chain deployment script and has not undergone an independent audit. Its single-contract per-commitment storage design has gas and storage costs proportional to issuance volume; a Merkle-root batching system would be a separate protocol change with inclusion-proof tooling.

Reference: [OpenZeppelin access control](https://docs.openzeppelin.com/contracts/5.x/access-control), [Hardhat programmatic runtime](https://hardhat.org/docs/cookbook/programmatic-hre).
