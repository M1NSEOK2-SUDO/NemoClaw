#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telegram → NemoClaw bridge.
 *
 * Messages from Telegram are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Telegram.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   NVIDIA_API_KEY      — optional for hosted NVIDIA inference
 *   SANDBOX_NAME        — sandbox name (default: nemoclaw)
 *   NEMOCLAW_MODEL      — optional display label for the current model
 *   ALLOWED_CHAT_IDS    — comma-separated Telegram chat IDs to accept (optional, accepts all if unset)
 */

const https = require("https");
const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY || "";
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
const MODEL_NAME = process.env.NEMOCLAW_MODEL || process.env.MODEL_NAME || "configured local model";
const ALLOWED_CHATS = process.env.ALLOWED_CHAT_IDS
  ? process.env.ALLOWED_CHAT_IDS.split(",").map((s) => s.trim())
  : null;

let offset = 0;
const activeSessions = new Map(); // chatId → openclaw session id

// ── Telegram API helpers ──────────────────────────────────────────

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TOKEN}/${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: buf }); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(chatId, text, replyTo) {
  // Telegram max message length is 4096
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  for (const chunk of chunks) {
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: replyTo,
      parse_mode: "Markdown",
    }).catch(() =>
      // Retry without markdown if it fails (unbalanced formatting)
      tgApi("sendMessage", { chat_id: chatId, text: chunk, reply_to_message_id: replyTo }),
    );
  }
}

