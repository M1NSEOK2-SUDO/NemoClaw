// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import bridge from "../scripts/telegram-bridge.js";

const { getInstantReply, isLatencyMessage, shouldUseDirectChat } = bridge;

describe("telegram bridge routing", () => {
  it("recognizes latency complaints as lightweight status messages", () => {
    expect(isLatencyMessage("네모클로 응답이 또 늦어져..")).toBe(true);
    expect(getInstantReply("네모클로 응답이 또 늦어져..")).toContain("바로 답");
  });

  it("keeps reaction-speed checks on the lightweight path", () => {
    expect(shouldUseDirectChat("반응속도 테스트 해줘")).toBe(true);
    expect(shouldUseDirectChat("속도가 느린거 같은데")).toBe(true);
  });

  it("still routes concrete tool requests through the full agent", () => {
    expect(shouldUseDirectChat("크롬창으로 네이버 열어줘")).toBe(false);
    expect(shouldUseDirectChat("로그 확인해줘")).toBe(false);
    expect(shouldUseDirectChat("코드 수정해줘")).toBe(false);
  });
});
