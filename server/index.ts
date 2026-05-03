import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import multer from "multer";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const staticDir = process.env.MIMO_STATIC_DIR ? path.resolve(process.env.MIMO_STATIC_DIR) : "";
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
const dataDir = path.resolve(process.env.MIMO_DATA_DIR || path.join(process.cwd(), "data"));
const workspaceFilePath = path.join(dataDir, "workspaces.json");
let workspaceWriteQueue: Promise<void> = Promise.resolve();
let workspaceWriteSequence = 0;

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

type MimoVoiceDesignPayload = {
  model: "mimo-v2.5-tts-voicedesign";
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  audio: {
    format: "wav";
  };
};

type MimoChatPayload = {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  top_p?: number;
};

type MimoResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      audio?: {
        data?: string;
      };
    };
  }>;
};

type VoiceStyleOptimizePayload = {
  style: string;
};

type VoiceDesignOptimizePayload = {
  voiceDescription: string;
};

type VoiceDesignPayload = {
  voiceDescription: string;
  text: string;
  instruction?: string;
  format?: string;
};

type SmartWorkspacePlan = {
  workspaceName?: unknown;
  voiceDescription?: unknown;
  segments?: unknown;
};

type SmartWorkspaceSegment = {
  index: number;
  title: string;
  directorText: string;
};

// ====== 有声书专用类型 ======

type AudiobookCharacter = {
  id: string;
  name: string;
  gender: string;
  age: string;
  voiceTraits: string;
  personality: string;
  voiceDescription: string;
  voiceDataUrl: string | null;
  voiceStatus: "pending" | "generating" | "ready" | "error";
  voiceError?: string;
};

type AudiobookSegment = {
  id: string;
  text: string;
  characterId: string | null;
  characterName: string;
  emotion: string;
  isAutoAnnotated: boolean;
};

type AudiobookProduct = {
  id: string;
  segmentId: string;
  characterId: string | null;
  characterName: string;
  text: string;
  instruction: string;
  audioDataUrl: string | null;
  status: "pending" | "generating" | "ready" | "error";
  error?: string;
  elapsedMs?: number;
  createdAt: string;
  synthesisMethod: "voiceClone" | "voiceDesign";
};

type StoredBoardWorkspace = {
  id: string;
  type: "board";
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: unknown[];
  edges: unknown[];
  stashItems: unknown[];
  viewport?: unknown;
};

type StoredAudiobookWorkspace = {
  id: string;
  type: "audiobook";
  name: string;
  createdAt: string;
  updatedAt: string;
  novelText: string;
  characterHints: string;
  characters: AudiobookCharacter[];
  segments: AudiobookSegment[];
  products: AudiobookProduct[];
  phase: "character-creation" | "annotation" | "generation";
};

type StoredWorkspace = StoredBoardWorkspace | StoredAudiobookWorkspace;

type WorkspaceStore = {
  activeWorkspaceId: string | null;
  workspaces: StoredWorkspace[];
};

app.use(cors());
// 画板会持久化参考音频和生成产物的 data URL，本地工作站需要更高的 JSON 限制。
app.use(express.json({ limit: "80mb" }));

function getApiConfig(req: { headers: Record<string, string | string[] | undefined> }): { apiKey: string | undefined; apiEndpoint: string } {
  const headerKey = req.headers["x-api-key"];
  const apiKey = (typeof headerKey === "string" && headerKey.trim()) ? headerKey.trim() : process.env.MIMO_API_KEY;

  const headerEndpoint = req.headers["x-api-endpoint"];
  const apiEndpoint = (typeof headerEndpoint === "string" && headerEndpoint.trim()) ? headerEndpoint.trim() : mimoEndpoint;

  return { apiKey, apiEndpoint };
}

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    model: "mimo-v2.5-tts-voiceclone",
    apiKeyConfigured: Boolean(process.env.MIMO_API_KEY),
    hasEnvKey: Boolean(process.env.MIMO_API_KEY),
    maxAudioBytes,
    allowedMimeTypes: Array.from(allowedMimeTypes)
  });
});

