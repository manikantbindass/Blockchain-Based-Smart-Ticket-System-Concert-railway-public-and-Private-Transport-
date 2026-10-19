import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  BrowserProvider,
  ContractFactory,
  Interface,
  ZeroAddress,
  ZeroHash,
  sha256,
  toUtf8Bytes,
} from "ethers";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { compileRegistry } from "../scripts/compile.mjs";
import { ticketRegistryAbi } from "../src/index.js";

let connection;
let provider;
let admin;
let issuer;
let outsider;
let artifact;
const digest = (label) => sha256(toUtf8Bytes(`chainpass-test:${label}`));

before(async () => {
  artifact = compileRegistry({ write: false });
  const hre = await createHardhatRuntimeEnvironment({
    defaultNetwork: "hardhat",
    networks: {
      hardhat: { type: "edr-simulated", chainType: "l1", chainId: 31337 },
    },
  });
  connection = await hre.network.connect("hardhat");
  provider = new BrowserProvider(connection.provider);
  provider.pollingInterval = 10;
  [admin, issuer, outsider] = await Promise.all(
    [0, 1, 2].map((index) => provider.getSigner(index)),
  );
});

after(async () => {
  provider?.destroy();
  if (connection) await connection.close();
});

async function deploy() {
  const registry = await new ContractFactory(
    artifact.abi,
    artifact.bytecode,
    admin,
  ).deploy(await admin.getAddress(), await issuer.getAddress(), 3600);
  await registry.waitForDeployment();
  return registry;
}

async function rejected(action, errorName) {
  await assert.rejects(action, (error) => {
    const data =
      error.data ??
      error.error?.data ??
      error.info?.error?.data?.data ??
      error.info?.error?.data;
    if (typeof data === "string") {
      assert.equal(
        new Interface(artifact.abi).parseError(data)?.name,
        errorName,
      );
    } else {
      assert.match(String(error), new RegExp(errorName));
    }
    return true;
  });
}

test("stable worker ABI matches the compiled contract", () => {
  const full = new Interface(artifact.abi);
  const stable = new Interface(ticketRegistryAbi);
  stable.forEachFunction((entry) => {
    const compiled = full.getFunction(entry.format("sighash"));
    assert.equal(compiled.selector, entry.selector);
    assert.deepEqual(
      entry.outputs.map((output) => output.type),
      compiled.outputs.map((output) => output.type),
    );
  });
  stable.forEachEvent((entry) => {
    const compiled = full.getEvent(entry.format("sighash"));
    assert.equal(compiled.topicHash, entry.topicHash);
    assert.deepEqual(
      entry.inputs.map((input) => Boolean(input.indexed)),
      compiled.inputs.map((input) => Boolean(input.indexed)),
    );
  });
});

test("authorized issuance records actual block evidence; public reads reveal no QR or PII", async () => {
  const registry = await deploy();
  const commitment = digest("issued");
  const unknown = await registry.getAnchor(commitment);
  assert.equal(unknown.timestamp, 0n);
  assert.equal(unknown.issuer, ZeroAddress);
  const transaction = await registry.connect(issuer).anchorBatch([commitment]);
  const receipt = await transaction.wait();
  const anchor = await registry.getAnchor(commitment);
  assert.ok(anchor.timestamp > 0n);
  assert.equal(anchor.blockNumber, BigInt(receipt.blockNumber));
  assert.equal(anchor.issuer, await issuer.getAddress());
  assert.equal(await registry.anchoredCount(), 1n);
  const event = registry.interface.parseLog(receipt.logs[0]);
  assert.equal(event.name, "TicketAnchored");
  assert.equal(event.args.commitment, commitment);
});

test("retry after a worker crash and duplicate input preserve the original proof", async () => {
  const registry = await deploy();
  const first = digest("first");
  const second = digest("second");
  await (await registry.connect(issuer).anchorBatch([first, first])).wait();
  const original = await registry.getAnchor(first);
  await (
    await registry.grantRole(
      await registry.ISSUER_ROLE(),
      await outsider.getAddress(),
    )
  ).wait();
  const retry = await (
    await registry.connect(outsider).anchorBatch([first, second, second])
  ).wait();
  assert.deepEqual(
    (await registry.getAnchor(first)).toArray(),
    original.toArray(),
  );
  assert.equal(await registry.anchoredCount(), 2n);
  assert.equal(retry.logs.length, 1);
  const duplicate = await (
    await registry.connect(issuer).anchorBatch([first, second])
  ).wait();
  assert.equal(duplicate.logs.length, 0);
  assert.equal(await registry.anchoredCount(), 2n);
});