async function sendTyping(chatId) {
  await tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

function looksLikeRawToolCall(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^(?:[a-z_][a-z0-9_]*\s+)?\{.*"name"\s*:\s*"[^"]+".*"arguments"\s*:\s*\{.*\}\s*\}$/is.test(trimmed);
}

function makeSessionId(chatId) {
  const safeChatId = String(chatId).replace(/[^a-zA-Z0-9-]/g, "");
  return `tg-${safeChatId}-${Date.now().toString(36)}`;
}

function getSessionId(chatId) {
  if (!activeSessions.has(chatId)) {
    activeSessions.set(chatId, makeSessionId(chatId));
  }
  return activeSessions.get(chatId);
}

function resetSession(chatId) {
  const next = makeSessionId(chatId);
  activeSessions.set(chatId, next);
  return next;
}

function isLatencyMessage(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return false;
  return /(반응속도|응답속도|속도.*(느리|늦)|응답.*(느리|늦)|반응.*(느리|늦)|버벅|렉|지연)/i.test(normalized);
}

function getInstantReply(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return null;

  if (/^(하이|ㅎㅇ|안녕|안녕[?？!]??|안녕하세요|hello|hi)\s*$/i.test(normalized)) {
    return "안녕하세요. 반응 잘 하고 있어요. 무엇을 도와드릴까요?";
  }

  if (/^(오|오오|오케이|ok|ㅇㅋ|응|웅|ㅇㅇ)\s*$/i.test(normalized)) {
    return "네, 듣고 있어요. 이어서 말씀해 주세요.";
  }

  if (/(반응이?\s*없|응답이?\s*없|답이?\s*없|살아있|멈춘거|멈춘 거|왜 답)/i.test(normalized)) {
    return "반응하고 있어요. 간단한 인사나 상태 확인은 제가 바로 답하고, 실제 작업 요청은 이어서 처리할게요.";
  }

  if (isLatencyMessage(normalized)) {
    return "지금 확인하고 있어요. 짧은 상태 대화는 바로 답하도록 맞추고 있고, 계속 느리면 로그 확인이나 실제 작업 요청으로 이어서 볼게요.";
  }

  if (/(지금\s*(사용|쓰는).*(모델|llm)|어떤\s*모델|현재\s*모델)/i.test(normalized)) {
    return `지금은 ${MODEL_NAME} 모델을 사용 중이에요.`;
  }

  return null;
}

function shouldUseDirectChat(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return true;
  if (normalized.startsWith("/")) return false;

  if (isLatencyMessage(normalized)) {
    return true;
  }

  const toolTargetPattern = /(파일|폴더|디렉터리|터미널|명령어|로그|페이지|사이트|url|크롬|chrome|브라우저|다운로드|업로드|코드|스크립트|샌드박스|sandbox|git|npm|pip|docker|curl|ssh)/i;
  if (toolTargetPattern.test(normalized)) {
    return false;
  }

  const testOrActionPattern = /(단위\s*테스트|통합\s*테스트|e2e|pytest|vitest|jest|테스트\s*(돌려|실행|run)|커밋|설치|삭제|수정|고쳐|변경|실행|검색|찾아|열어|접속)/i;
  if (testOrActionPattern.test(normalized) && normalized.length > 60) {
    return false;
  }

  return normalized.length <= 160;
}

function validateRuntimeConfig() {
  if (!OPENSHELL) {
    throw new Error("openshell not found on PATH or in common locations");
  }
  validateName(SANDBOX, "SANDBOX_NAME");
  if (!TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN required");
  }
}

function spawnRemoteCommand(remoteCmd, confPath) {
  return spawn("ssh", [
    "-T",
    "-F", confPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
    `openshell-${SANDBOX}`,
    remoteCmd,
  ], {
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collectRemoteOutput(proc, confPath, confDir, onDone) {
  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  proc.on("close", (code, signal) => {
    try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch { /* ignored */ }
    onDone(code, signal, stdout, stderr);
  });

  proc.on("error", (err) => {
    try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch { /* ignored */ }
    onDone(1, null, "", `Error: ${err.message}`);
  });
}

function createSshConfig() {
  const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });
  const confDir = require("fs").mkdtempSync("/tmp/nemoclaw-tg-ssh-");
  const confPath = `${confDir}/config`;
  require("fs").writeFileSync(confPath, sshConfig, { mode: 0o600 });
  return { confDir, confPath };
}

function sanitizeOutput(combinedOutput) {
  const lines = combinedOutput.split("\n");
  return lines.filter(
    (l) =>
      !l.startsWith("Setting up NemoClaw") &&
      !l.startsWith("[gateway]") &&
      !l.startsWith("[diagnostic]") &&
      !l.startsWith("[model-fallback/decision]") &&
      !l.startsWith("[plugins]") &&
      !l.startsWith("(node:") &&
      !l.startsWith("(Use `node --trace-warnings") &&
      !l.startsWith("Warning: Permanently added") &&
      !l.includes("NemoClaw ready") &&
      !l.includes("NemoClaw registered") &&
      !l.includes("openclaw agent") &&
      !l.includes("┌─") &&
      !l.includes("│ ") &&
      !l.includes("└─") &&
      l.trim() !== "",
  ).join("\n").trim();
}

function runDirectChatInSandbox(message) {
  return new Promise((resolve) => {
    const { confDir, confPath } = createSshConfig();
    const promptB64 = Buffer.from(String(message), "utf8").toString("base64");
    const systemB64 = Buffer.from(
      "You are NemoClaw's Telegram assistant. Reply briefly in Korean unless the user clearly asks for another language. Be concise and practical.",
      "utf8",
    ).toString("base64");
    const pythonCode = [
      "import base64, json, os, ssl, urllib.request",
      "message = base64.b64decode(os.environ['MSG_B64']).decode('utf-8')",
      "system = base64.b64decode(os.environ['SYS_B64']).decode('utf-8')",
      "body = {",
      "  'model': os.environ.get('MODEL_NAME', 'llama3.1'),",
      "  'messages': [",
      "    {'role': 'system', 'content': system},",
      "    {'role': 'user', 'content': message},",
      "  ],",
      "  'stream': False,",
      "}",
      "req = urllib.request.Request(",
      "  'https://inference.local/v1/chat/completions',",
      "  data=json.dumps(body).encode(),",
      "  headers={'Content-Type': 'application/json'},",
      ")",
      "ctx = ssl.create_default_context()",
      "with urllib.request.urlopen(req, timeout=120, context=ctx) as r:",
      "  data = json.loads(r.read().decode())",
      "  print(data['choices'][0]['message']['content'])",
    ].join("\n");
    const remoteCmd = `MSG_B64=${shellQuote(promptB64)} SYS_B64=${shellQuote(systemB64)} MODEL_NAME=${shellQuote(MODEL_NAME)} python3 -c ${shellQuote(pythonCode)}`;

    const proc = spawnRemoteCommand(remoteCmd, confPath);
    collectRemoteOutput(proc, confPath, confDir, (code, signal, stdout, stderr) => {
      const response = sanitizeOutput([stdout, stderr].filter(Boolean).join("\n"));
      if (response && code === 0) {
        resolve(response);
        return;
      }
      const compactError = response || [stdout, stderr].filter(Boolean).join("\n").trim().slice(0, 500);
      resolve(`Direct chat exited with code ${code}${signal ? ` (${signal})` : ""}. ${compactError}`.trim());
    });
  });
}

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const { confDir, confPath } = createSshConfig();

    const remoteSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const sessionLockPath = `/sandbox/.openclaw-data/agents/main/sessions/${remoteSessionId}.jsonl.lock`;
    const exportPrefix = API_KEY ? `export NVIDIA_API_KEY=${shellQuote(API_KEY)}; ` : "";
    const cmd = `rm -f ${shellQuote(sessionLockPath)} 2>/dev/null || true; ${exportPrefix}nemoclaw-start openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote(remoteSessionId)}`;
    const proc = spawnRemoteCommand(cmd, confPath);

    collectRemoteOutput(proc, confPath, confDir, (code, signal, stdout, stderr) => {
      const combinedOutput = [stdout, stderr].filter(Boolean).join("\n");
      const response = sanitizeOutput(combinedOutput);

      if (response && code === 0) {
        if (looksLikeRawToolCall(response)) {
          resolve("현재 로컬 모델이 최종 답변 대신 도구 호출만 반환하고 있습니다. 이 설정에서는 qwen2.5가 OpenClaw와 잘 맞지 않아 보여서, 다른 Ollama 모델로 바꾸는 게 필요합니다.");
          return;
        }
        resolve(response);
        return;
      }

      if (code !== 0) {
        if (/session file locked/i.test(combinedOutput)) {
          resolve("이전 요청 세션이 잠겨 있어 이번 메시지를 처리하지 못했습니다. 잠시 후 다시 보내 주세요.");
          return;
        }

        if (/FailoverError|timeout/i.test(combinedOutput)) {
          resolve("모델 응답이 제한 시간 안에 돌아오지 않았습니다. 잠시 후 다시 시도해 주세요.");
          return;
        }

        const compactError = response || combinedOutput.trim().split("\n").slice(-3).join("\n").slice(0, 500);
        resolve(`Agent exited with code ${code}${signal ? ` (${signal})` : ""}. ${compactError}`.trim());
      } else {
        resolve("(no response)");
      }
    });
  });
}