app.post("/api/voice-style/optimize", async (req: Request<unknown, unknown, VoiceStyleOptimizePayload>, res, next) => {
  const startedAt = Date.now();

  try {
    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const style = String(req.body?.style || "").trim();
    if (!style) {
      return res.status(400).json({ error: "Voice style text is required." });
    }

    const payload = {
      model: "mimo-v2-flash",
      messages: [
        {
          role: "system",
          content:
            "你是专业的 TTS 语音风格提示词编辑。你的任务是把用户的语音风格描述优化为简短精炼的导演文本。只输出优化后的提示词，不要解释，不要使用 Markdown。"
        },
        {
          role: "user",
          content: [
            "请优化下面的语音风格描述：",
            "",
            "要求：",
            "1. 只保留三个核心要素：情感、语气、语速。",
            "2. 不要补充其他内容，精炼表达。",
            "3. 控制在 15 字左右。",
            "",
            `用户原文：${style}`
          ].join("\n")
        }
      ],
      temperature: 0.6
    };

    const upstreamResponse = await fetch(apiEndpoint, {
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
        error: "MiMo style optimization request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText
      });
    }

    const optimizedText = extractMessageContent(parsed);
    if (!optimizedText) {
      return res.status(502).json({
        error: "MiMo response did not include choices[0].message.content.",
        elapsedMs,
        details: parsed
      });
    }

    res.json({
      optimizedText: optimizedText.trim(),
      elapsedMs
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/voice-design/optimize", async (req: Request<unknown, unknown, VoiceDesignOptimizePayload>, res, next) => {
  const startedAt = Date.now();

  try {
    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const voiceDescription = String(req.body?.voiceDescription || "").trim();
    if (!voiceDescription) {
      return res.status(400).json({ error: "Voice design description is required." });
    }

    const payload: MimoChatPayload = {
      model: "mimo-v2.5-pro",
      messages: [
        {
          role: "system",
          content:
            "你是专业的 TTS 音色设计提示词编辑。你的任务是把用户粗略的音色描述润色为适合 mimo-v2.5-tts-voicedesign 模型的 voice design prompt。只输出润色后的音色描述，不要解释，不要使用 Markdown。"
        },
        {
          role: "user",
          content: [
            "请润色下面的音色描述，使其更适合用文本设计音色进行语音合成。",
            "",
            "要求：",
            "1. 输出 1 到 4 句中文，清晰描述核心音色特征，不要过长。",
            "2. 优先补全这些维度：性别与年龄、声音质感、情绪/语气、语速/节奏。",
            "3. 可适度加入角色身份、说话风格、使用场景或时代质感，但不要堆砌。",
            "4. 避免互相矛盾的要求，例如童稚声音和强烈 CEO 气场同时出现。",
            "5. 不要使用混响、回声、EQ、压缩、母带等后期制作或音频工程术语。",
            "6. 避免“普通、正常、外国”等缺少具体参考的模糊词。",
            "7. 保留用户原本想要的音色方向，不要改成完全不同的声音。",
            "",
            `用户原文：${voiceDescription}`
          ].join("\n")
        }
      ],
      temperature: 0.45,
      top_p: 0.9
    };

    const upstreamResponse = await fetch(apiEndpoint, {
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
        error: "MiMo voice design optimization request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText
      });
    }

    const optimizedText = extractMessageContent(parsed);
    if (!optimizedText) {
      return res.status(502).json({
        error: "MiMo response did not include choices[0].message.content.",
        elapsedMs,
        details: parsed
      });
    }

    res.json({
      optimizedText: optimizedText.trim(),
      elapsedMs
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspaces", async (_req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    res.json({
      activeWorkspaceId: store.activeWorkspaceId,
      workspaces: store.workspaces.map((workspace) => {
        const base = {
          id: workspace.id,
          type: workspace.type,
          name: workspace.name,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt
        };
        if (workspace.type === "audiobook") {
          return {
            ...base,
            characterCount: workspace.characters.length,
            segmentCount: workspace.segments.length,
            phase: workspace.phase
          };
        }
        return {
          ...base,
          nodeCount: workspace.nodes.length,
          edgeCount: workspace.edges.length,
          stashCount: workspace.stashItems.length
        };
      })
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
    const workspace: StoredBoardWorkspace = {
      id: createId("board"),
      type: "board",
      name: normalizeWorkspaceName(req.body?.name),
      createdAt: now,
      updatedAt: now,
      nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : [],
      edges: Array.isArray(req.body?.edges) ? req.body.edges : [],
      stashItems: Array.isArray(req.body?.stashItems) ? req.body.stashItems : [],
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

app.post("/api/workspaces/smart", upload.single("voice"), async (req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now();

  try {
    const sceneDescription = String(req.body?.sceneDescription || "").trim();
    const script = String(req.body?.script || "").trim();
    const scriptSegments = splitScriptSegments(script);
    const hasReferenceAudio = Boolean(req.file);

    const voiceMime = req.file ? resolveVoiceMimeType(req.file) : null;
    if (req.file && !voiceMime) {
      return res.status(400).json({
        error: "Unsupported audio type. Please upload an mp3, m4a/mp4 audio, or wav file.",
        receivedMimeType: req.file.mimetype,
        fileName: req.file.originalname
      });
    }

    if (!sceneDescription) {
      return res.status(400).json({ error: "Scene description is required." });
    }

    if (scriptSegments.length === 0) {
      return res.status(400).json({ error: "Script must include at least one paragraph. Use ---- to separate paragraphs." });
    }

    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const payload: MimoChatPayload = {
      model: "mimo-v2.5-pro",
      messages: [
        {
          role: "system",
          content:
            hasReferenceAudio
              ? "你是专业的中文有声内容导演和工作流策划助手。你只根据用户给出的整体场景描述和逐段台词，为每段生成短标题和适合语音克隆 TTS 的语音风格文本。语音风格文本主要描述整体氛围、情绪、角色状态和表达质感，不要写具体台词的停顿、重音或逐句朗读指令。必须输出严格 JSON，不要使用 Markdown，不要输出解释。"
              : "你是专业的中文有声内容导演、TTS 音色设计师和工作流策划助手。用户没有提供参考音频，你需要设计一个贯穿全片的统一音色，并为每段生成短标题和语音风格文本。每段应尽可能保持同一音色，只在语速、情绪和表达氛围上根据段落变化。必须输出严格 JSON，不要使用 Markdown，不要输出解释。"
        },
        {
          role: "user",
          content: hasReferenceAudio ? buildSmartWorkspacePrompt(sceneDescription, scriptSegments) : buildSmartVoiceDesignWorkspacePrompt(sceneDescription, scriptSegments)
        }
      ],
      temperature: 0.35,
      top_p: 0.9
    };

    const upstreamResponse = await fetch(apiEndpoint, {
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
        error: "MiMo smart workspace request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText
      });
    }

    const content = extractMessageContent(parsed);
    if (!content) {
      return res.status(502).json({
        error: "MiMo response did not include choices[0].message.content.",
        elapsedMs,
        details: parsed
      });
    }

    const plan = parseSmartWorkspacePlan(content);
    if (!plan) {
      return res.status(502).json({
        error: "MiMo response was not valid smart workspace JSON.",
        elapsedMs,
        details: content
      });
    }

    const segments = normalizeSmartWorkspaceSegments(plan, scriptSegments.length);
    if (!segments) {
      return res.status(502).json({
        error: "MiMo smart workspace segment count did not match the script paragraphs.",
        expected: scriptSegments.length,
        details: plan
      });
    }

    const store = await readWorkspaceStore();
    const workspace = createSmartWorkspace({
      workspaceName: normalizeWorkspaceName(plan.workspaceName || `智能画板 ${new Date().toLocaleString("zh-CN", { hour12: false })}`),
      sceneDescription,
      scriptSegments,
      segments,
      file: req.file,
      voiceMime,
      voiceDescription: String(plan.voiceDescription || "").trim()
    });

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
    const now = new Date().toISOString();

    let updated: StoredWorkspace;
    if (current.type === "audiobook") {
      updated = {
        ...current,
        name: normalizeWorkspaceName(req.body?.name ?? current.name),
        updatedAt: now,
        novelText: req.body?.novelText ?? current.novelText,
        characterHints: req.body?.characterHints ?? current.characterHints,
        characters: Array.isArray(req.body?.characters) ? req.body.characters : current.characters,
        segments: Array.isArray(req.body?.segments) ? req.body.segments : current.segments,
        products: Array.isArray(req.body?.products) ? req.body.products : current.products,
        phase: req.body?.phase ?? current.phase
      };
    } else {
      updated = {
        ...current,
        name: normalizeWorkspaceName(req.body?.name ?? current.name),
        updatedAt: now,
        nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : current.nodes,
        edges: Array.isArray(req.body?.edges) ? req.body.edges : current.edges,
        stashItems: Array.isArray(req.body?.stashItems) ? req.body.stashItems : current.stashItems,
        viewport: req.body?.viewport ?? current.viewport
      };
    }

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

// ====== 有声书 API ======

app.post("/api/audiobook", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const now = new Date().toISOString();
    const novelText = String(req.body?.novelText || "").trim();
    const characterHints = String(req.body?.characterHints || "").trim();

    if (!novelText) {
      return res.status(400).json({ error: "小说原文不能为空。" });
    }

    // 按连续空行拆分为段落
    const paragraphs = novelText.split(/\n\s*\n/).map((p: string) => p.trim()).filter(Boolean);
    const segments: AudiobookSegment[] = paragraphs.map((text: string, index: number) => ({
      id: `seg-${Date.now().toString(36)}-${index}`,
      text,
      characterId: null,
      characterName: "",
      emotion: "",
      isAutoAnnotated: false
    }));

    const workspace: StoredAudiobookWorkspace = {
      id: `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "audiobook",
      name: req.body?.name || `有声书 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      createdAt: now,
      updatedAt: now,
      novelText,
      characterHints,
      characters: [],
      segments,
      products: [],
      phase: "character-creation"
    };

    store.workspaces.unshift(workspace);
    store.activeWorkspaceId = workspace.id;
    await writeWorkspaceStore(store);
    res.status(201).json(workspace);
  } catch (error) {
    next(error);
  }
});

app.post("/api/audiobook/:id/characters/analyze", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }

    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({ error: "MIMO_API_KEY is not configured." });
    }

    const systemPrompt = `你是一位专业的有声书制作导演和角色分析师。
你的任务是从小说原文中识别出所有出场人物，并为每个人物生成音色描述。

要求：
1. 识别原文中所有有台词或明确出场的人物，忽略仅一笔带过的背景人物。
2. 对每个人物，综合用户提供的背景信息和原文描写，给出：
   - name：角色名（使用原文中的名字）
   - personality：2-3句话的性格/气质描述，用于指导朗读表演
   - voiceDescription：1-3句话的音色描述，必须适合TTS音色设计模型，包含：性别与年龄段、声音质感（如浑厚/清亮/沙哑/甜美）、情绪基调（如沉稳/活泼/冷峻/温柔）、语速节奏特征。
3. voiceDescription不要使用混响、回声、EQ等音频工程术语。
4. 如果用户已提供某角色的背景信息，voiceDescription必须与之一致，不要自行修改性别或年龄。
5. "旁白/叙述者"不要作为角色列出，旁白将在合成阶段单独处理。

只输出严格JSON，不要Markdown，不要解释。
JSON结构：{"characters":[{"name":"string","personality":"string","voiceDescription":"string"}]}`;

    const userMessage = `用户提供的关键人物背景信息：
${workspace.characterHints || "（无）"}

小说原文：
${workspace.novelText}

请分析出场人物并生成音色描述。`;

    const payload: MimoChatPayload = {
      model: "mimo-v2.5-pro",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.35,
      top_p: 0.9
    };

    const upstreamResponse = await fetch(apiEndpoint, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const responseText = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({ error: "LLM调用失败", details: responseText });
    }

    const parsed = parseJson(responseText) as MimoResponse;
    const content = parsed?.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ error: "LLM返回内容为空", raw: responseText });
    }

    // 解析JSON，兼容markdown代码块
    let charactersData: { name: string; personality: string; voiceDescription: string }[];
    try {
      const cleaned = content.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      charactersData = jsonMatch ? JSON.parse(jsonMatch[0]).characters : JSON.parse(cleaned).characters;
    } catch {
      return res.status(502).json({ error: "无法解析LLM返回的JSON", raw: content });
    }

    if (!Array.isArray(charactersData)) {
      return res.status(502).json({ error: "LLM返回格式错误：缺少characters数组", raw: content });
    }

    // 匹配用户hints中的角色信息
    const hintsLines = workspace.characterHints.split("\n").filter(Boolean);
    const hintMap = new Map<string, { gender: string; age: string; voiceTraits: string }>();
    for (const line of hintsLines) {
      const parts = line.split(/[,，、;；]/).map((s: string) => s.trim());
      if (parts.length >= 1) {
        const name = parts[0];
        hintMap.set(name, {
          gender: parts[1] || "",
          age: parts[2] || "",
          voiceTraits: parts.slice(3).join("、")
        });
      }
    }

    const characters: AudiobookCharacter[] = charactersData.map((c, index) => {
      const hint = hintMap.get(c.name);
      return {
        id: `char-${Date.now().toString(36)}-${index}`,
        name: c.name,
        gender: hint?.gender || "",
        age: hint?.age || "",
        voiceTraits: hint?.voiceTraits || "",
        personality: c.personality,
        voiceDescription: c.voiceDescription,
        voiceDataUrl: null,
        voiceStatus: "pending" as const
      };
    });

    // 更新workspace
    workspace.characters = characters;
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStore(store);

    res.json({ characters });
  } catch (error) {
    next(error);
  }
});

