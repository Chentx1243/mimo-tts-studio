import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import multer from "multer";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const maxAudioBytes = Math.floor(7.5 * 1024 * 1024);
const allowedMimeTypes = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "video/mp4"
]);
const mimoEndpoint = "https://api.xiaomimimo.com/v1/chat/completions";
const dataDir = path.resolve(process.cwd(), "data");
const workspaceFilePath = path.join(dataDir, "workspaces.json");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxAudioBytes,
    files: 1
  }
});

type MimoPayload = {
  model: "mimo-v2.5-tts-voiceclone";
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  audio: {
    format: "wav";
    voice: string;
  };
};

type MimoResponse = {
  choices?: Array<{
    message?: {
      audio?: {
        data?: string;
      };
    };
  }>;
};

type StoredWorkspace = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: unknown[];
  edges: unknown[];
  viewport?: unknown;
};

type WorkspaceStore = {
  activeWorkspaceId: string | null;
  workspaces: StoredWorkspace[];
};

app.use(cors());
// 画板会持久化参考音频和生成产物的 data URL，本地工作站需要更高的 JSON 限制。
app.use(express.json({ limit: "80mb" }));

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    model: "mimo-v2.5-tts-voiceclone",
    apiKeyConfigured: Boolean(process.env.MIMO_API_KEY),
    maxAudioBytes,
    allowedMimeTypes: Array.from(allowedMimeTypes)
  });
});

app.get("/api/workspaces", async (_req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    res.json({
      activeWorkspaceId: store.activeWorkspaceId,
      workspaces: store.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        nodeCount: workspace.nodes.length,
        edgeCount: workspace.edges.length
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspaces/:id", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((item) => item.id === req.params.id);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found." });
    }

    res.json(workspace);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const now = new Date().toISOString();
    const workspace: StoredWorkspace = {
      id: createId("board"),
      name: normalizeWorkspaceName(req.body?.name),
      createdAt: now,
      updatedAt: now,
      nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : [],
      edges: Array.isArray(req.body?.edges) ? req.body.edges : [],
      viewport: req.body?.viewport
    };

    store.workspaces.unshift(workspace);
    store.activeWorkspaceId = workspace.id;
    await writeWorkspaceStore(store);
    res.status(201).json(workspace);
  } catch (error) {
    next(error);
  }
});

app.put("/api/workspaces/:id", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const index = store.workspaces.findIndex((item) => item.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: "Workspace not found." });
    }

    const current = store.workspaces[index];
    const updated: StoredWorkspace = {
      ...current,
      name: normalizeWorkspaceName(req.body?.name ?? current.name),
      updatedAt: new Date().toISOString(),
      nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : current.nodes,
      edges: Array.isArray(req.body?.edges) ? req.body.edges : current.edges,
      viewport: req.body?.viewport ?? current.viewport
    };

    store.workspaces[index] = updated;
    store.activeWorkspaceId = updated.id;
    await writeWorkspaceStore(store);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workspaces/:id", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const nextWorkspaces = store.workspaces.filter((item) => item.id !== req.params.id);
    if (nextWorkspaces.length === store.workspaces.length) {
      return res.status(404).json({ error: "Workspace not found." });
    }

    store.workspaces = nextWorkspaces;
    store.activeWorkspaceId = store.activeWorkspaceId === req.params.id ? (nextWorkspaces[0]?.id ?? null) : store.activeWorkspaceId;
    await writeWorkspaceStore(store);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/tts/voiceclone", upload.single("voice"), async (req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now();

  try {
    const apiKey = process.env.MIMO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const text = String(req.body.text || "").trim();
    const instruction = String(req.body.instruction || "").trim();
    const outputFormat = String(req.body.format || "wav").trim();

    if (outputFormat !== "wav") {
      return res.status(400).json({ error: "Only wav output is supported in this debugger." });
    }

    if (!text) {
      return res.status(400).json({ error: "Synthesis text is required." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "A reference voice audio file is required." });
    }

    const voiceMime = resolveVoiceMimeType(req.file);
    if (!voiceMime) {
      return res.status(400).json({
        error: "Unsupported audio type. Please upload an mp3, m4a/mp4 audio, or wav file.",
        receivedMimeType: req.file.mimetype,
        fileName: req.file.originalname
      });
    }

    const audioBase64 = req.file.buffer.toString("base64");
    const payload: MimoPayload = {
      model: "mimo-v2.5-tts-voiceclone",
      messages: [
        { role: "user", content: instruction },
        { role: "assistant", content: text }
      ],
      audio: {
        format: "wav",
        voice: `data:${voiceMime};base64,${audioBase64}`
      }
    };

    const upstreamResponse = await fetch(mimoEndpoint, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await upstreamResponse.text();
    const elapsedMs = Date.now() - startedAt;
    const parsed = parseJson(responseText);

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        error: "MiMo API request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText,
        request: redactPayload(payload, req.file)
      });
    }

    if (!parsed) {
      return res.status(502).json({
        error: "MiMo API returned a non-JSON response.",
        elapsedMs,
        details: responseText.slice(0, 1000),
        request: redactPayload(payload, req.file)
      });
    }

    const audioData = extractAudioData(parsed);
    if (!audioData) {
      return res.status(502).json({
        error: "MiMo API response did not include choices[0].message.audio.data.",
        elapsedMs,
        details: parsed,
        request: redactPayload(payload, req.file)
      });
    }

    res.json({
      audioDataUrl: `data:audio/wav;base64,${audioData}`,
      fileName: `mimo-voiceclone-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`,
      elapsedMs,
      request: redactPayload(payload, req.file),
      response: {
        audioBytesApprox: Math.floor((audioData.length * 3) / 4),
        choiceCount: getChoiceCount(parsed)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: `Reference audio is too large. Maximum file size is ${formatBytes(maxAudioBytes)}.`
      });
    }

    return res.status(400).json({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Unexpected server error.";
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`MiMo voice clone proxy listening on http://localhost:${port}`);
});