test("unauthorized accounts cannot issue, pause, resume, or grant themselves roles", async () => {
  const registry = await deploy();
  const untrusted = registry.connect(outsider);
  await rejected(
    () => untrusted.anchorBatch.staticCall([digest("attack")]),
    "AccessControlUnauthorizedAccount",
  );
  await rejected(
    () => untrusted.pause.staticCall(),
    "AccessControlUnauthorizedAccount",
  );
  await rejected(
    () => untrusted.unpause.staticCall(),
    "AccessControlUnauthorizedAccount",
  );
  await rejected(
    () =>
      untrusted.grantRole.staticCall(
        registry.ISSUER_ROLE(),
        outsider.getAddress(),
      ),
    "AccessControlUnauthorizedAccount",
  );
});

test("pause halts issuance while preserving reads, and only governance resumes", async () => {
  const registry = await deploy();
  const issued = digest("before-pause");
  await (await registry.connect(issuer).anchorBatch([issued])).wait();
  await (
    await registry.grantRole(
      await registry.PAUSER_ROLE(),
      await outsider.getAddress(),
    )
  ).wait();
  await (await registry.connect(outsider).pause()).wait();
  assert.equal(await registry.paused(), true);
  assert.ok((await registry.getAnchor(issued)).timestamp > 0n);
  await rejected(
    () =>
      registry.connect(issuer).anchorBatch.staticCall([digest("during-pause")]),
    "EnforcedPause",
  );
  await rejected(
    () => registry.connect(issuer).unpause.staticCall(),
    "AccessControlUnauthorizedAccount",
  );
  await rejected(
    () => registry.connect(outsider).unpause.staticCall(),
    "AccessControlUnauthorizedAccount",
  );
  await (await registry.unpause()).wait();
  await (
    await registry.connect(issuer).anchorBatch([digest("after-pause")])
  ).wait();
  assert.equal(await registry.anchoredCount(), 2n);
});

test("batch limits and zero commitments revert atomically", async () => {
  const registry = await deploy();
  const writer = registry.connect(issuer);
  await rejected(() => writer.anchorBatch.staticCall([]), "InvalidBatchSize");
  await rejected(
    () =>
      writer.anchorBatch.staticCall(
        Array.from({ length: 101 }, (_, index) => digest(`oversize-${index}`)),
      ),
    "InvalidBatchSize",
  );
  await rejected(
    () =>
      writer.anchorBatch([digest("must-rollback"), ZeroHash], {
        gasLimit: 1_000_000,
      }),
    "InvalidCommitment",
  );
  assert.equal(
    (await registry.getAnchor(digest("must-rollback"))).timestamp,
    0n,
  );
  await (
    await writer.anchorBatch(
      Array.from({ length: 100 }, (_, index) => digest(`valid-${index}`)),
    )
  ).wait();
  assert.equal(await registry.anchoredCount(), 100n);
});

test("issuer rotation revokes old keys and default admin transfer enforces its delay", async () => {
  const registry = await deploy();
  const role = await registry.ISSUER_ROLE();
  await (await registry.revokeRole(role, await issuer.getAddress())).wait();
  await rejected(
    () => registry.connect(issuer).anchorBatch.staticCall([digest("revoked")]),
    "AccessControlUnauthorizedAccount",
  );
  await (await registry.grantRole(role, await outsider.getAddress())).wait();
  await (
    await registry.connect(outsider).anchorBatch([digest("rotated")])
  ).wait();
  await rejected(
    () => registry.grantRole.staticCall(ZeroHash, outsider.getAddress()),
    "AccessControlEnforcedDefaultAdminRules",
  );
  await (
    await registry.beginDefaultAdminTransfer(await outsider.getAddress())
  ).wait();
  await rejected(
    () => registry.connect(outsider).acceptDefaultAdminTransfer.staticCall(),
    "AccessControlEnforcedDefaultAdminDelay",
  );
  await connection.provider.request({
    method: "evm_increaseTime",
    params: [3601],
  });
  await connection.provider.request({ method: "evm_mine", params: [] });
  await (await registry.connect(outsider).acceptDefaultAdminTransfer()).wait();
  assert.equal(await registry.defaultAdmin(), await outsider.getAddress());
  await rejected(
    () => registry.grantRole.staticCall(role, issuer.getAddress()),
    "AccessControlUnauthorizedAccount",
  );
});