app.post("/api/audiobook/:id/characters/:charId/voice", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }

    const character = workspace.characters.find((c) => c.id === req.params.charId);
    if (!character) {
      return res.status(404).json({ error: "角色不存在。" });
    }

    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({ error: "MIMO_API_KEY is not configured." });
    }

    await updateAudiobookCharacter(req.params.id, req.params.charId, (target) => {
      target.voiceStatus = "generating";
      target.voiceError = undefined;
    });

    const testText = `大家好，我是${character.name}。很高兴认识你。`;
    const payload: MimoVoiceDesignPayload = {
      model: "mimo-v2.5-tts-voicedesign",
      messages: [
        { role: "user", content: character.voiceDescription },
        { role: "assistant", content: testText }
      ],
      audio: { format: "wav" }
    };

    const upstreamResponse = await fetch(apiEndpoint, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const responseText = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      const errorMessage = `音色生成失败：HTTP ${upstreamResponse.status}`;
      const updatedCharacter = await updateAudiobookCharacter(req.params.id, req.params.charId, (target) => {
        target.voiceStatus = "error";
        target.voiceError = errorMessage;
      });
      return res.status(upstreamResponse.status).json({ error: updatedCharacter.voiceError, details: responseText });
    }

    const audioData = extractAudioData(parseJson(responseText));
    if (!audioData) {
      const errorMessage = "音色生成失败：响应中没有音频数据";
      const updatedCharacter = await updateAudiobookCharacter(req.params.id, req.params.charId, (target) => {
        target.voiceStatus = "error";
        target.voiceError = errorMessage;
      });
      return res.status(502).json({ error: updatedCharacter.voiceError });
    }

    const updatedCharacter = await updateAudiobookCharacter(req.params.id, req.params.charId, (target) => {
      target.voiceDataUrl = `data:audio/wav;base64,${audioData}`;
      target.voiceStatus = "ready";
      target.voiceError = undefined;
    });

    res.json({ character: updatedCharacter });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/audiobook/:id/characters/:charId/voice", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }

    const character = workspace.characters.find((c) => c.id === req.params.charId);
    if (!character) {
      return res.status(404).json({ error: "角色不存在。" });
    }

    character.voiceDataUrl = null;
    character.voiceStatus = "pending";
    character.voiceError = undefined;
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStore(store);

    res.json({ character });
  } catch (error) {
    next(error);
  }
});

