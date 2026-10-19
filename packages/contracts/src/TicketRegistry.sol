// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Chainpass ticket issuance commitment registry
/// @notice Records issuance evidence, not ownership, payment, or current admission validity.
/// @dev Never submit personal data, QR payloads, or unsalted low-entropy ticket attributes.
contract TicketRegistry is AccessControlDefaultAdminRules, Pausable {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant MAX_BATCH_SIZE = 100;

    struct Anchor {
        uint64 timestamp;
        uint64 blockNumber;
        address issuer;
    }

    mapping(bytes32 commitment => Anchor anchor) private _anchors;
    uint256 public anchoredCount;

    error InvalidIssuer();
    error InvalidCommitment();
    error InvalidBatchSize(uint256 size);

    event TicketAnchored(bytes32 indexed commitment, address indexed issuer, uint64 timestamp);

    /// @param admin Governance account; transfer requires the inherited delayed two-step process.
    /// @param issuer Initial issuance worker; it cannot administer or pause the registry.
    /// @param adminDelay Seconds required before a pending admin can accept a transfer.
    constructor(address admin, address issuer, uint48 adminDelay)
        AccessControlDefaultAdminRules(adminDelay, admin)
    {
        if (issuer == address(0)) revert InvalidIssuer();
        _grantRole(ISSUER_ROLE, issuer);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @notice Anchor up to 100 commitments. Previously anchored values are skipped.
    /// @dev Duplicate retries never replace the original timestamp, block, or issuer.
    function anchorBatch(bytes32[] calldata commitments)
        external
        onlyRole(ISSUER_ROLE)
        whenNotPaused
        returns (uint256 created)
    {
        uint256 size = commitments.length;
        if (size == 0 || size > MAX_BATCH_SIZE) revert InvalidBatchSize(size);

        for (uint256 i; i < size; ++i) {
            bytes32 commitment = commitments[i];
            if (commitment == bytes32(0)) revert InvalidCommitment();
            if (_anchors[commitment].timestamp != 0) continue;

            _anchors[commitment] = Anchor(uint64(block.timestamp), uint64(block.number), msg.sender);
            emit TicketAnchored(commitment, msg.sender, uint64(block.timestamp));
            ++created;
        }
        anchoredCount += created;
    }

    /// @return timestamp Zero means no issuance commitment was anchored.
    /// @return blockNumber Block in which the original commitment was anchored.
    /// @return issuer Address that anchored the original commitment.
    function getAnchor(bytes32 commitment)
        external
        view
        returns (uint64 timestamp, uint64 blockNumber, address issuer)
    {
        Anchor memory anchor = _anchors[commitment];
        return (anchor.timestamp, anchor.blockNumber, anchor.issuer);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @dev Resuming issuance is reserved for governance.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
