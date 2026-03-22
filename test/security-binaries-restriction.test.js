// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BASELINE = path.join(__dirname, "..", "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
const PRESETS_DIR = path.join(__dirname, "..", "nemoclaw-blueprint", "policies", "presets");

describe("binaries restriction: baseline policy", () => {
  it("every network_policies entry has a binaries section", () => {
    // Parse YAML manually (no yaml dependency) — find all top-level keys under network_policies
    // and verify each has a "binaries:" line within its block
    const yaml = fs.readFileSync(BASELINE, "utf-8");
    const lines = yaml.split("\n");
    let inNetworkPolicies = false;
    let currentBlock = null;
    const blocks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^network_policies:/.test(line)) { inNetworkPolicies = true; continue; }
      if (inNetworkPolicies && /^\S/.test(line) && line.trim() !== "") {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = null;
        inNetworkPolicies = false;
        continue;
      }
      if (!inNetworkPolicies) continue;
      // Top-level entry under network_policies (2-space indent, not a comment)
      if (/^  (?!#)\S.*:\s*$/.test(line)) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = { name: line.trim().replace(/:$/, ""), startLine: i + 1, lines: [line] };
        continue;
      }
      if (currentBlock) currentBlock.lines.push(line);
    }
    if (currentBlock) blocks.push(currentBlock);

    assert.ok(blocks.length > 0, "baseline must have at least one network_policies block");

    const violators = blocks.filter(b => !b.lines.some(l => /^\s+binaries:/.test(l)));

    assert.deepEqual(
      violators.map(b => b.name),
      [],
      `Baseline blocks without binaries: restriction:\n` +
        violators.map(b => `  - ${b.name} (line ${b.startLine})`).join("\n") +
        `\nEvery network_policies entry must have a binaries: section to prevent data exfiltration (#272).`
    );
  });
});

describe("binaries restriction: policy presets", () => {
  it("every preset YAML has a binaries section", () => {
    const presets = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith(".yaml"));
    assert.ok(presets.length > 0, "should find at least one preset");

    const missing = [];
    for (const file of presets) {
      const content = fs.readFileSync(path.join(PRESETS_DIR, file), "utf-8");
      if (!content.includes("binaries:")) {
        missing.push(file);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `Presets without binaries: restriction: ${missing.join(", ")}\n` +
        `Every preset must have a binaries: section (#272).`
    );
  });
});
