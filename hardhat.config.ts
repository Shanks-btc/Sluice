// Sluice's Hardhat setup.
//
// - Solidity 0.8.24 compiled for the Shanghai EVM: QIE has no Cancun opcodes (MCOPY, TSTORE and
//   BLOBBASEFEE are undefined there), so nothing may be compiled for Cancun.
// - The compiler is the solc-js package from the registry (pinned in package.json). Hardhat 2.17's
//   native compiler download did not work in the build environment, and solc-js needs no download.
// - `pnpm test` runs the unit tests on a local chain. `pnpm test:fork` (FORK=1) runs the fork tests
//   against a local copy of QIE mainnet. Nothing in either command sends a real transaction: the fork
//   is held in this process and its accounts are impersonated or random.
// Lets the tests import the workspace packages (@sluice/sdk and the others) from their source, with no build step.
import "tsconfig-paths/register";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import type { HardhatUserConfig } from "hardhat/config";
import { subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: { solcVersion: string }, _hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: "0.8.24",
      longVersion: "0.8.24+commit.e11b9ed9",
    };
  }
  return runSuper();
});

const fork = process.env.FORK === "1";
const forkBlock = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined;
const countFile = process.env.SLUICE_COUNT_FILE?.trim();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "shanghai",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      chainId: 1990,
      hardfork: "shanghai",
      chains: {
        1990: {
          hardforkHistory: { berlin: 0, london: 1, arrowGlacier: 2, grayGlacier: 3, merge: 4, shanghai: 5 },
        },
      },
      initialBaseFeePerGas: 1_000_000_000,
      gasPrice: 1_125_000_000,
      accounts: { count: 20 },
      ...(fork
        ? {
            forking: {
              url: process.env.SLUICE_FORK_RPC_URL ?? "https://rpc1mainnet.qie.digital/",
              ...(forkBlock ? { blockNumber: forkBlock } : {}),
            },
          }
        : {}),
    },
  },
  // SLUICE_TEST_DIR lets the count-only mode list the fork tests without forking anything.
  paths: { tests: process.env.SLUICE_TEST_DIR?.trim() || (fork ? "test/fork" : "test/unit") },
  mocha: {
    timeout: 900_000,
    // Count-only mode, used by a docs test to check the test counts the README states. It lists every test
    // and runs none of them, writing the totals as JSON to the file named by SLUICE_COUNT_FILE.
    ...(countFile ? ({ dryRun: true, reporter: "json", reporterOptions: { output: countFile } } as object) : {}),
  },
};

export default config;