// ── Poll loop ─────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await tgApi("getUpdates", { offset, timeout: 30 });

    if (res.ok && res.result?.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;

        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);

        // Access control
        if (ALLOWED_CHATS && !ALLOWED_CHATS.includes(chatId)) {
          console.log(`[ignored] chat ${chatId} not in allowed list`);
          continue;
        }

        const userName = msg.from?.first_name || "someone";
        console.log(`[${chatId}] ${userName}: ${msg.text}`);

        // Handle /start
        if (msg.text === "/start") {
          resetSession(chatId);
          await sendMessage(
            chatId,
            "🦀 *NemoClaw*\n\n" +
              "Send me a message and I'll run it through the OpenClaw agent " +
              "inside an OpenShell sandbox.\n\n" +
              `Current model: *${MODEL_NAME}*\n\n` +
              "If the agent needs external access, the TUI will prompt for approval.",
            msg.message_id,
          );
          continue;
        }

        // Handle /reset
        if (msg.text === "/reset") {
          const nextSessionId = resetSession(chatId);
          console.log(`[${chatId}] session reset -> ${nextSessionId}`);
          await sendMessage(chatId, "Session reset.", msg.message_id);
          continue;
        }

        const instantReply = getInstantReply(msg.text);
        if (instantReply) {
          await sendMessage(chatId, instantReply, msg.message_id);
          continue;
        }

        // Send typing indicator
        await sendTyping(chatId);

        // Keep a typing indicator going while agent runs
        const typingInterval = setInterval(() => sendTyping(chatId), 4000);

        try {
          const startedAt = Date.now();
          const response = shouldUseDirectChat(msg.text)
            ? await runDirectChatInSandbox(msg.text)
            : await runAgentInSandbox(msg.text, getSessionId(chatId));
          clearInterval(typingInterval);
          console.log(`[${chatId}] reply (${Date.now() - startedAt}ms): ${response.slice(0, 100)}...`);
          await sendMessage(chatId, response, msg.message_id);
        } catch (err) {
          clearInterval(typingInterval);
          await sendMessage(chatId, `Error: ${err.message}`, msg.message_id);
        }
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }

  // Continue polling
  setTimeout(poll, 100);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  validateRuntimeConfig();
  const me = await tgApi("getMe", {});
  if (!me.ok) {
    console.error("Failed to connect to Telegram:", JSON.stringify(me));
    process.exit(1);
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Telegram Bridge                          │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      @${(me.result.username + "                    ").slice(0, 37)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Model:    " + (MODEL_NAME + "                              ").slice(0, 40) + "│");
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  poll();
}

module.exports = {
  getInstantReply,
  isLatencyMessage,
  shouldUseDirectChat,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
