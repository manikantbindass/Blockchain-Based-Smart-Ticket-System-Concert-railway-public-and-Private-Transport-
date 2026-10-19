/** Minimal stable ABI for API workers. The compiler artifact contains the full governance ABI. */
export const ticketRegistryAbi = Object.freeze([
  "function anchorBatch(bytes32[] commitments) returns (uint256 created)",
  "function getAnchor(bytes32 commitment) view returns (uint64 timestamp, uint64 blockNumber, address issuer)",
  "function anchoredCount() view returns (uint256)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function PAUSER_ROLE() view returns (bytes32)",
  "function MAX_BATCH_SIZE() view returns (uint256)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function paused() view returns (bool)",
  "event TicketAnchored(bytes32 indexed commitment, address indexed issuer, uint64 timestamp)",
  "error InvalidCommitment()",
  "error InvalidBatchSize(uint256 size)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error EnforcedPause()",
]);

export const MAX_ANCHOR_BATCH_SIZE = 100;
