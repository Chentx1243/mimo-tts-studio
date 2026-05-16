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
const workspacesDir = path.join(dataDir, "workspaces");
const workspaceFilePath = path.join(dataDir, "workspaces.json");
const settingsFilePath = path.join(dataDir, "settings.json");
const audiobookProductTimeoutMs = 60000;
let workspaceWriteQueue: Promise<void> = Promise.resolve();
let workspaceWriteSequence = 0;
const activeAudiobookGenerationJobs = new Set<string>();

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
  thinking?: {
    type: "enabled" | "disabled";
  };
};

type AudiobookSegmentationItem = {
  speaker?: unknown;
  text?: unknown;
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

type ApiSettings = {
  apiKey?: string;
  apiEndpoint?: string;
};

// ====== 有声书专用类型 ======

type AudiobookCharacter = {
  id: string;
  name: string;
  roleType: "narrator" | "protagonist" | "supporting" | "custom";
  aliases: string[];
  voiceSource: "analysis" | "manualDesign" | "manualClone";
  voiceMode: "designed" | "cloned";
  isSystem?: boolean;
  isVoiceLocked?: boolean;
  gender: string;
  age: string;
  voiceTraits: string;
  personality: string;
  voiceDescription: string;
  voiceSampleText?: string;
  voiceDataUrl: string | null;
  voiceStatus: "pending" | "generating" | "ready" | "error";
  voiceError?: string;
  referenceAudioDataUrl?: string;
  referenceAudioFileName?: string;
  referenceAudioMimeType?: string;
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

type AudiobookChapter = {
  id: string;
  title: string;
  novelText: string;
  characterHints: string;
  segments: AudiobookSegment[];
  products: AudiobookProduct[];
  phase: "character-creation" | "annotation" | "generation";
  createdAt: string;
  updatedAt: string;
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
  activeChapterId: string;
  novelText: string;
  characterHints: string;
  characters: AudiobookCharacter[];
  segments: AudiobookSegment[];
  products: AudiobookProduct[];
  phase: "character-creation" | "annotation" | "generation";
  chapters: AudiobookChapter[];
};

type StoredWorkspace = StoredBoardWorkspace | StoredAudiobookWorkspace;

type WorkspaceStore = {
  activeWorkspaceId: string | null;
  workspaces: StoredWorkspace[];
};

type WorkspaceIndexItem = {
  id: string;
  type: "board" | "audiobook";
  name: string;
  createdAt: string;
  updatedAt: string;
};

type WorkspaceIndex = {
  activeWorkspaceId: string | null;
  workspaces: WorkspaceIndexItem[];
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

app.get("/api/settings", async (_req, res, next) => {
  try {
    const settings = await readApiSettings();
    res.json({
      apiKey: settings.apiKey ?? process.env.MIMO_API_KEY ?? "",
      apiEndpoint: settings.apiEndpoint ?? mimoEndpoint,
      configured: Boolean(settings.apiKey || process.env.MIMO_API_KEY)
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (req: Request<unknown, unknown, ApiSettings>, res, next) => {
  try {
    const apiKey = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
    const apiEndpoint = typeof req.body.apiEndpoint === "string" ? req.body.apiEndpoint.trim() : "";

    if (!apiKey) {
      return res.status(400).json({ error: "API Key is required." });
    }

    const settings: ApiSettings = {
      apiKey,
      apiEndpoint: apiEndpoint || mimoEndpoint
    };

    await writeApiSettings(settings);
    res.json({
      apiKey: settings.apiKey,
      apiEndpoint: settings.apiEndpoint,
      configured: true
    });
  } catch (error) {
    next(error);
  }
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
    const updated = await updateWorkspace(req.params.id, (current) => {
      const now = new Date().toISOString();

      if (current.type === "audiobook") {
        const chapter = getActiveAudiobookChapter(current);
        const isGenerating = chapter.products.some((product) => product.status === "pending" || product.status === "generating");
        const hasBaseUpdatedAt = typeof req.body?.baseUpdatedAt === "string";
        const isStaleSave = hasBaseUpdatedAt && req.body.baseUpdatedAt !== current.updatedAt;
        const nextCharacters = !isStaleSave && Array.isArray(req.body?.characters)
          ? ensureNarratorCharacter(req.body.characters)
          : current.characters;
        if (!isStaleSave) {
          chapter.novelText = String(req.body?.novelText ?? chapter.novelText);
          chapter.characterHints = String(req.body?.characterHints ?? chapter.characterHints);
          chapter.segments = Array.isArray(req.body?.segments) ? req.body.segments : chapter.segments;
          chapter.products = isGenerating
            ? chapter.products
            : Array.isArray(req.body?.products)
              ? req.body.products
              : chapter.products;
          chapter.phase = isGenerating ? "generation" : req.body?.phase ?? chapter.phase;
          chapter.updatedAt = now;
        }
        current.characters = nextCharacters;
        syncAudiobookWorkspaceFromChapter(current, chapter);
        return {
          ...current,
          name: normalizeWorkspaceName(req.body?.name ?? current.name),
          updatedAt: now,
          phase: isGenerating ? "generation" : isStaleSave ? current.phase : current.phase
        };
      }

      return {
        ...current,
        name: normalizeWorkspaceName(req.body?.name ?? current.name),
        updatedAt: now,
        nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : current.nodes,
        edges: Array.isArray(req.body?.edges) ? req.body.edges : current.edges,
        stashItems: Array.isArray(req.body?.stashItems) ? req.body.stashItems : current.stashItems,
        viewport: req.body?.viewport ?? current.viewport
      };
    });
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

    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({ error: "MIMO_API_KEY is not configured." });
    }

    const segmentedTexts = await segmentAudiobookText(novelText, apiKey, apiEndpoint);
    const segments: AudiobookSegment[] = segmentedTexts.map((text: string, index: number) => ({
      id: `seg-${Date.now().toString(36)}-${index}`,
      text,
      characterId: null,
      characterName: "",
      emotion: "",
      isAutoAnnotated: false
    }));
    const chapter: AudiobookChapter = {
      id: createId("chapter"),
      title: String(req.body?.chapterTitle || "章节 1"),
      novelText,
      characterHints,
      segments,
      products: [],
      phase: "character-creation",
      createdAt: now,
      updatedAt: now
    };

    const workspace: StoredAudiobookWorkspace = {
      id: `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "audiobook",
      name: req.body?.name || `有声书 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      createdAt: now,
      updatedAt: now,
      activeChapterId: chapter.id,
      novelText,
      characterHints,
      characters: [createAudiobookNarrator(now)],
      segments,
      products: [],
      phase: "character-creation",
      chapters: [chapter]
    };

    store.workspaces.unshift(workspace);
    store.activeWorkspaceId = workspace.id;
    await writeWorkspaceStore(store);
    res.status(201).json(workspace);
  } catch (error) {
    next(error);
  }
});

app.post("/api/audiobook/:id/chapters", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }

    const novelText = String(req.body?.novelText || "").trim();
    const characterHints = String(req.body?.characterHints || "").trim();
    if (!novelText) {
      return res.status(400).json({ error: "小说原文不能为空。" });
    }

    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({ error: "MIMO_API_KEY is not configured." });
    }

    const now = new Date().toISOString();
    const segmentedTexts = await segmentAudiobookText(novelText, apiKey, apiEndpoint);
    const chapter: AudiobookChapter = {
      id: createId("chapter"),
      title: String(req.body?.title || `章节 ${workspace.chapters.length + 1}`),
      novelText,
      characterHints,
      segments: segmentedTexts.map((text: string, index: number) => ({
        id: `seg-${Date.now().toString(36)}-${index}`,
        text,
        characterId: null,
        characterName: "",
        emotion: "",
        isAutoAnnotated: false
      })),
      products: [],
      phase: "character-creation",
      createdAt: now,
      updatedAt: now
    };
    workspace.chapters.push(chapter);
    workspace.activeChapterId = chapter.id;
    syncAudiobookWorkspaceFromChapter(workspace, chapter);
    workspace.updatedAt = now;
    await writeWorkspaceStore(store);
    res.status(201).json({ workspace, chapter });
  } catch (error) {
    next(error);
  }
});

app.put("/api/audiobook/:id/chapters/:chapterId", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }

    const chapter = workspace.chapters.find((item) => item.id === req.params.chapterId);
    if (!chapter) {
      return res.status(404).json({ error: "章节不存在。" });
    }

    const nextNovelText = typeof req.body?.novelText === "string" ? req.body.novelText.trim() : chapter.novelText;
    const shouldResegment = nextNovelText !== chapter.novelText;
    if (shouldResegment && !nextNovelText) {
      return res.status(400).json({ error: "小说原文不能为空。" });
    }

    if (shouldResegment) {
      const { apiKey, apiEndpoint } = getApiConfig(req);
      if (!apiKey) {
        return res.status(500).json({ error: "MIMO_API_KEY is not configured." });
      }
      const segmentedTexts = await segmentAudiobookText(nextNovelText, apiKey, apiEndpoint);
      chapter.novelText = nextNovelText;
      chapter.segments = segmentedTexts.map((text: string, index: number) => ({
        id: `seg-${Date.now().toString(36)}-${index}`,
        text,
        characterId: null,
        characterName: "",
        emotion: "",
        isAutoAnnotated: false
      }));
      chapter.products = [];
      chapter.phase = "character-creation";
    }

    chapter.title = String(req.body?.title || chapter.title);
    chapter.characterHints = typeof req.body?.characterHints === "string" ? req.body.characterHints : chapter.characterHints;
    chapter.updatedAt = new Date().toISOString();
    workspace.activeChapterId = chapter.id;
    syncAudiobookWorkspaceFromChapter(workspace, chapter);
    workspace.updatedAt = chapter.updatedAt;
    await writeWorkspaceStore(store);
    res.json({ workspace, chapter });
  } catch (error) {
    next(error);
  }
});