function resolveVoiceMimeType(file: Express.Multer.File): "audio/mp3" | "audio/m4a" | "audio/wav" | null {
  const extension = file.originalname.split(".").pop()?.toLowerCase();
  const detected = detectAudioContainer(file.buffer);

  if (detected) {
    return detected;
  }

  if (extension === "mp3") {
    return "audio/mp3";
  }

  if (extension === "m4a" || extension === "mp4") {
    return "audio/m4a";
  }

  if (extension === "wav") {
    return "audio/wav";
  }

  if (file.mimetype === "audio/mpeg" || file.mimetype === "audio/mp3") {
    return "audio/mp3";
  }

  if (file.mimetype === "audio/mp4" || file.mimetype === "audio/m4a" || file.mimetype === "video/mp4") {
    return "audio/m4a";
  }

  if (file.mimetype === "audio/wav" || file.mimetype === "audio/x-wav" || file.mimetype === "audio/wave") {
    return "audio/wav";
  }

  return null;
}

function detectAudioContainer(buffer: Buffer): "audio/mp3" | "audio/m4a" | "audio/wav" | null {
  if (buffer.length < 12) {
    return null;
  }

  const first12 = buffer.subarray(0, 12).toString("latin1");
  if (first12.startsWith("RIFF") && first12.slice(8, 12) === "WAVE") {
    return "audio/wav";
  }

  if (first12.startsWith("ID3") || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return "audio/mp3";
  }

  // MP4/M4A files expose an ftyp box near the beginning. Renaming them to .mp3 does not change this.
  if (first12.slice(4, 8) === "ftyp") {
    return "audio/m4a";
  }

  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractAudioData(value: unknown): string | null {
  const response = value as MimoResponse;
  const data = response.choices?.[0]?.message?.audio?.data;
  return typeof data === "string" && data.length > 0 ? data : null;
}

function getChoiceCount(value: unknown): number {
  if (!value || typeof value !== "object" || !("choices" in value)) {
    return 0;
  }

  const choices = (value as { choices?: unknown }).choices;
  return Array.isArray(choices) ? choices.length : 0;
}

function redactPayload(payload: MimoPayload, file: Express.Multer.File) {
  return {
    ...payload,
    audio: {
      ...payload.audio,
      voice: `data:${resolveVoiceMimeType(file) ?? file.mimetype};base64,<${formatBytes(file.size)} reference audio omitted>`
    }
  };
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

async function readWorkspaceStore(): Promise<WorkspaceStore> {
  try {
    const raw = await readFile(workspaceFilePath, "utf-8");
    const parsed = JSON.parse(raw) as WorkspaceStore;
    return {
      activeWorkspaceId: parsed.activeWorkspaceId ?? parsed.workspaces?.[0]?.id ?? null,
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : []
    };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : "";
    if (code !== "ENOENT") {
      throw error;
    }

    const now = new Date().toISOString();
    const initial: WorkspaceStore = {
      activeWorkspaceId: "board-initial",
      workspaces: [
        {
          id: "board-initial",
          name: "默认工作台",
          createdAt: now,
          updatedAt: now,
          nodes: [],
          edges: []
        }
      ]
    };
    await writeWorkspaceStore(initial);
    return initial;
  }
}

async function writeWorkspaceStore(store: WorkspaceStore): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(workspaceFilePath, JSON.stringify(store, null, 2), "utf-8");
}

function normalizeWorkspaceName(value: unknown): string {
  const name = String(value || "").trim();
  return name || `未命名工作台 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