app.post("/api/audiobook/:id/annotate", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }

    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({ error: "MIMO_API_KEY is not configured." });
    }

    const characterList = workspace.characters.map((c) => `${c.name}：${c.personality}`).join("\n");
    const segmentList = workspace.segments.map((s, i) => `第${i + 1}段：${s.text}`).join("\n\n");

    const systemPrompt = `你是一位专业的有声书配音导演。
你的任务是为小说的每个文段标注：说话角色和朗读情绪/语气指导。

规则：
1. 判断每个文段是对话还是叙述/描写。
2. 对话：识别说话角色（必须是已注册角色列表中的名字），给出简短的语气描述（如"焦急地""冷淡地""低声说"）。
3. 叙述/描写：characterName设为"旁白"，emotion描述叙述基调（如"平静地叙述""紧张地描写""略带感伤地回忆"）。
4. emotion控制在5-15字，描述整体情绪基调即可，不要写逐句朗读指令。
5. 如果文段中混合了对话和叙述，以主要部分为准。

只输出严格JSON，不要Markdown，不要解释。
JSON结构：{"annotations":[{"index":1,"characterName":"string","emotion":"string"}]}`;

    const userMessage = `已注册角色列表：
${characterList || "（无角色）"}

小说文段：
${segmentList}

请为每段标注角色和朗读情绪。`;

    const payload: MimoChatPayload = {
      model: "mimo-v2.5-pro",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.35,
      top_p: 0.9
    };

    const upstreamResponse = await fetch(apiEndpoint, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const responseText = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({ error: "LLM调用失败", details: responseText });
    }

    const parsed = parseJson(responseText) as MimoResponse;
    const content = parsed?.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ error: "LLM返回内容为空" });
    }

    let annotations: { index: number; characterName: string; emotion: string }[];
    try {
      const cleaned = content.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      annotations = jsonMatch ? JSON.parse(jsonMatch[0]).annotations : JSON.parse(cleaned).annotations;
    } catch {
      return res.status(502).json({ error: "无法解析LLM返回的JSON", raw: content });
    }

    const charMap = new Map(workspace.characters.map((c) => [c.name, c]));

    for (const ann of annotations) {
      const segIndex = ann.index - 1;
      if (segIndex >= 0 && segIndex < workspace.segments.length) {
        const seg = workspace.segments[segIndex];
        const matchedChar = charMap.get(ann.characterName);
        seg.characterId = matchedChar?.id || null;
        seg.characterName = ann.characterName;
        seg.emotion = ann.emotion;
        seg.isAutoAnnotated = true;
      }
    }

    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStore(store);

    res.json({ segments: workspace.segments });
  } catch (error) {
    next(error);
  }
});

