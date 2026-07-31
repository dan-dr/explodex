#!/usr/bin/env node
import { runCli } from "../cli/entry.ts";

await runCli();
// runCli sets process.exitCode. Let Node flush stdout/stderr naturally rather
// than forcing process.exit(), which can truncate a terminal JSON envelope.
