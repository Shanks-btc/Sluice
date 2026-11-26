// Makes a key for the facilitator's relayer, writes it to a file you name, and prints only the address.
//
//   pnpm live:new-key .\relayer.key
//
// The key is never printed. The file is created with a mode only you can read, and the script refuses to overwrite a file that is there,
// so a key you already hold is never lost to a second run. Put the file's contents into your host's secret store, then delete the file.
// Run it on your own computer. Nothing is sent anywhere.
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { Wallet } from "ethers";

export function main(argv: string[], log: (line: string) => void = console.log): number {
  const path = argv[0];
  if (!path || argv.length !== 1 || path.startsWith("--")) {
    log("refused: give the name of the file to write the key to, like: pnpm live:new-key .\\relayer.key");
    return 1;
  }
  if (existsSync(path)) {
    log("refused: that file already exists, and it may hold a key you need. Choose another name.");
    return 1;
  }
  const wallet = Wallet.createRandom();
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${wallet.privateKey}\n`);
  } finally {
    closeSync(fd);
  }
  log(`wrote a new key to ${path}`);
  log(`address: ${wallet.address}`);
  log("send QIE to that address from a wallet you control. If this is the relayer's key: put the file's contents in the host's secret store as SLUICE_RELAYER_KEY, then delete the file.");
  log("If this is the deployer's key: read it into one session as SLUICE_KEY (see docs/MAINNET-RUNBOOK.md) and keep the file where only you can read it. Never use one key for both.");
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