app.put("/api/audiobook/:id/segments/:segId", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }

    const segment = workspace.segments.find((s) => s.id === req.params.segId);
    if (!segment) {
      return res.status(404).json({ error: "段落不存在。" });
    }

    segment.characterId = req.body?.characterId ?? segment.characterId;
    segment.characterName = req.body?.characterName ?? segment.characterName;
    segment.emotion = req.body?.emotion ?? segment.emotion;
    segment.isAutoAnnotated = false;
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStore(store);

    res.json({ segment });
  } catch (error) {
    next(error);
  }
});

app.post("/api/audiobook/:id/generate", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }

    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({ error: "MIMO_API_KEY is not configured." });
    }

    const charMap = new Map(workspace.characters.map((c) => [c.id, c]));

    // 初始化所有 products
    workspace.products = workspace.segments.map((seg) => ({
      id: `prod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      segmentId: seg.id,
      characterId: seg.characterId,
      characterName: seg.characterName || "旁白",
      text: seg.text,
      instruction: seg.emotion || "自然地朗读",
      audioDataUrl: null,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      synthesisMethod: (seg.characterId && charMap.get(seg.characterId)?.voiceDataUrl) ? "voiceClone" as const : "voiceDesign" as const
    }));
    await writeWorkspaceStore(store);

    // 顺序生成每段音频
    for (const product of workspace.products) {
      product.status = "generating";
      product.createdAt = new Date().toISOString();
      await writeWorkspaceStore(store);

      const startMs = Date.now();

      try {
        if (product.synthesisMethod === "voiceClone") {
          // 使用 voiceclone
          const character = charMap.get(product.characterId!);
          if (!character?.voiceDataUrl) {
            throw new Error("角色音色数据不存在");
          }

          // 将 data URL 转为 buffer
          const base64Data = character.voiceDataUrl.replace(/^data:[^;]+;base64,/, "");
          const audioBuffer = Buffer.from(base64Data, "base64");

          const form = new FormData();
          form.append("voice", new Blob([audioBuffer], { type: "audio/wav" }), "voice.wav");
          form.append("text", product.text);
          form.append("instruction", product.instruction);
          form.append("format", "wav");

          const upstreamResponse = await fetch(`${apiEndpoint.replace("/chat/completions", "")}/chat/completions`.replace("//", "/"), {
            method: "POST",
            headers: { "api-key": apiKey },
            body: form
          });

          const responseText = await upstreamResponse.text();
          if (!upstreamResponse.ok) {
            throw new Error(`voiceclone失败：HTTP ${upstreamResponse.status}`);
          }

          const audioData = extractAudioData(parseJson(responseText));
          if (!audioData) {
            throw new Error("voiceclone响应中没有音频数据");
          }

          product.audioDataUrl = `data:audio/wav;base64,${audioData}`;
        } else {
          // 使用 voicedesign（旁白或无音色的角色）
          const voiceDescription = "自然、清晰的中文叙述音色，语速适中，语气沉稳。";
          const payload: MimoVoiceDesignPayload = {
            model: "mimo-v2.5-tts-voicedesign",
            messages: [
              { role: "user", content: voiceDescription },
              { role: "assistant", content: product.text }
            ],
            audio: { format: "wav" }
          };

          const upstreamResponse = await fetch(apiEndpoint, {
            method: "POST",
            headers: { "api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          const responseText = await upstreamResponse.text();
          if (!upstreamResponse.ok) {
            throw new Error(`voicedesign失败：HTTP ${upstreamResponse.status}`);
          }

          const audioData = extractAudioData(parseJson(responseText));
          if (!audioData) {
            throw new Error("voicedesign响应中没有音频数据");
          }

          product.audioDataUrl = `data:audio/wav;base64,${audioData}`;
        }

        product.status = "ready";
        product.elapsedMs = Date.now() - startMs;
      } catch (err) {
        product.status = "error";
        product.error = err instanceof Error ? err.message : "生成失败";
        product.elapsedMs = Date.now() - startMs;
      }

      await writeWorkspaceStore(store);
    }

    res.json({ products: workspace.products });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tts/voicedesign", async (req: Request<unknown, unknown, VoiceDesignPayload>, res, next) => {
  const startedAt = Date.now();

  try {
    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const voiceDescription = String(req.body?.voiceDescription || "").trim();
    const text = String(req.body?.text || "").trim();
    const instruction = String(req.body?.instruction || "").trim();
    const outputFormat = String(req.body?.format || "wav").trim();

    if (outputFormat !== "wav") {
      return res.status(400).json({ error: "Only wav output is supported in this debugger." });
    }

    if (!voiceDescription) {
      return res.status(400).json({ error: "Voice design description is required." });
    }

    if (!text) {
      return res.status(400).json({ error: "Synthesis text is required." });
    }

    const payload: MimoVoiceDesignPayload = {
      model: "mimo-v2.5-tts-voicedesign",
      messages: [
        { role: "user", content: voiceDescription },
        { role: "assistant", content: text }
      ],
      audio: {
        format: "wav"
      }
    };

    const upstreamResponse = await fetch(apiEndpoint, {
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
        error: "MiMo voice design request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText,
        request: redactVoiceDesignPayload(payload)
      });
    }

    if (!parsed) {
      return res.status(502).json({
        error: "MiMo API returned a non-JSON response.",
        elapsedMs,
        details: responseText.slice(0, 1000),
        request: redactVoiceDesignPayload(payload)
      });
    }

    const audioData = extractAudioData(parsed);
    if (!audioData) {
      return res.status(502).json({
        error: "MiMo API response did not include choices[0].message.audio.data.",
        elapsedMs,
        details: parsed,
        request: redactVoiceDesignPayload(payload)
      });
    }

    res.json({
      audioDataUrl: `data:audio/wav;base64,${audioData}`,
      fileName: `mimo-voicedesign-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`,
      elapsedMs,
      request: redactVoiceDesignPayload(payload),
      response: {
        audioBytesApprox: Math.floor((audioData.length * 3) / 4),
        choiceCount: getChoiceCount(parsed)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tts/voiceclone", upload.single("voice"), async (req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now();

  try {
    const { apiKey, apiEndpoint } = getApiConfig(req);
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

    const upstreamResponse = await fetch(apiEndpoint, {
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

if (staticDir) {
  app.use(express.static(staticDir));
  app.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

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

export function startServer(listenPort = port, host?: string) {
  const server = host ? app.listen(listenPort, host) : app.listen(listenPort);

  server.once("listening", () => {
    const address = server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : listenPort;
    const resolvedHost = host || "localhost";
    console.log(`MiMo voice clone proxy listening on http://${resolvedHost}:${resolvedPort}`);
  });

  return server;
}

