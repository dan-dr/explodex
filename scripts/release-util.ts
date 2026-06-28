#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function validateTag(tag: string): { version: string; isPrerelease: boolean; npmTag: "latest" | "next" } {
  if (!tag.startsWith("v")) {
    throw new Error(`Tag must start with 'v', got '${tag}'`);
  }
  const version = tag.slice(1);
  const match = SEMVER_REGEX.exec(version);
  if (!match) {
    throw new Error(`Invalid SemVer version in tag: '${version}'`);
  }
  
  const isPrerelease = !!match[4];
  const npmTag = isPrerelease ? "next" : "latest";
  return { version, isPrerelease, npmTag };
}

export function getChangelogNotes(version: string, changelogText: string): string {
  const lines = changelogText.split(/\r?\n/);
  const headerPrefix = `## [${version}]`;
  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(headerPrefix)) {
      startIndex = i;
      break;
    }
  }
  
  if (startIndex === -1) {
    throw new Error(`Changelog section for version '${version}' not found`);
  }
  
  const notesLines: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("## ")) {
      break;
    }
    notesLines.push(line);
  }
  
  const notes = notesLines.join("\n").trim();
  if (!notes) {
    throw new Error(`Changelog section for version '${version}' is empty`);
  }
  
  if (notes.includes("[Unreleased]")) {
    throw new Error(`Changelog body contains '[Unreleased]' reference`);
  }
  
  return notes;
}

export function checkRelease(tag: string, packageJsonVersion: string, changelogText: string): { version: string; npmTag: "latest" | "next"; notes: string } {
  const { version, npmTag } = validateTag(tag);
  if (tag !== `v${packageJsonVersion}`) {
    throw new Error(`Tag '${tag}' does not match package.json version 'v${packageJsonVersion}'`);
  }
  const notes = getChangelogNotes(version, changelogText);
  return { version, npmTag, notes };
}

function run() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: bun run release-util.ts <check|notes> <argument>");
    process.exit(1);
  }
  
  const cmd = args[0];
  const arg = args[1];
  
  const root = join(import.meta.dir, "..");
  const packageJsonPath = join(root, "package.json");
  const changelogPath = join(root, "CHANGELOG.md");
  
  try {
    if (cmd === "check") {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const changelogText = readFileSync(changelogPath, "utf8");
      
      const { version, npmTag } = checkRelease(arg, packageJson.version, changelogText);
      
      console.log(`Validation successful for tag: ${arg}`);
      console.log(`Version: ${version}`);
      console.log(`NPM Tag: ${npmTag}`);
      // Output npm tag as the last line so caller scripts can capture it
      console.log(npmTag);
    } else if (cmd === "notes") {
      const changelogText = readFileSync(changelogPath, "utf8");
      const notes = getChangelogNotes(arg, changelogText);
      console.log(notes);
    } else {
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