app.post("/api/audiobook/:id/chapters/:chapterId/activate", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }
    const chapter = workspace.chapters.find((item) => item.id === req.params.chapterId);
    if (!chapter) {
      return res.status(404).json({ error: "章节不存在。" });
    }
    syncAudiobookWorkspaceFromChapter(workspace, chapter);
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStore(store);
    res.json({ workspace, chapter });
  } catch (error) {
    next(error);
  }
});

app.post("/api/audiobook/:id/characters", upload.single("voice"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((w) => w.id === req.params.id);
    if (!workspace || workspace.type !== "audiobook") {
      return res.status(404).json({ error: "有声书工作区不存在。" });
    }

    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "角色名称不能为空。" });
    }

    const voiceMime = req.file ? resolveVoiceMimeType(req.file) : null;
    if (req.file && !voiceMime) {
      return res.status(400).json({ error: "仅支持 mp3、m4a/mp4 或 wav 参考音频。" });
    }

    const referenceAudioDataUrl = req.file && voiceMime ? `data:${voiceMime};base64,${req.file.buffer.toString("base64")}` : undefined;
    const rawRoleType = String(req.body?.roleType || "");
    const requestedRoleType: AudiobookCharacter["roleType"] | "" =
      rawRoleType === "narrator" || rawRoleType === "protagonist" || rawRoleType === "supporting" || rawRoleType === "custom"
        ? rawRoleType
        : "";
    const existingNarrator = (requestedRoleType === "narrator" || name === "旁白")
      ? workspace.characters.find((item) => item.roleType === "narrator" || item.name === "旁白")
      : undefined;
    if (existingNarrator) {
      existingNarrator.aliases = String(req.body?.aliases || "").split(/[,，、;；\n]/).map((item) => item.trim()).filter(Boolean);
      existingNarrator.voiceTraits = String(req.body?.voiceTraits || existingNarrator.voiceTraits);
      existingNarrator.personality = String(req.body?.personality || existingNarrator.personality);
      existingNarrator.voiceDescription = String(req.body?.voiceDescription || existingNarrator.voiceDescription);
      existingNarrator.voiceSource = referenceAudioDataUrl ? "manualClone" : "manualDesign";
      existingNarrator.voiceMode = referenceAudioDataUrl ? "cloned" : "designed";
      if (referenceAudioDataUrl) {
        existingNarrator.voiceDataUrl = referenceAudioDataUrl;
        existingNarrator.referenceAudioDataUrl = referenceAudioDataUrl;
        existingNarrator.referenceAudioFileName = req.file?.originalname;
        existingNarrator.referenceAudioMimeType = voiceMime ?? undefined;
        existingNarrator.voiceStatus = "ready";
        existingNarrator.voiceError = undefined;
        existingNarrator.isVoiceLocked = true;
      }
      workspace.characters = ensureNarratorCharacter(workspace.characters);
      workspace.updatedAt = new Date().toISOString();
      await writeWorkspaceStore(store);
      return res.json({ character: existingNarrator, characters: workspace.characters });
    }

    const character = normalizeAudiobookCharacter({
      id: createId("char"),
      name,
      roleType: requestedRoleType || undefined,
      aliases: String(req.body?.aliases || "").split(/[,，、;；\n]/).map((item) => item.trim()).filter(Boolean),
      voiceSource: referenceAudioDataUrl ? "manualClone" : "manualDesign",
      voiceMode: referenceAudioDataUrl ? "cloned" : "designed",
      gender: req.body?.gender,
      age: req.body?.age,
      voiceTraits: req.body?.voiceTraits,
      personality: req.body?.personality,
      voiceDescription: req.body?.voiceDescription,
      voiceDataUrl: referenceAudioDataUrl ?? null,
      voiceStatus: referenceAudioDataUrl ? "ready" : "pending",
      referenceAudioDataUrl,
      referenceAudioFileName: req.file?.originalname,
      referenceAudioMimeType: voiceMime ?? undefined,
      isVoiceLocked: Boolean(referenceAudioDataUrl)
    });

    workspace.characters = ensureNarratorCharacter([...workspace.characters, character]);
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStore(store);
    res.status(201).json({ character, characters: workspace.characters });
  } catch (error) {
    next(error);
  }
});

