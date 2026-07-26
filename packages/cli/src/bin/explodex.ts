#!/usr/bin/env node
import { runCli } from "../cli/entry.ts";

await runCli();
// Honor process.exitCode set by runCli.
process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