export { app };

if (process.env.MIMO_NO_AUTO_LISTEN !== "1") {
  startServer(port);
}

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

function extractMessageContent(value: unknown): string | null {
  const response = value as MimoResponse;
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
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

function redactVoiceDesignPayload(payload: MimoVoiceDesignPayload) {
  return payload;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

function splitScriptSegments(script: string): string[] {
  return script
    .split(/\n?\s*----\s*\n?/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSmartWorkspacePrompt(sceneDescription: string, scriptSegments: string[]): string {
  return [
    "请为下面的有声内容台词生成智能画板分段规划。",
    "",
    "整体场景描述：",
    sceneDescription,
    "",
    "分段台词：",
    scriptSegments.map((segment, index) => `第 ${index + 1} 段：\n${segment}`).join("\n\n"),
    "",
    "输出要求：",
    "1. 只输出严格 JSON，不要 Markdown，不要代码块，不要解释。",
    "2. 不要改写台词正文；你只负责生成 workspaceName、每段 title 和 directorText。",
    "3. segments 数量必须与分段台词数量完全一致，index 从 1 开始连续递增。",
    "4. 每段 directorText 必须主要描述整体氛围、情绪基调、角色心理状态、表达质感和表演意图。",
    "5. directorText 不要引用具体台词，不要写“在某句话后停顿”“重音放在某个词上”这类逐句朗读指令。",
    "6. directorText 可以描述整体语速和语气，但不要包含具体停顿位置、具体重音位置或逐字逐句的读法。",
    "7. title 应简短，适合用作画板节点名称。",
    "",
    "JSON 结构必须是：",
    '{"workspaceName":"string","segments":[{"index":1,"title":"string","directorText":"string"}]}'
  ].join("\n");
}

function buildSmartVoiceDesignWorkspacePrompt(sceneDescription: string, scriptSegments: string[]): string {
  return [
    "请为下面的有声内容台词生成智能画板分段规划。用户没有提供参考音频，后续会使用文本设计音色的方式合成每段音频。",
    "",
    "整体场景描述：",
    sceneDescription,
    "",
    "分段台词：",
    scriptSegments.map((segment, index) => `第 ${index + 1} 段：\n${segment}`).join("\n\n"),
    "",
    "输出要求：",
    "1. 只输出严格 JSON，不要 Markdown，不要代码块，不要解释。",
    "2. 不要改写台词正文；你只负责生成 workspaceName、voiceDescription、每段 title 和 directorText。",
    "3. voiceDescription 是贯穿所有片段的统一音色描述，必须适合 mimo-v2.5-tts-voicedesign 模型，输出 1 到 4 句中文。",
    "4. voiceDescription 应描述性别与年龄、声音质感、情绪/语气、语速/节奏，可适度包含角色身份、说话风格或使用场景。",
    "5. 每段应尽可能保持同一音色；voiceDescription 需要能覆盖全部片段的共同声音底色。",
    "6. segments 数量必须与分段台词数量完全一致，index 从 1 开始连续递增。",
    "7. directorText 用于记录每段建议的整体语速、表达氛围、情绪层次和表演意图；不要引用具体台词，不要写“在某句话后停顿”“重音放在某个词上”这类逐句朗读指令。",
    "8. 不要使用混响、回声、EQ、压缩、母带等后期制作或音频工程术语。",
    "9. title 应简短，适合用作画板节点名称。",
    "",
    "JSON 结构必须是：",
    '{"workspaceName":"string","voiceDescription":"string","segments":[{"index":1,"title":"string","directorText":"string"}]}'
  ].join("\n");
}

function parseSmartWorkspacePlan(content: string): SmartWorkspacePlan | null {
  const trimmed = content.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""),
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
  ].filter((value) => value.trim().startsWith("{") && value.trim().endsWith("}"));

  for (const candidate of candidates) {
    const parsed = parseJson(candidate);
    if (parsed && typeof parsed === "object") {
      return parsed as SmartWorkspacePlan;
    }
  }

  return null;
}

function normalizeSmartWorkspaceSegments(plan: SmartWorkspacePlan, expectedCount: number): SmartWorkspaceSegment[] | null {
  if (!Array.isArray(plan.segments) || plan.segments.length !== expectedCount) {
    return null;
  }

  const segments = plan.segments.map((item, index) => {
    const segment = item as { index?: unknown; title?: unknown; directorText?: unknown };
    const segmentIndex = Number(segment.index);
    return {
      index: Number.isFinite(segmentIndex) ? segmentIndex : index + 1,
      title: String(segment.title || `第 ${index + 1} 段`).trim(),
      directorText: String(segment.directorText || "").trim()
    };
  });

  if (segments.some((segment, index) => segment.index !== index + 1 || !segment.title || !segment.directorText)) {
    return null;
  }

  return segments;
}

function createSmartWorkspace({
  workspaceName,
  scriptSegments,
  segments,
  file,
  voiceMime,
  voiceDescription
}: {
  workspaceName: string;
  sceneDescription: string;
  scriptSegments: string[];
  segments: SmartWorkspaceSegment[];
  file?: Express.Multer.File;
  voiceMime: "audio/mp3" | "audio/m4a" | "audio/wav" | null;
  voiceDescription: string;
}): StoredWorkspace {
  const now = new Date().toISOString();
  const workspaceId = createId("board");
  const referenceNodeId = file && voiceMime ? createId("referenceAudio") : "";
  const nodes: unknown[] = [];
  if (file && voiceMime) {
    const audioDataUrl = `data:${voiceMime};base64,${file.buffer.toString("base64")}`;
    nodes.push({
      id: referenceNodeId,
      type: "referenceAudio",
      position: { x: 40, y: 80 },
      data: {
        title: "参考音频",
        text: "声音样本",
        audio: {
          fileName: file.originalname,
          mimeType: voiceMime,
          size: file.size,
          dataUrl: audioDataUrl
        }
      }
    });
  }
  const edges: unknown[] = [];
  const designNodeId = file && voiceMime ? "" : createId("voiceDesign");
  if (!file || !voiceMime) {
    nodes.push({
      id: designNodeId,
      type: "voiceDesign",
      position: { x: 560, y: 120 },
      data: {
        title: "统一音色创造",
        instruction: voiceDescription || "自然、清晰、贴近内容场景的中文叙述音色。",
        text: ""
      }
    });
  }

  segments.forEach((segment, index) => {
    const y = 80 + index * 300;
    const segmentTitle = segment.title || `第 ${index + 1} 段`;

    if (file && voiceMime) {
      const styleNodeId = createId("voiceStyle");
      const promptNodeId = createId("prompt");
      const cloneNodeId = createId("voiceClone");
      nodes.push({
        id: styleNodeId,
        type: "voiceStyle",
        position: { x: 400, y },
        data: {
          title: `${segmentTitle} 导演`,
          text: segment.directorText
        }
      });
      nodes.push({
        id: promptNodeId,
        type: "prompt",
        position: { x: 400, y: y + 150 },
        data: {
          title: `${segmentTitle} 台词`,
          text: scriptSegments[index]
        }
      });
      nodes.push({
        id: cloneNodeId,
        type: "voiceClone",
        position: { x: 820, y: y + 60 },
        data: {
          title: `${segmentTitle} 克隆`,
          instruction: segment.directorText,
          text: scriptSegments[index]
        }
      });

      edges.push(
        createWorkflowEdge(referenceNodeId, "audio", cloneNodeId, "voice"),
        createWorkflowEdge(styleNodeId, "style", cloneNodeId, "instruction"),
        createWorkflowEdge(promptNodeId, "text", cloneNodeId, "text")
      );
      return;
    }

    const promptNodeId = createId("prompt");
    nodes.push({
      id: promptNodeId,
      type: "prompt",
      position: { x: 120, y },
      data: {
        title: `${segmentTitle} 台词`,
        text: scriptSegments[index]
      }
    });
    edges.push(createWorkflowEdge(promptNodeId, "text", designNodeId, "text"));
  });

  return {
    id: workspaceId,
    type: "board",
    name: workspaceName,
    createdAt: now,
    updatedAt: now,
    nodes,
    edges,
    stashItems: []
  };
}

function createWorkflowEdge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return {
    id: createId("edge"),
    source,
    sourceHandle,
    target,
    targetHandle,
    type: "deletable",
    animated: true,
    style: { stroke: "#c5a45d", strokeWidth: 2 }
  };
}

async function readWorkspaceStore(): Promise<WorkspaceStore> {
  await workspaceWriteQueue;
  return readWorkspaceStoreNow();
}

async function readWorkspaceStoreNow(): Promise<WorkspaceStore> {
  try {
    const raw = await readFile(workspaceFilePath, "utf-8");
    return normalizeWorkspaceStore(parseWorkspaceStore(raw));
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
          type: "board",
          name: "默认工作台",
          createdAt: now,
          updatedAt: now,
          nodes: [],
          edges: [],
          stashItems: []
        }
      ]
    };
    await writeWorkspaceStoreNow(initial);
    return initial;
  }
}