app.put("/api/audiobook/:id/characters/:charId", upload.single("voice"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updatedCharacter = await updateAudiobookCharacter(String(req.params.id), String(req.params.charId), (target) => {
      const voiceMime = req.file ? resolveVoiceMimeType(req.file) : null;
      if (req.file && !voiceMime) {
        throw Object.assign(new Error("仅支持 mp3、m4a/mp4 或 wav 参考音频。"), { status: 400 });
      }
      if (!target.isSystem) {
        target.name = String(req.body?.name || target.name).trim() || target.name;
        const nextRoleType = String(req.body?.roleType || "");
        if (nextRoleType === "narrator" || nextRoleType === "protagonist" || nextRoleType === "supporting" || nextRoleType === "custom") {
          target.roleType = nextRoleType;
        }
      }
      target.aliases = typeof req.body?.aliases === "string"
        ? String(req.body.aliases).split(/[,，、;；\n]/).map((item: string) => item.trim()).filter(Boolean)
        : target.aliases;
      target.gender = req.body?.gender ?? target.gender;
      target.age = req.body?.age ?? target.age;
      target.voiceTraits = req.body?.voiceTraits ?? target.voiceTraits;
      target.personality = req.body?.personality ?? target.personality;
      target.voiceDescription = req.body?.voiceDescription ?? target.voiceDescription;
      target.isVoiceLocked = req.body?.isVoiceLocked === "true" || req.body?.isVoiceLocked === true;
      if (req.file && voiceMime) {
        const dataUrl = `data:${voiceMime};base64,${req.file.buffer.toString("base64")}`;
        target.voiceSource = "manualClone";
        target.voiceMode = "cloned";
        target.voiceDataUrl = dataUrl;
        target.referenceAudioDataUrl = dataUrl;
        target.referenceAudioFileName = req.file.originalname;
        target.referenceAudioMimeType = voiceMime;
        target.voiceStatus = "ready";
        target.voiceError = undefined;
        target.isVoiceLocked = true;
      }
    });
    res.json({ character: updatedCharacter });
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
    const chapter = getActiveAudiobookChapter(workspace);

    const systemPrompt = `你是一位专业的有声书制作导演和角色分析师。
你的任务是从小说原文中识别出所有出场人物，并为每个人物生成音色描述。

要求：
1. 识别原文中所有有台词或明确出场的人物，忽略仅一笔带过的背景人物。
2. 对每个人物，综合用户提供的背景信息和原文描写，给出：
   - name：角色名（使用原文中的名字）
   - personality：2-3句话的性格/气质描述，用于指导朗读表演
   - voiceDescription：1-3句话的音色描述，必须适合TTS音色设计模型，只描述人物基本信息和稳定声音特征，包含：性别与年龄段、身份/气质、声音质感（如浑厚/清亮/沙哑/甜美）。不要描述语速、节奏、情感、语气或表演状态。
3. voiceDescription不要使用混响、回声、EQ等音频工程术语。
4. 如果用户已提供某角色的背景信息，voiceDescription必须与之一致，不要自行修改性别或年龄。
5. voiceDescription必须是静态音色设定，不要写“沉稳地”“焦急地”“缓慢地”“快速地”等朗读指导。
6. "旁白/叙述者"不要作为角色列出，旁白将在合成阶段单独处理。

只输出严格JSON，不要Markdown，不要解释。
JSON结构：{"characters":[{"name":"string","personality":"string","voiceDescription":"string"}]}`;

    const userMessage = `用户提供的关键人物背景信息：
${chapter.characterHints || "（无）"}

小说原文：
${chapter.novelText}

请分析出场人物并生成音色描述。`;

    const payload: MimoChatPayload = {
      model: "mimo-v2-omni",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.35,
      top_p: 0.9,
      thinking: { type: "disabled" }
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
    const hintsLines = chapter.characterHints.split("\n").filter(Boolean);
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

    const nextCharacters = ensureNarratorCharacter(workspace.characters);
    for (const c of charactersData) {
      const hint = hintMap.get(c.name);
      const matched = nextCharacters.find((character) =>
        character.name === c.name || character.aliases.includes(c.name)
      );
      if (matched) {
        matched.personality = c.personality || matched.personality;
        if (!matched.isVoiceLocked && !matched.voiceDataUrl) {
          matched.gender = hint?.gender || matched.gender;
          matched.age = hint?.age || matched.age;
          matched.voiceTraits = hint?.voiceTraits || matched.voiceTraits;
          matched.voiceDescription = c.voiceDescription || matched.voiceDescription;
        }
        continue;
      }
      nextCharacters.push({
        id: `char-${Date.now().toString(36)}-${nextCharacters.length}`,
        name: c.name,
        roleType: nextCharacters.length === 1 ? "protagonist" : "supporting",
        aliases: [],
        voiceSource: "analysis",
        voiceMode: "designed",
        isVoiceLocked: false,
        gender: hint?.gender || "",
        age: hint?.age || "",
        voiceTraits: hint?.voiceTraits || "",
        personality: c.personality,
        voiceDescription: c.voiceDescription,
        voiceSampleText: undefined,
        voiceDataUrl: null,
        voiceStatus: "pending" as const
      });
    }

    workspace.characters = nextCharacters;
    chapter.phase = "character-creation";
    chapter.updatedAt = new Date().toISOString();
    syncAudiobookWorkspaceFromChapter(workspace, chapter);
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStore(store);

    res.json({ characters: workspace.characters, chapter });
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

    if (character.voiceMode === "cloned" && character.referenceAudioDataUrl) {
      const updatedCharacter = await updateAudiobookCharacter(req.params.id, req.params.charId, (target) => {
        target.voiceDataUrl = character.referenceAudioDataUrl || target.voiceDataUrl;
        target.voiceStatus = "ready";
        target.voiceError = undefined;
        target.isVoiceLocked = true;
      });
      return res.json({ character: updatedCharacter });
    }

    await updateAudiobookCharacter(req.params.id, req.params.charId, (target) => {
      target.voiceStatus = "generating";
      target.voiceError = undefined;
    });

    let optimizedVoiceDescription: string;
    try {
      optimizedVoiceDescription = await optimizeAudiobookCharacterVoiceDescription(character, apiKey, apiEndpoint);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "音色描述优化失败";
      const updatedCharacter = await updateAudiobookCharacter(req.params.id, req.params.charId, (target) => {
        target.voiceStatus = "error";
        target.voiceError = errorMessage;
      });
      return res.status(502).json({ error: updatedCharacter.voiceError });
    }

    if (optimizedVoiceDescription && optimizedVoiceDescription !== character.voiceDescription) {
      character.voiceDescription = optimizedVoiceDescription;
      await updateAudiobookCharacter(req.params.id, req.params.charId, (target) => {
        target.voiceDescription = optimizedVoiceDescription;
      });
    }

    const testText = await generateAudiobookCharacterVoiceSampleText(workspace, character, apiKey, apiEndpoint);
    const payload: MimoVoiceDesignPayload = {
      model: "mimo-v2.5-tts-voicedesign",
      messages: [
        { role: "user", content: optimizedVoiceDescription || character.voiceDescription },
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
      target.voiceSampleText = testText;
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

    const chapter = getActiveAudiobookChapter(workspace);
    const characterList = workspace.characters.map((c) => `${c.name}${c.aliases.length ? `（别名：${c.aliases.join("、")}）` : ""}：${c.personality || c.voiceDescription}`).join("\n");
    const segmentList = chapter.segments.map((s, i) => `第${i + 1}段：${s.text}`).join("\n\n");

    const systemPrompt = `你是一位专业的有声书配音导演。
你的任务是为小说的每个文段标注：说话角色和朗读情绪/语气指导。

规则：
1. 判断每个文段是对话还是叙述/描写。
2. 对话：识别说话角色（必须是已注册角色列表中的名字），给出简短的语气描述，并包含情感、语速和场景氛围（如"焦急偏快，压低声""冷淡稍慢，夜色紧绷"）。
3. 叙述/描写：characterName设为"旁白"，emotion描述叙述基调，并包含情感、语速和场景氛围（如"平静中速，日常叙述""紧张偏快，追逐现场""感伤稍慢，回忆场景"）。
4. emotion控制在8-24字，保持简洁自然，不要写复杂的逐句朗读指令。
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
      top_p: 0.9,
      thinking: { type: "disabled" }
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

    const narrator = workspace.characters.find((c) => c.roleType === "narrator" || c.name === "旁白");

    for (const ann of annotations) {
      const segIndex = ann.index - 1;
      if (segIndex >= 0 && segIndex < chapter.segments.length) {
        const seg = chapter.segments[segIndex];
        const matchedChar = ann.characterName === "旁白"
          ? narrator
          : findAudiobookCharacterByNameOrAlias(workspace, ann.characterName);
        seg.characterId = matchedChar?.id || null;
        seg.characterName = matchedChar?.name || ann.characterName;
        seg.emotion = ann.emotion;
        seg.isAutoAnnotated = true;
      }
    }

    chapter.phase = "annotation";
    chapter.updatedAt = new Date().toISOString();
    syncAudiobookWorkspaceFromChapter(workspace, chapter);
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStore(store);

    res.json({ segments: chapter.segments, chapter });
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

    const chapter = getActiveAudiobookChapter(workspace);
    const segment = chapter.segments.find((s) => s.id === req.params.segId);
    if (!segment) {
      return res.status(404).json({ error: "段落不存在。" });
    }

    segment.characterId = req.body?.characterId ?? segment.characterId;
    segment.characterName = req.body?.characterName ?? segment.characterName;
    segment.emotion = req.body?.emotion ?? segment.emotion;
    segment.isAutoAnnotated = false;
    chapter.updatedAt = new Date().toISOString();
    syncAudiobookWorkspaceFromChapter(workspace, chapter);
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

    const chapter = getActiveAudiobookChapter(workspace);
    const hasInProgressProducts = chapter.products.some((product) => product.status === "pending" || product.status === "generating");
    if (hasInProgressProducts) {
      const products = activeAudiobookGenerationJobs.has(req.params.id)
        ? chapter.products
        : await updateAudiobookProducts(req.params.id, (targetWorkspace) => {
          const targetChapter = getActiveAudiobookChapter(targetWorkspace);
          const now = new Date().toISOString();
          for (const product of targetChapter.products) {
            if (product.status === "generating") {
              product.status = "pending";
              product.error = undefined;
              product.elapsedMs = undefined;
              product.createdAt = now;
            }
          }
          targetChapter.phase = "generation";
          targetChapter.updatedAt = now;
          syncAudiobookWorkspaceFromChapter(targetWorkspace, targetChapter);
          return targetChapter.products.map((product) => ({ ...product }));
        });

      startAudiobookGenerationJob(req.params.id, apiKey, apiEndpoint);
      return res.status(202).json({ products, running: true });
    }

    const products = await updateAudiobookProducts(req.params.id, (targetWorkspace) => {
      const charMap = new Map(targetWorkspace.characters.map((c) => [c.id, c]));
      const targetChapter = getActiveAudiobookChapter(targetWorkspace);
      const now = new Date().toISOString();
      targetChapter.products = targetChapter.segments.map((seg) => {
        const character = seg.characterId ? charMap.get(seg.characterId) : undefined;
        return ({
        id: `prod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        segmentId: seg.id,
        characterId: seg.characterId,
        characterName: character?.name || seg.characterName || "未绑定角色",
        text: seg.text,
        instruction: seg.emotion || "自然地朗读",
        audioDataUrl: null,
        status: "pending" as const,
        createdAt: now,
        synthesisMethod: "voiceClone" as const
      });
      });
      targetChapter.phase = "generation";
      targetChapter.updatedAt = now;
      syncAudiobookWorkspaceFromChapter(targetWorkspace, targetChapter);
      return targetChapter.products.map((product) => ({ ...product }));
    });

    startAudiobookGenerationJob(req.params.id, apiKey, apiEndpoint);
    res.status(202).json({ products, running: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/audiobook/:id/products/:productId/retry", async (req, res, next) => {
  try {
    const { apiKey, apiEndpoint } = getApiConfig(req);
    if (!apiKey) {
      return res.status(500).json({ error: "MIMO_API_KEY is not configured." });
    }

    const product = await updateAudiobookProduct(req.params.id, req.params.productId, (target) => {
      target.status = "generating";
      target.audioDataUrl = null;
      target.error = undefined;
      target.elapsedMs = undefined;
      target.createdAt = new Date().toISOString();
    });

    const startMs = Date.now();
    try {
      const audioDataUrl = await synthesizeAudiobookProduct(req.params.id, product, apiKey, apiEndpoint);
      const updatedProduct = await updateAudiobookProduct(req.params.id, product.id, (target) => {
        target.audioDataUrl = audioDataUrl;
        target.status = "ready";
        target.error = undefined;
        target.elapsedMs = Date.now() - startMs;
      });
      res.json({ product: updatedProduct });
    } catch (error) {
      const updatedProduct = await updateAudiobookProduct(req.params.id, product.id, (target) => {
        target.status = "error";
        target.error = error instanceof Error ? error.message : "生成失败";
        target.elapsedMs = Date.now() - startMs;
      });
      res.status(500).json({ product: updatedProduct, error: updatedProduct.error });
    }
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

async function optimizeAudiobookCharacterVoiceDescription(
  character: AudiobookCharacter,
  apiKey: string,
  apiEndpoint: string
): Promise<string> {
  const payload: MimoChatPayload = {
    model: "mimo-v2.5-pro",
    messages: [
      {
        role: "system",
        content: [
          "你是专业的有声书角色音色提示词编辑。",
          "你的任务是把角色信息整理成适合 mimo-v2.5-tts-voicedesign 的音色描述。",
          "",
          "要求：",
          "1. 只描述人物基本信息和稳定声音特征：性别、年龄段、身份/气质、声音质感。",
          "2. 不要描述语速、节奏、情感、语气、场景、动作或表演状态。",
          "3. 不要使用混响、回声、EQ、压缩等音频工程术语。",
          "4. 输出1到3句中文，不要Markdown，不要解释。"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `角色名：${character.name}`,
          `性别：${character.gender || "未知"}`,
          `年龄：${character.age || "未知"}`,
          `人物气质：${character.personality || "未提供"}`,
          `用户音色备注：${character.voiceTraits || "未提供"}`,
          `当前音色描述：${character.voiceDescription || "未提供"}`
        ].join("\n")
      }
    ],
    temperature: 0.2,
    top_p: 0.8,
    thinking: { type: "disabled" }
  };

  const upstreamResponse = await fetch(apiEndpoint, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const responseText = await upstreamResponse.text();
  if (!upstreamResponse.ok) {
    throw Object.assign(new Error(`音色描述优化失败：HTTP ${upstreamResponse.status}`), {
      status: upstreamResponse.status,
      details: responseText
    });
  }

  const content = extractMessageContent(parseJson(responseText));
  if (!content) {
    throw new Error("音色描述优化失败：模型返回内容为空");
  }

  return content.replace(/```(?:text|markdown)?\s*/gi, "").replace(/```\s*/g, "").trim();
}

async function generateAudiobookCharacterVoiceSampleText(
  workspace: StoredAudiobookWorkspace,
  character: AudiobookCharacter,
  apiKey: string,
  apiEndpoint: string
): Promise<string> {
  const context = getCharacterNovelContext(workspace.novelText, character.name);
  const fallbackText = buildFallbackVoiceSampleText(workspace, character);
  const payload: MimoChatPayload = {
    model: "mimo-v2.5-pro",
    messages: [
      {
        role: "system",
        content: [
          "你是专业的有声书试听台词编剧。",
          "任务：为某个角色生成一段用于 TTS 音色试听的中文台词。",
          "",
          "要求：",
          "1. 台词必须贴合小说情节、角色身份、性格和声音气质。",
          "2. 优先改写或提炼原文中该角色可能会说的话；如果原文没有直接台词，可根据上下文生成一句自然的角色台词。",
          "3. 只输出角色会说出口的内容，不要写角色名、旁白、括号、舞台说明或引号。",
          "4. 控制在20到50个汉字，适合试听音色，不要过长。",
          "5. 不要使用固定寒暄句，例如“大家好，我是……很高兴认识你”。",
          "",
          "只输出严格JSON，不要Markdown，不要解释。",
          "JSON结构：{\"text\":\"string\"}"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `角色名：${character.name}`,
          `性别：${character.gender || "未知"}`,
          `年龄：${character.age || "未知"}`,
          `人物特点：${character.personality || "未提供"}`,
          `音色描述：${character.voiceDescription || "未提供"}`,
          `用户音色备注：${character.voiceTraits || "未提供"}`,
          "",
          "小说中与该角色相关的上下文：",
          context || workspace.novelText.slice(0, 3000),
          "",
          `兜底参考句：${fallbackText}`,
          "",
          "请生成该角色的试听台词。"
        ].join("\n")
      }
    ],
    temperature: 0.55,
    top_p: 0.9,
    thinking: { type: "disabled" }
  };

  try {
    const { response: upstreamResponse, text: responseText } = await fetchTextWithTimeout(apiEndpoint, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, 45000);
    if (!upstreamResponse.ok) {
      return fallbackText;
    }

    const content = extractMessageContent(parseJson(responseText));
    const parsedText = parseVoiceSampleText(content || "");
    return parsedText || fallbackText;
  } catch {
    return fallbackText;
  }
}

function getCharacterNovelContext(novelText: string, characterName: string): string {
  const paragraphs = novelText
    .split(/\n{1,}|\r{1,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  const matched: string[] = [];
  for (let index = 0; index < paragraphs.length; index++) {
    if (!paragraphs[index].includes(characterName)) {
      continue;
    }

    const start = Math.max(0, index - 1);
    const end = Math.min(paragraphs.length, index + 2);
    for (let cursor = start; cursor < end; cursor++) {
      if (!matched.includes(paragraphs[cursor])) {
        matched.push(paragraphs[cursor]);
      }
    }
    if (matched.join("\n").length > 2600) {
      break;
    }
  }
  return matched.join("\n").slice(0, 3200);
}

function parseVoiceSampleText(content: string): string {
  const cleaned = content.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim();
  const parsed = parseJson(cleaned) ?? parseJson(cleaned.match(/\{[\s\S]*\}/)?.[0] || "");
  const rawText = typeof (parsed as { text?: unknown } | null)?.text === "string"
    ? String((parsed as { text: string }).text)
    : cleaned;
  return sanitizeVoiceSampleText(rawText);
}

function buildFallbackVoiceSampleText(workspace: StoredAudiobookWorkspace, character: AudiobookCharacter): string {
  const context = getCharacterNovelContext(workspace.novelText, character.name);
  const quoted = context.match(/[“"「『]([^”"」』]{8,60})[”"」』]/)?.[1];
  if (quoted) {
    return sanitizeVoiceSampleText(quoted) || quoted.slice(0, 50);
  }

  const trait = character.personality || character.voiceTraits || character.voiceDescription || "保持镇定";
  if (/紧张|不安|害怕|恐惧|慌/.test(trait)) {
    return "先别慌，告诉我这里到底发生了什么。";
  }
  if (/冷静|沉稳|镇定|理性/.test(trait)) {
    return "现在不是犹豫的时候，我们一步一步来。";
  }
  if (/温柔|善良|柔和|慈祥/.test(trait)) {
    return "别怕，我会陪着你把这件事弄明白。";
  }
  if (/强势|威严|严厉|果断/.test(trait)) {
    return "照我说的做，剩下的事情我来承担。";
  }
  return `${character.name}看着眼前的一切，低声说道，我知道该怎么做。`;
}

function sanitizeVoiceSampleText(value: string): string {
  return value
    .replace(/^[\s"'“”‘’「」『』（）()[\]【】]+|[\s"'“”‘’「」『』（）()[\]【】]+$/g, "")
    .replace(/^(台词|试听台词|text)\s*[:：]\s*/i, "")
    .replace(/\s+/g, "")
    .slice(0, 80)
    .trim();
}

function getChoiceCount(value: unknown): number {
  if (!value || typeof value !== "object" || !("choices" in value)) {
    return 0;
  }

  const choices = (value as { choices?: unknown }).choices;
  return Array.isArray(choices) ? choices.length : 0;
}

async function segmentAudiobookText(novelText: string, apiKey: string, apiEndpoint: string): Promise<string[]> {
  const payload: MimoChatPayload = {
    model: "mimo-v2.5-pro",
    messages: [
      {
        role: "system",
        content: [
          "你是专业的有声书文稿切分助手。",
          "你的任务是把小说原文切分为适合后续配音生成的片段。",
          "",
          "严格规则：",
          "1. 必须遵循原文出现顺序，不能重排、改写、总结或补写。",
          "2. 每个片段只能有一个说话人。",
          "3. 不要将旁白和角色对话混为一段；旁白、每个角色的对话都要拆开。",
          "4. 如果一段文字里同时包含旁白和对话，必须拆成多个片段。",
          "5. 引号内的内容通常是角色台词；引号外的动作、神态、语气、心理、叙述说明通常是旁白，必须单独成段。",
          "6. 如果一句话中出现：台词 + 她/他/某人说道/喃喃道/问道/笑道 + 台词，必须拆成：台词、旁白、台词 三段。",
          "7. 同一角色连续说话可以合并为一段；不同角色连续对话必须拆开。",
          "8. 片段 text 必须尽量保留原文字符，只允许去掉片段首尾多余空白。",
          "9. 输出必须覆盖全部原文内容，不要遗漏。",
          "",
          "切分示例：",
          "原文：“你的内力……”她喃喃道，声音里第一次带上了难以置信的意味，“你练的是什么功法？”",
          "应输出三个连续片段：",
          "1) speaker=角色, text=“你的内力……”",
          "2) speaker=旁白, text=她喃喃道，声音里第一次带上了难以置信的意味，",
          "3) speaker=角色, text=“你练的是什么功法？”",
          "",
          "只输出严格 JSON，不要 Markdown，不要解释。",
          "JSON 结构：{\"segments\":[{\"speaker\":\"旁白或角色名\",\"text\":\"原文片段\"}]}"        ].join("\n")
      },
      {
        role: "user",
        content: `请切分下面的小说原文：\n\n${novelText}`
      }
    ],
    temperature: 0.1,
    top_p: 0.8,
    thinking: { type: "disabled" }
  };

  const upstreamResponse = await fetch(apiEndpoint, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const responseText = await upstreamResponse.text();
  if (!upstreamResponse.ok) {
    throw Object.assign(new Error(`文段切分失败：HTTP ${upstreamResponse.status}`), { status: upstreamResponse.status, details: responseText });
  }

  const content = extractMessageContent(parseJson(responseText));
  if (!content) {
    throw new Error("文段切分失败：模型返回内容为空");
  }

  const segments = parseAudiobookSegmentation(content);
  if (segments.length === 0) {
    throw new Error("文段切分失败：模型没有返回有效片段");
  }

  return segments;
}

function parseAudiobookSegmentation(content: string): string[] {
  const cleaned = content.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
  const parsed = parseJson(cleaned) ?? parseJson(cleaned.match(/\{[\s\S]*\}/)?.[0] || "");
  const rawSegments = (parsed as { segments?: AudiobookSegmentationItem[] } | null)?.segments;
  if (!Array.isArray(rawSegments)) {
    return [];
  }

  return rawSegments
    .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
    .filter(Boolean);
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
  await mkdir(workspacesDir, { recursive: true });

  // 尝试从新的单独文件结构读取
  const indexPath = path.join(workspacesDir, "index.json");
  try {
    const raw = await readFile(indexPath, "utf-8");
    const index = JSON.parse(raw) as WorkspaceIndex;
    const workspaces: StoredWorkspace[] = [];

    for (const item of index.workspaces) {
      const filePath = path.join(workspacesDir, `${item.id}.json`);
      try {
        const content = await readFile(filePath, "utf-8");
        workspaces.push(normalizeStoredWorkspace(JSON.parse(content)));
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : "";
        if (code === "ENOENT") {
          console.warn(`Workspace file not found: ${item.id}.json, skipping`);
        } else {
          throw error;
        }
      }
    }

    return {
      activeWorkspaceId: index.activeWorkspaceId,
      workspaces
    };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : "";
    if (code !== "ENOENT") {
      throw error;
    }
  }

  // 如果新结构不存在，尝试从旧的单文件迁移
  try {
    const raw = await readFile(workspaceFilePath, "utf-8");
    const store = normalizeWorkspaceStore(parseWorkspaceStore(raw));
    await migrateToNewStorage(store);
    return store;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : "";
    if (code !== "ENOENT") {
      throw error;
    }

    // 创建默认工作区
    const now = new Date().toISOString();
    const initial: StoredBoardWorkspace = {
      id: "board-initial",
      type: "board",
      name: "默认工作台",
      createdAt: now,
      updatedAt: now,
      nodes: [],
      edges: [],
      stashItems: []
    };
    const store: WorkspaceStore = {
      activeWorkspaceId: "board-initial",
      workspaces: [initial]
    };
    await migrateToNewStorage(store);
    return store;
  }
}

async function migrateToNewStorage(store: WorkspaceStore): Promise<void> {
  await mkdir(workspacesDir, { recursive: true });

  // 保存每个工作区为单独文件
  for (const workspace of store.workspaces) {
    const filePath = path.join(workspacesDir, `${workspace.id}.json`);
    await writeJsonFile(filePath, workspace);
  }

  // 保存索引文件
  const index: WorkspaceIndex = {
    activeWorkspaceId: store.activeWorkspaceId,
    workspaces: store.workspaces.map((w) => ({
      id: w.id,
      type: w.type,
      name: w.name,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt
    }))
  };
  await writeJsonFile(path.join(workspacesDir, "index.json"), index);
}

async function writeWorkspaceStore(store: WorkspaceStore): Promise<void> {
  const writeOperation = workspaceWriteQueue.then(() => writeWorkspaceStoreNow(store));
  workspaceWriteQueue = writeOperation.catch(() => undefined);
  return writeOperation;
}

async function writeWorkspaceStoreNow(store: WorkspaceStore): Promise<void> {
  await mkdir(workspacesDir, { recursive: true });

  // 保存每个工作区为单独文件
  for (const workspace of store.workspaces) {
    const filePath = path.join(workspacesDir, `${workspace.id}.json`);
    await writeJsonFile(filePath, workspace);
  }

  // 保存索引文件
  const index: WorkspaceIndex = {
    activeWorkspaceId: store.activeWorkspaceId,
    workspaces: store.workspaces.map((w) => ({
      id: w.id,
      type: w.type,
      name: w.name,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt
    }))
  };
  await writeJsonFile(path.join(workspacesDir, "index.json"), index);
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${workspaceWriteSequence++}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
  try {
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readApiSettings(): Promise<ApiSettings> {
  try {
    const raw = await readFile(settingsFilePath, "utf-8");
    return normalizeApiSettings(JSON.parse(raw));
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : "";
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeApiSettings(settings: ApiSettings): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeJsonFile(settingsFilePath, normalizeApiSettings(settings));
}

function normalizeApiSettings(value: unknown): ApiSettings {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as ApiSettings;
  const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
  const apiEndpoint = typeof candidate.apiEndpoint === "string" ? candidate.apiEndpoint.trim() : "";

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(apiEndpoint ? { apiEndpoint } : {})
  };
}

async function updateWorkspace(workspaceId: string, update: (workspace: StoredWorkspace) => StoredWorkspace): Promise<StoredWorkspace> {
  const operation = workspaceWriteQueue.then(async () => {
    const store = await readWorkspaceStoreNow();
    const index = store.workspaces.findIndex((item) => item.id === workspaceId);
    if (index === -1) {
      throw Object.assign(new Error("Workspace not found."), { status: 404 });
    }

    const updated = update(store.workspaces[index]);
    store.workspaces[index] = updated;
    store.activeWorkspaceId = updated.id;
    await writeWorkspaceStoreNow(store);
    return updated;
  });

  workspaceWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
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

function startAudiobookGenerationJob(workspaceId: string, apiKey: string, apiEndpoint: string): void {
  if (activeAudiobookGenerationJobs.has(workspaceId)) {
    return;
  }

  activeAudiobookGenerationJobs.add(workspaceId);
  void generateAudiobookProductsInBatches(workspaceId, apiKey, apiEndpoint)
    .catch((error) => {
      console.error("[audiobook:generate] background generation failed", error);
    })
    .finally(() => {
      activeAudiobookGenerationJobs.delete(workspaceId);
    });
}

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ response: globalThis.Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`生成超时（${Math.round(timeoutMs / 1000)}秒），已跳过`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generateAudiobookProductsInBatches(workspaceId: string, apiKey: string, apiEndpoint: string): Promise<void> {
  const batchSize = 20;

  while (true) {
    const batch = await updateAudiobookProducts(workspaceId, (workspace) => {
      const chapter = getActiveAudiobookChapter(workspace);
      const pending = chapter.products.filter((product) => product.status === "pending").slice(0, batchSize);
      const startedAt = new Date().toISOString();
      for (const product of pending) {
        product.status = "generating";
        product.error = undefined;
        product.createdAt = startedAt;
      }
      chapter.updatedAt = startedAt;
      syncAudiobookWorkspaceFromChapter(workspace, chapter);
      return pending.map((product) => ({ ...product }));
    });

    if (batch.length === 0) {
      return;
    }

    await Promise.all(
      batch.map(async (product) => {
        const startMs = Date.now();
        try {
          const audioDataUrl = await synthesizeAudiobookProduct(workspaceId, product, apiKey, apiEndpoint);
          await updateAudiobookProduct(workspaceId, product.id, (target) => {
            target.audioDataUrl = audioDataUrl;
            target.status = "ready";
            target.error = undefined;
            target.elapsedMs = Date.now() - startMs;
          });
        } catch (error) {
          await updateAudiobookProduct(workspaceId, product.id, (target) => {
            target.status = "error";
            target.error = error instanceof Error ? error.message : "生成失败";
            target.elapsedMs = Date.now() - startMs;
          });
        }
      })
    );
  }
}

async function synthesizeAudiobookProduct(
  workspaceId: string,
  product: AudiobookProduct,
  apiKey: string,
  apiEndpoint: string
): Promise<string> {
  const character = await getAudiobookCharacterSnapshot(workspaceId, product.characterId);
  if (!character?.voiceDataUrl) {
    throw new Error(`${product.characterName || "当前角色"}缺少可复用音色，请先在音色库生成或上传参考音频。`);
  }

  const payload: MimoPayload = {
    model: "mimo-v2.5-tts-voiceclone",
    messages: [
      { role: "user", content: product.instruction },
      { role: "assistant", content: product.text }
    ],
    audio: {
      format: "wav",
      voice: character.voiceDataUrl
    }
  };

  const { response: upstreamResponse, text: responseText } = await fetchTextWithTimeout(apiEndpoint, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, audiobookProductTimeoutMs);
  if (!upstreamResponse.ok) {
    throw new Error(`voiceclone失败：HTTP ${upstreamResponse.status}`);
  }

  const audioData = extractAudioData(parseJson(responseText));
  if (!audioData) {
    throw new Error("voiceclone响应中没有音频数据");
  }

  return `data:audio/wav;base64,${audioData}`;
}

async function getAudiobookCharacterSnapshot(workspaceId: string, characterId: string | null): Promise<AudiobookCharacter | null> {
  if (!characterId) {
    return null;
  }

  const store = await readWorkspaceStore();
  const workspace = store.workspaces.find((w) => w.id === workspaceId);
  if (!workspace || workspace.type !== "audiobook") {
    return null;
  }

  const character = workspace.characters.find((item) => item.id === characterId);
  return character ? { ...character } : null;
}

async function updateAudiobookProduct(
  workspaceId: string,
  productId: string,
  update: (product: AudiobookProduct, workspace: StoredAudiobookWorkspace) => void
): Promise<AudiobookProduct> {
  const product = await updateAudiobookProducts(workspaceId, (workspace) => {
    const chapter = getActiveAudiobookChapter(workspace);
    const target = chapter.products.find((item) => item.id === productId);
    if (!target) {
      throw Object.assign(new Error("Audiobook product not found."), { status: 404 });
    }
    update(target, workspace);
    chapter.updatedAt = new Date().toISOString();
    syncAudiobookWorkspaceFromChapter(workspace, chapter);
    return { ...target };
  });
  return product;
}

async function updateAudiobookProducts<T>(workspaceId: string, update: (workspace: StoredAudiobookWorkspace) => T): Promise<T> {
  const operation = workspaceWriteQueue.then(async () => {
    const store = await readWorkspaceStoreNow();
    const workspace = store.workspaces.find((w) => w.id === workspaceId);
    if (!workspace || workspace.type !== "audiobook") {
      throw Object.assign(new Error("Audiobook workspace not found."), { status: 404 });
    }

    const result = update(workspace);
    const chapter = getActiveAudiobookChapter(workspace);
    syncAudiobookWorkspaceFromChapter(workspace, chapter);
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspaceStoreNow(store);
    return result;
  });

  workspaceWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
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

function createAudiobookNarrator(now = new Date().toISOString()): AudiobookCharacter {
  void now;
  return {
    id: createId("narrator"),
    name: "旁白",
    roleType: "narrator",
    aliases: ["叙述者", "Narrator"],
    voiceSource: "manualDesign",
    voiceMode: "designed",
    isSystem: true,
    isVoiceLocked: false,
    gender: "",
    age: "",
    voiceTraits: "自然、清晰的中文旁白音色，适合长篇叙述。",
    personality: "负责小说叙述、场景描写和人物动作说明，表达稳定清晰。",
    voiceDescription: "自然、清晰的中文旁白音色，声音稳定耐听，适合长篇小说叙述。",
    voiceSampleText: undefined,
    voiceDataUrl: null,
    voiceStatus: "pending"
  };
}

function normalizeAudiobookCharacter(raw: Partial<AudiobookCharacter> & Record<string, unknown>): AudiobookCharacter {
  const name = String(raw.name || "").trim() || "未命名角色";
  const roleType = raw.roleType === "narrator" || raw.roleType === "protagonist" || raw.roleType === "supporting" || raw.roleType === "custom"
    ? raw.roleType
    : name === "旁白"
      ? "narrator"
      : "supporting";
  const voiceSource = raw.voiceSource === "manualDesign" || raw.voiceSource === "manualClone" || raw.voiceSource === "analysis"
    ? raw.voiceSource
    : roleType === "narrator"
      ? "manualDesign"
      : "analysis";
  const voiceMode = raw.voiceMode === "cloned" || raw.voiceMode === "designed"
    ? raw.voiceMode
    : raw.referenceAudioDataUrl
      ? "cloned"
      : "designed";
  const voiceStatus = raw.voiceStatus === "generating" || raw.voiceStatus === "ready" || raw.voiceStatus === "error"
    ? raw.voiceStatus
    : raw.voiceDataUrl
      ? "ready"
      : "pending";

  return {
    id: String(raw.id || createId(roleType === "narrator" ? "narrator" : "char")),
    name,
    roleType,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map((item) => String(item).trim()).filter(Boolean) : [],
    voiceSource,
    voiceMode,
    isSystem: Boolean(raw.isSystem || roleType === "narrator"),
    isVoiceLocked: Boolean(raw.isVoiceLocked),
    gender: String(raw.gender || ""),
    age: String(raw.age || ""),
    voiceTraits: String(raw.voiceTraits || ""),
    personality: String(raw.personality || ""),
    voiceDescription: String(raw.voiceDescription || (roleType === "narrator" ? "自然、清晰的中文旁白音色，声音稳定耐听，适合长篇小说叙述。" : "")),
    voiceSampleText: typeof raw.voiceSampleText === "string" ? raw.voiceSampleText : undefined,
    voiceDataUrl: typeof raw.voiceDataUrl === "string" ? raw.voiceDataUrl : null,
    voiceStatus,
    voiceError: typeof raw.voiceError === "string" ? raw.voiceError : undefined,
    referenceAudioDataUrl: typeof raw.referenceAudioDataUrl === "string" ? raw.referenceAudioDataUrl : undefined,
    referenceAudioFileName: typeof raw.referenceAudioFileName === "string" ? raw.referenceAudioFileName : undefined,
    referenceAudioMimeType: typeof raw.referenceAudioMimeType === "string" ? raw.referenceAudioMimeType : undefined
  };
}

function ensureNarratorCharacter(characters: AudiobookCharacter[]): AudiobookCharacter[] {
  const normalized = characters.map((item) => normalizeAudiobookCharacter(item));
  if (normalized.some((item) => item.roleType === "narrator" || item.name === "旁白")) {
    return normalized.map((item) => item.roleType === "narrator" || item.name === "旁白"
      ? { ...item, name: "旁白", roleType: "narrator", isSystem: true }
      : item);
  }
  return [createAudiobookNarrator(), ...normalized];
}

function normalizeAudiobookChapter(raw: Partial<AudiobookChapter> & Record<string, unknown>, fallbackTitle: string): AudiobookChapter {
  const now = new Date().toISOString();
  return {
    id: String(raw.id || createId("chapter")),
    title: String(raw.title || fallbackTitle || "未命名章节"),
    novelText: String(raw.novelText || ""),
    characterHints: String(raw.characterHints || ""),
    segments: Array.isArray(raw.segments) ? raw.segments as AudiobookSegment[] : [],
    products: Array.isArray(raw.products) ? raw.products as AudiobookProduct[] : [],
    phase: (raw.phase as AudiobookChapter["phase"]) || "character-creation",
    createdAt: String(raw.createdAt || now),
    updatedAt: String(raw.updatedAt || now)
  };
}

function getActiveAudiobookChapter(workspace: StoredAudiobookWorkspace): AudiobookChapter {
  let chapter = workspace.chapters.find((item) => item.id === workspace.activeChapterId);
  if (!chapter) {
    chapter = workspace.chapters[0];
    workspace.activeChapterId = chapter.id;
  }
  syncAudiobookWorkspaceFromChapter(workspace, chapter);
  return chapter;
}

function syncAudiobookWorkspaceFromChapter(workspace: StoredAudiobookWorkspace, chapter = getActiveAudiobookChapterUnsafe(workspace)): void {
  if (!chapter) {
    return;
  }
  workspace.activeChapterId = chapter.id;
  workspace.novelText = chapter.novelText;
  workspace.characterHints = chapter.characterHints;
  workspace.segments = chapter.segments;
  workspace.products = chapter.products;
  workspace.phase = chapter.phase;
}

function getActiveAudiobookChapterUnsafe(workspace: StoredAudiobookWorkspace): AudiobookChapter | undefined {
  return workspace.chapters.find((item) => item.id === workspace.activeChapterId) ?? workspace.chapters[0];
}

function findAudiobookCharacterByNameOrAlias(workspace: StoredAudiobookWorkspace, name: string): AudiobookCharacter | undefined {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return undefined;
  }
  return workspace.characters.find((character) =>
    character.name === normalizedName || character.aliases.some((alias) => alias === normalizedName)
  );
}

function normalizeStoredWorkspace(raw: Record<string, unknown>): StoredWorkspace {
  // 向后兼容：旧数据没有 type 字段，默认为 board
  const type = (raw.type as string) || "board";

  if (type === "audiobook") {
    const chapters = Array.isArray(raw.chapters) && raw.chapters.length > 0
      ? raw.chapters.map((item, index) => normalizeAudiobookChapter(item as Record<string, unknown>, `章节 ${index + 1}`))
      : [
          normalizeAudiobookChapter({
            id: "chapter-legacy",
            title: "章节 1",
            novelText: String(raw.novelText || ""),
            characterHints: String(raw.characterHints || ""),
            segments: Array.isArray(raw.segments) ? raw.segments as AudiobookSegment[] : [],
            products: Array.isArray(raw.products) ? raw.products as AudiobookProduct[] : [],
            phase: raw.phase === "annotation" || raw.phase === "generation" ? raw.phase : "character-creation",
            createdAt: String(raw.createdAt || ""),
            updatedAt: String(raw.updatedAt || "")
          }, "章节 1")
        ];
    const activeChapterId = String(raw.activeChapterId || chapters[0]?.id || "");
    const activeChapter = chapters.find((chapter) => chapter.id === activeChapterId) ?? chapters[0];
    const characters = ensureNarratorCharacter(Array.isArray(raw.characters) ? raw.characters as AudiobookCharacter[] : []);
    return {
      id: String(raw.id || ""),
      type: "audiobook",
      name: String(raw.name || ""),
      createdAt: String(raw.createdAt || ""),
      updatedAt: String(raw.updatedAt || ""),
      activeChapterId: activeChapter.id,
      novelText: activeChapter.novelText,
      characterHints: activeChapter.characterHints,
      characters,
      segments: activeChapter.segments,
      products: activeChapter.products,
      phase: activeChapter.phase,
      chapters
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
