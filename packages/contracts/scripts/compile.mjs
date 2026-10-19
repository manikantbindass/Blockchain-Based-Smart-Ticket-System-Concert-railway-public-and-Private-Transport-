import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const require = createRequire(import.meta.url);
export const contractRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function compileRegistry({ write = true } = {}) {
  const input = {
    language: "Solidity",
    sources: {
      "TicketRegistry.sol": {
        content: readFileSync(
          join(contractRoot, "src/TicketRegistry.sol"),
          "utf8",
        ),
      },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "metadata",
          ],
        },
      },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (path) => {
        if (!path.startsWith("@openzeppelin/contracts/"))
          return { error: `Unsupported import: ${path}` };
        try {
          return { contents: readFileSync(require.resolve(path), "utf8") };
        } catch {
          return {
            error: `Cannot resolve ${path}. Run npm ci from the repository root.`,
          };
        }
      },
    }),
  );
  const errors = (output.errors ?? []).filter(
    (entry) => entry.severity === "error",
  );
  if (errors.length)
    throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  const compiled = output.contracts["TicketRegistry.sol"].TicketRegistry;
  const artifact = {
    contractName: "TicketRegistry",
    compilerVersion: solc.version(),
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
    metadata: JSON.parse(compiled.metadata),
  };
  if (write) {
    mkdirSync(join(contractRoot, "artifacts"), { recursive: true });
    writeFileSync(
      join(contractRoot, "artifacts/TicketRegistry.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
  }
  return artifact;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const artifact = compileRegistry();
  console.log(
    `Compiled TicketRegistry using solc ${artifact.compilerVersion} (${(artifact.bytecode.length - 2) / 2} byte deployment).`,
  );
}