async function writeWorkspaceStore(store: WorkspaceStore): Promise<void> {
  const writeOperation = workspaceWriteQueue.then(() => writeWorkspaceStoreNow(store));
  workspaceWriteQueue = writeOperation.catch(() => undefined);
  return writeOperation;
}

async function writeWorkspaceStoreNow(store: WorkspaceStore): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const tempPath = `${workspaceFilePath}.${process.pid}.${Date.now()}.${workspaceWriteSequence++}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), "utf-8");
  try {
    await renameWithRetry(tempPath, workspaceFilePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  const retryableCodes = new Set(["EPERM", "EACCES", "EBUSY"]);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : "";
      if (!retryableCodes.has(code || "") || attempt === 7) {
        throw error;
      }
      await delay(40 * (attempt + 1));
    }
  }
}

async function updateAudiobookCharacter(
  workspaceId: string,
  characterId: string,
  update: (character: AudiobookCharacter, workspace: StoredAudiobookWorkspace) => void
): Promise<AudiobookCharacter> {
  const operation = workspaceWriteQueue.then(async () => {
    const store = await readWorkspaceStoreNow();
    const workspace = store.workspaces.find((w) => w.id === workspaceId);
    if (!workspace || workspace.type !== "audiobook") {
      throw Object.assign(new Error("Audiobook workspace not found."), { status: 404 });
    }

    const character = workspace.characters.find((c) => c.id === characterId);
    if (!character) {
      throw Object.assign(new Error("Audiobook character not found."), { status: 404 });
    }

    update(character, workspace);
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStoreNow(store);
    return { ...character };
  });

  workspaceWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWorkspaceStore(raw: string): { activeWorkspaceId?: string | null; workspaces?: Record<string, unknown>[] } {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const recovered = parseFirstJsonObject(raw);
    if (recovered) {
      return recovered as { activeWorkspaceId?: string | null; workspaces?: Record<string, unknown>[] };
    }

    throw error;
  }
}

function parseFirstJsonObject(raw: string): unknown | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(0, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function normalizeWorkspaceStore(parsed: { activeWorkspaceId?: string | null; workspaces?: Record<string, unknown>[] }): WorkspaceStore {
  const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces.map(normalizeStoredWorkspace) : [];
  return {
    activeWorkspaceId: parsed.activeWorkspaceId ?? workspaces[0]?.id ?? null,
    workspaces
  };
}

function normalizeWorkspaceName(value: unknown): string {
  const name = String(value || "").trim();
  return name || `未命名工作台 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStoredWorkspace(raw: Record<string, unknown>): StoredWorkspace {
  // 向后兼容：旧数据没有 type 字段，默认为 board
  const type = (raw.type as string) || "board";

  if (type === "audiobook") {
    return {
      id: String(raw.id || ""),
      type: "audiobook",
      name: String(raw.name || ""),
      createdAt: String(raw.createdAt || ""),
      updatedAt: String(raw.updatedAt || ""),
      novelText: String(raw.novelText || ""),
      characterHints: String(raw.characterHints || ""),
      characters: Array.isArray(raw.characters) ? raw.characters as AudiobookCharacter[] : [],
      segments: Array.isArray(raw.segments) ? raw.segments as AudiobookSegment[] : [],
      products: Array.isArray(raw.products) ? raw.products as AudiobookProduct[] : [],
      phase: (raw.phase as StoredAudiobookWorkspace["phase"]) || "character-creation"
    };
  }
  return {
    id: String(raw.id || ""),
    type: "board",
    name: String(raw.name || ""),
    createdAt: String(raw.createdAt || ""),
    updatedAt: String(raw.updatedAt || ""),
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
    stashItems: Array.isArray(raw.stashItems) ? raw.stashItems : [],
    viewport: raw.viewport
  };
}
