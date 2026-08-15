import readline from "node:readline";
import { redactSurgeOutputLine } from "./lib/surge-output.mjs";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  process.stdout.write(`${redactSurgeOutputLine(line)}\n`);
}
