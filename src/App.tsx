import "@xyflow/react/dist/style.css";
import {
  addEdge,
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import {
  AlertTriangle,
  Archive,
  AudioLines,
  BookOpen,
  BookPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileAudio,
  Key,
  Loader2,
  Mic2,
  Pause,
  PanelTop,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X
} from "lucide-react";
import { ChangeEvent, MouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBezierPath } from "@xyflow/react";
import JSZip from "jszip";

type StatusResponse = {
  ok: boolean;
  model: string;
  apiKeyConfigured: boolean;
  maxAudioBytes: number;
  allowedMimeTypes: string[];
};

type ApiSettingsResponse = {
  apiKey: string;
  apiEndpoint: string;
  configured: boolean;
};

type WorkspaceSummary = {
  id: string;
  name: string;
  type: "board" | "audiobook";
  createdAt: string;
  updatedAt: string;
  nodeCount?: number;
  edgeCount?: number;
  stashCount?: number;
  characterCount?: number;
  segmentCount?: number;
  phase?: string;
};

type BoardWorkspacePayload = {
  id: string;
  type: "board";
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
  stashItems: StashItem[];
};

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

type AudiobookWorkspacePayload = {
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

type WorkspacePayload = BoardWorkspacePayload | AudiobookWorkspacePayload;

type WorkspacesResponse = {
  activeWorkspaceId: string | null;
  workspaces: WorkspaceSummary[];
};

type StudioNodeType = "referenceAudio" | "voiceStyle" | "prompt" | "voiceClone" | "voiceDesign" | "artifact" | "comment";
type StudioNode = Node<NodeData, StudioNodeType>;
type StudioEdge = Edge<{ onDeleteEdge?: (edgeId: string) => void }>;

type AudioAsset = {
  fileName: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

type ArtifactData = {
  fileName: string;
  audioDataUrl: string;
  elapsedMs: number;
  createdAt: string;
  sourceNodeName: string;
};

type StashItem = ArtifactData & {
  id: string;
};

type NodeData = {
  title: string;
  text?: string;
  instruction?: string;
  audio?: AudioAsset;
  artifact?: ArtifactData;
  isRunning?: boolean;
  error?: string;
  onPatch?: (nodeId: string, patch: Partial<NodeData>) => void;
  onDelete?: (nodeId: string) => void;
  onRunClone?: (nodeId: string) => void;
  onRunVoiceDesign?: (nodeId: string) => void;
  onOptimizeStyle?: (nodeId: string) => void;
  onOptimizeVoiceDesign?: (nodeId: string) => void;
  onStashArtifact?: (artifact: ArtifactData) => void;
  isArtifactStashed?: (artifact: ArtifactData) => boolean;
};

type DebugResponse = {
  audioDataUrl: string;
  fileName: string;
  elapsedMs: number;
};

type StyleOptimizeResponse = {
  optimizedText: string;
  elapsedMs: number;
  error?: string;
};

const nodeCatalog: Record<
  StudioNodeType,
  {
    label: string;
    description: string;
    defaultData: () => NodeData;
  }
> = {
  referenceAudio: {
    label: "参考音频",
    description: "上传声音样本，输出给克隆节点",
    defaultData: () => ({ title: "参考音频", text: "声音样本" })
  },
  voiceStyle: {
    label: "语音风格",
    description: "导演文本，控制声音情绪和表达",
    defaultData: () => ({ title: "语音风格", text: "自然、清晰、略带播客讲述感，语速中等，语气友好但不过分夸张。" })
  },
  prompt: {
    label: "提示词",
    description: "要生成成音频的文本内容",
    defaultData: () => ({ title: "提示词", text: "今天我们完成了铸光音频工作站的第一条生成链路，现在用这段声音检查相似度、节奏和情绪表现。" })
  },
  voiceClone: {
    label: "音频克隆",
    description: "读取输入并生成克隆音频",
    defaultData: () => ({
      title: "音频克隆",
      instruction: "自然、清晰、略带播客讲述感，语速中等，语气友好但不过分夸张。",
      text: "今天我们完成了铸光音频工作站的第一条生成链路，现在用这段声音检查相似度、节奏和情绪表现。"
    })
  },
  voiceDesign: {
    label: "音色创造",
    description: "用文字设计音色并直接合成音频",
    defaultData: () => ({
      title: "音色创造",
      instruction: "年轻女性声音，温暖、清澈，带一点自然的纪录片旁白质感，情绪克制但有亲近感。",
      text: "这是一段使用文字设计音色直接生成的语音，用来验证音色、情绪和表达质感。"
    })
  },
  artifact: {
    label: "产物",
    description: "保存生成结果和下载入口",
    defaultData: () => ({ title: "音频产物" })
  },
  comment: {
    label: "文本注释",
    description: "画布上的备注说明",
    defaultData: () => ({ title: "注释", text: "" })
  }
};

const autoSaveDelayMs = 30000;
const DEFAULT_API_KEY = "sk-cbpjuoes34akq38omkqz9s08s7h9dxwe7cjshz5824kskliz";
const DEFAULT_API_ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions";
const API_KEY_STORAGE_KEY = "mimo-api-key";
const API_ENDPOINT_STORAGE_KEY = "mimo-api-endpoint";

const allowedAudioTypes = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/wav", "audio/x-wav", "audio/wave", "video/mp4"]);
const maxAudioBytes = Math.floor(7.5 * 1024 * 1024);

export default function App() {
  return (
    <ReactFlowProvider>
      <StudioApp />
    </ReactFlowProvider>
  );
}

function StudioApp() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspacePayload | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StudioEdge>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isStashOpen, setIsStashOpen] = useState(false);
  const [boardDialog, setBoardDialog] = useState<"choice" | "smart" | "audiobook" | null>(null);
  const flowRef = useRef<ReactFlowInstance<StudioNode, StudioEdge> | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(API_KEY_STORAGE_KEY) || DEFAULT_API_KEY);
  const [apiEndpoint, setApiEndpoint] = useState<string>(() => localStorage.getItem(API_ENDPOINT_STORAGE_KEY) || DEFAULT_API_ENDPOINT);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState(apiKey);
  const [apiEndpointInput, setApiEndpointInput] = useState(apiEndpoint);
  const [topbarCollapsed, setTopbarCollapsed] = useState(false);
  const [showDefaultKeyWarning, setShowDefaultKeyWarning] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const topbarHoverTimerRef = useRef<number | null>(null);

  const autoSaveKey = useMemo(() => {
    if (!activeWorkspace) return "";
    if (activeWorkspace.type === "audiobook") {
      return JSON.stringify({
        id: activeWorkspace.id,
        name: activeWorkspace.name,
        novelText: activeWorkspace.novelText,
        characterHints: activeWorkspace.characterHints,
        characters: activeWorkspace.characters,
        segments: activeWorkspace.segments,
        products: activeWorkspace.products,
        phase: activeWorkspace.phase
      });
    }
    return JSON.stringify({
      id: activeWorkspace.id,
      name: activeWorkspace.name,
      nodes,
      edges,
      stashItems: activeWorkspace.stashItems ?? []
    });
  }, [activeWorkspace, nodes, edges]);

  useEffect(() => {
    void loadStatus();
    void loadApiSettings();
    void loadWorkspaceList();

    const collapseTimer = window.setTimeout(() => {
      setTopbarCollapsed(true);
    }, 5000);

    return () => window.clearTimeout(collapseTimer);
  }, []);

  useEffect(() => {
    function handleMouseMove(e: globalThis.MouseEvent) {
      if (e.clientY < 20) {
        setTopbarCollapsed(false);
        if (topbarHoverTimerRef.current) {
          window.clearTimeout(topbarHoverTimerRef.current);
        }
      }
    }

    document.addEventListener("mousemove", handleMouseMove);
    return () => document.removeEventListener("mousemove", handleMouseMove);
  }, []);

  useEffect(() => {
    if (!activeWorkspace) {
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      void saveWorkspace();
    }, autoSaveDelayMs);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
    // Track board and audiobook state changes without depending on the save function identity.
  }, [autoSaveKey]);

  const nodeCallbacks = useMemo(
    () => ({
      onPatch: patchNode,
      onDelete: deleteNode,
      onRunClone: runVoiceClone,
      onRunVoiceDesign: runVoiceDesign,
      onOptimizeStyle: optimizeVoiceStyle,
      onOptimizeVoiceDesign: optimizeVoiceDesign,
      onStashArtifact: stashArtifact,
      isArtifactStashed
    }),
    [nodes, edges, apiKey, activeWorkspace?.type === "board" ? activeWorkspace.stashItems : undefined]
  );

  const hydratedNodes = useMemo(() => {
    return nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        ...nodeCallbacks
      }
    }));
  }, [nodes, nodeCallbacks]);

  const hydratedEdges = useMemo(() => {
    return edges.map((edge) => ({
      ...edge,
      type: "deletable",
      data: {
        ...edge.data,
        onDeleteEdge: deleteEdge
      }
    }));
  }, [edges]);

  const nodeTypes = useMemo<NodeTypes>(
    () => ({
      referenceAudio: ReferenceAudioNode,
      voiceStyle: VoiceStyleNode,
      prompt: PromptNode,
      voiceClone: VoiceCloneNode,
      voiceDesign: VoiceDesignNode,
      artifact: ArtifactNode,
      comment: CommentNode
    }),
    []
  );

  const edgeTypes = useMemo(
    () => ({
      deletable: DeletableEdge
    }),
    []
  );

  async function loadStatus() {
    try {
      setStatusError(null);
      const response = await fetch("/api/status");
      if (!response.ok) {
        throw new Error(`状态检查失败：HTTP ${response.status}`);
      }
      setStatus((await response.json()) as StatusResponse);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "状态检查失败");
    }
  }

  async function loadApiSettings() {
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) {
        throw new Error(`API 配置加载失败：HTTP ${response.status}`);
      }

      const settings = (await response.json()) as ApiSettingsResponse;
      const localKey = localStorage.getItem(API_KEY_STORAGE_KEY) || "";
      const localEndpoint = localStorage.getItem(API_ENDPOINT_STORAGE_KEY) || "";
      const nextKey = settings.apiKey || localKey || DEFAULT_API_KEY;
      const nextEndpoint = settings.apiEndpoint || localEndpoint || DEFAULT_API_ENDPOINT;

      setApiKey(nextKey);
      setApiEndpoint(nextEndpoint);
      setApiKeyInput(nextKey);
      setApiEndpointInput(nextEndpoint);

      if (!settings.configured && localKey) {
        void persistApiSettings(localKey, localEndpoint || nextEndpoint);
        return;
      }

      if (!settings.configured && !localKey) {
        setShowApiKeyModal(true);
      }
    } catch (error) {
      console.warn("[settings] failed to load API settings", error);
      if (!localStorage.getItem(API_KEY_STORAGE_KEY)) {
        setShowApiKeyModal(true);
      }
    }
  }

  function saveApiKey() {
    const trimmedKey = apiKeyInput.trim();
    const trimmedEndpoint = apiEndpointInput.trim();
    if (!trimmedKey) return;
    setApiKey(trimmedKey);
    localStorage.setItem(API_KEY_STORAGE_KEY, trimmedKey);
    if (trimmedEndpoint) {
      setApiEndpoint(trimmedEndpoint);
      localStorage.setItem(API_ENDPOINT_STORAGE_KEY, trimmedEndpoint);
    } else {
      setApiEndpoint(DEFAULT_API_ENDPOINT);
      localStorage.removeItem(API_ENDPOINT_STORAGE_KEY);
    }
    void persistApiSettings(trimmedKey, trimmedEndpoint || DEFAULT_API_ENDPOINT);
    closeApiKeyModal();
    void loadStatus();
  }

  async function persistApiSettings(apiKey: string, apiEndpoint: string) {
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, apiEndpoint })
      });
    } catch (error) {
      console.warn("[settings] failed to persist API settings", error);
    }
  }

  function openApiKeyModal() {
    setApiKeyInput(apiKey);
    setApiEndpointInput(apiEndpoint);
    setShowApiKeyModal(true);
  }

  function closeApiKeyModal() {
    setShowApiKeyModal(false);
    topbarHoverTimerRef.current = window.setTimeout(() => setTopbarCollapsed(true), 3000);
  }

  async function loadWorkspaceList(preferredId?: string) {
    const response = await fetch("/api/workspaces");
    if (!response.ok) {
      throw new Error(`加载画板列表失败：HTTP ${response.status}`);
    }
    const payload = (await response.json()) as WorkspacesResponse;
    const workspaceItems = Array.isArray(payload.workspaces) ? payload.workspaces : [];
    setWorkspaces(workspaceItems);
    const targetId = preferredId ?? payload.activeWorkspaceId ?? workspaceItems[0]?.id;
    if (targetId) {
      await loadWorkspace(targetId);
    }
  }

  async function loadWorkspace(id: string) {
    const response = await fetch(`/api/workspaces/${id}`);
    if (!response.ok) {
      throw new Error(`加载画板失败：HTTP ${response.status}`);
    }
    const workspace = (await response.json()) as WorkspacePayload;
    setActiveWorkspace(workspace);
    if (workspace.type === "board") {
      setNodes(workspace.nodes ?? []);
      setEdges(workspace.edges ?? []);
    } else {
      setNodes([]);
      setEdges([]);
    }
  }

  async function createWorkspace() {
    const name = `新工作台 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, nodes: [], edges: [], stashItems: [] })
    });
    const workspace = (await response.json()) as WorkspacePayload;
    await loadWorkspaceList(workspace.id);
  }

  async function createSmartWorkspace(formData: FormData) {
    const response = await fetch("/api/workspaces/smart", {
      method: "POST",
      headers: { "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint },
      body: formData
    });
    const workspace = (await response.json()) as WorkspacePayload & { error?: string };
    if (!response.ok) {
      throw new Error(workspace.error || `智能画板生成失败：HTTP ${response.status}`);
    }
    await loadWorkspaceList(workspace.id);
  }

  async function createAudiobookWorkspace(data: { novelText: string; characterHints: string; name?: string }) {
    const response = await fetch("/api/audiobook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint },
      body: JSON.stringify(data)
    });
    const workspace = (await response.json()) as AudiobookWorkspacePayload & { error?: string };
    if (!response.ok) {
      throw new Error(workspace.error || "创建有声书失败");
    }
    await loadWorkspaceList(workspace.id);
  }

  function patchAudiobook(patch: Partial<AudiobookWorkspacePayload>) {
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook") return workspace;
      return { ...workspace, ...patch } as AudiobookWorkspacePayload;
    });
  }

  async function addAudiobookChapter(data: { title: string; novelText: string; characterHints: string }) {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") throw new Error("工作区状态异常");
    const workspaceId = activeWorkspace.id;
    const response = await fetch(`/api/audiobook/${workspaceId}/chapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint },
      body: JSON.stringify(data)
    });
    const result = (await response.json()) as { workspace?: AudiobookWorkspacePayload; error?: string };
    if (!response.ok || !result.workspace) {
      throw new Error(result.error || "新增章节失败");
    }
    setActiveWorkspace(result.workspace);
  }

  async function activateAudiobookChapter(chapterId: string) {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") return;
    const workspaceId = activeWorkspace.id;
    const response = await fetch(`/api/audiobook/${workspaceId}/chapters/${chapterId}/activate`, {
      method: "POST"
    });
    const result = (await response.json()) as { workspace?: AudiobookWorkspacePayload; error?: string };
    if (!response.ok || !result.workspace) {
      throw new Error(result.error || "切换章节失败");
    }
    setActiveWorkspace(result.workspace);
  }

  async function createAudiobookCharacter(formData: FormData) {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") throw new Error("工作区状态异常");
    const workspaceId = activeWorkspace.id;
    const response = await fetch(`/api/audiobook/${workspaceId}/characters`, {
      method: "POST",
      body: formData
    });
    const result = (await response.json()) as { characters?: AudiobookCharacter[]; chapter?: AudiobookChapter; error?: string };
    if (!response.ok) {
      throw new Error(result.error || "创建音色角色失败");
    }
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
      return { ...workspace, characters: result.characters ?? workspace.characters };
    });
  }

  async function analyzeAudiobookCharacters() {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") throw new Error("工作区状态异常");
    const workspaceId = activeWorkspace.id;
    const response = await fetch(`/api/audiobook/${workspaceId}/characters/analyze`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint }
    });
    const result = (await response.json()) as { characters?: AudiobookCharacter[]; chapter?: AudiobookChapter; error?: string };
    if (!response.ok) {
      throw new Error(result.error || "角色分析失败");
    }
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
      if (!result.chapter) {
        return { ...workspace, characters: result.characters ?? [] };
      }
      return {
        ...workspace,
        characters: result.characters ?? workspace.characters,
        chapters: workspace.chapters.map((chapter) => (chapter.id === result.chapter!.id ? result.chapter! : chapter)),
        activeChapterId: result.chapter.id,
        novelText: result.chapter.novelText,
        characterHints: result.chapter.characterHints,
        segments: result.chapter.segments,
        products: result.chapter.products,
        phase: result.chapter.phase
      };
    });
  }

  async function generateCharacterVoice(charId: string) {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") return;
    const workspaceId = activeWorkspace.id;
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
      return {
        ...workspace,
        characters: workspace.characters.map((c) =>
          c.id === charId ? { ...c, voiceStatus: "generating" as AudiobookCharacter["voiceStatus"], voiceError: undefined } : c
        )
      };
    });
    const response = await fetch(`/api/audiobook/${workspaceId}/characters/${charId}/voice`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint }
    });
    const result = (await response.json()) as { character?: AudiobookCharacter; error?: string };
    if (!response.ok) {
      setActiveWorkspace((workspace) => {
        if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
        return {
          ...workspace,
          characters: workspace.characters.map((c) =>
            c.id === charId ? { ...c, voiceStatus: "error" as AudiobookCharacter["voiceStatus"], voiceError: result.error || "生成失败" } : c
          )
        };
      });
      return;
    }
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
      return {
        ...workspace,
        characters: workspace.characters.map((c) => (c.id === charId ? result.character! : c))
      };
    });
  }

  async function deleteCharacterVoice(charId: string) {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") return;
    const workspaceId = activeWorkspace.id;
    const response = await fetch(`/api/audiobook/${workspaceId}/characters/${charId}/voice`, {
      method: "DELETE"
    });
    const result = (await response.json()) as { character?: AudiobookCharacter; error?: string };
    if (!response.ok) {
      throw new Error(result.error || "删除音色失败");
    }
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
      return {
        ...workspace,
        characters: workspace.characters.map((c) => (c.id === charId ? result.character! : c))
      };
    });
  }

  async function autoAnnotateAudiobook() {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") throw new Error("工作区状态异常");
    const workspaceId = activeWorkspace.id;
    const response = await fetch(`/api/audiobook/${workspaceId}/annotate`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint }
    });
    const result = (await response.json()) as { segments?: AudiobookSegment[]; chapter?: AudiobookChapter; error?: string };
    if (!response.ok) {
      throw new Error(result.error || "自动标注失败");
    }
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
      if (result.chapter) {
        return {
          ...workspace,
          chapters: workspace.chapters.map((chapter) => (chapter.id === result.chapter!.id ? result.chapter! : chapter)),
          activeChapterId: result.chapter.id,
          segments: result.chapter.segments,
          products: result.chapter.products,
          phase: result.chapter.phase
        };
      }
      return { ...workspace, segments: result.segments ?? [], phase: "annotation" };
    });
  }

  async function updateAudiobookSegment(segId: string, patch: { characterId: string | null; characterName: string; emotion: string }) {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") return;
    const response = await fetch(`/api/audiobook/${activeWorkspace.id}/segments/${segId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    const result = (await response.json()) as { segment?: AudiobookSegment; error?: string };
    if (!response.ok) {
      throw new Error(result.error || "标注失败");
    }
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== activeWorkspace.id) return workspace;
      return {
        ...workspace,
        segments: workspace.segments.map((s) => (s.id === segId ? result.segment! : s)),
        chapters: workspace.chapters.map((chapter) =>
          chapter.id === workspace.activeChapterId
            ? { ...chapter, segments: chapter.segments.map((s) => (s.id === segId ? result.segment! : s)) }
            : chapter
        )
      };
    });
  }

  async function generateAudiobookAudio() {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") throw new Error("工作区状态异常");
    const workspaceId = activeWorkspace.id;
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
      return {
        ...workspace,
        phase: "generation",
        chapters: workspace.chapters.map((chapter) =>
          chapter.id === workspace.activeChapterId ? { ...chapter, phase: "generation" } : chapter
        )
      };
    });
    const response = await fetch(`/api/audiobook/${workspaceId}/generate`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint }
    });
    const result = (await response.json()) as { products?: AudiobookProduct[]; error?: string };
    if (!response.ok) {
      throw new Error(result.error || "生成失败");
    }
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
      return {
        ...workspace,
        products: result.products ?? [],
        chapters: workspace.chapters.map((chapter) =>
          chapter.id === workspace.activeChapterId ? { ...chapter, products: result.products ?? [] } : chapter
        )
      };
    });
    await pollAudiobookGeneration(workspaceId);
  }

  async function retryAudiobookProduct(productId: string) {
    if (!activeWorkspace || activeWorkspace.type !== "audiobook") return;
    const workspaceId = activeWorkspace.id;
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
      return {
        ...workspace,
        products: workspace.products.map((product) =>
          product.id === productId
            ? { ...product, status: "generating" as AudiobookProduct["status"], audioDataUrl: null, error: undefined, elapsedMs: undefined }
            : product
        ),
        chapters: workspace.chapters.map((chapter) =>
          chapter.id === workspace.activeChapterId
            ? {
                ...chapter,
                products: chapter.products.map((product) =>
                  product.id === productId
                    ? { ...product, status: "generating" as AudiobookProduct["status"], audioDataUrl: null, error: undefined, elapsedMs: undefined }
                    : product
                )
              }
            : chapter
        )
      };
    });

    const response = await fetch(`/api/audiobook/${workspaceId}/products/${productId}/retry`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint }
    });
    const result = (await response.json()) as { product?: AudiobookProduct; error?: string };
    if (result.product) {
      setActiveWorkspace((workspace) => {
        if (!workspace || workspace.type !== "audiobook" || workspace.id !== workspaceId) return workspace;
        return {
          ...workspace,
          products: workspace.products.map((product) => (product.id === productId ? result.product! : product)),
          chapters: workspace.chapters.map((chapter) =>
            chapter.id === workspace.activeChapterId
              ? { ...chapter, products: chapter.products.map((product) => (product.id === productId ? result.product! : product)) }
              : chapter
          )
        };
      });
    }
    if (!response.ok && !result.product) {
      throw new Error(result.error || "重试生成失败");
    }
  }

  async function pollAudiobookGeneration(workspaceId: string) {
    for (let attempt = 0; attempt < 240; attempt++) {
      await wait(1500);
      const response = await fetch(`/api/workspaces/${workspaceId}`);
      if (!response.ok) {
        throw new Error(`刷新有声书生成进度失败：HTTP ${response.status}`);
      }

      const workspace = (await response.json()) as WorkspacePayload;
      if (workspace.type !== "audiobook") {
        throw new Error("工作区类型异常");
      }

      setActiveWorkspace((current) => {
        if (!current || current.type !== "audiobook" || current.id !== workspaceId) return current;
        return workspace;
      });

      if (!workspace.products.some((product) => product.status === "pending" || product.status === "generating")) {
        return;
      }
    }

    throw new Error("有声书生成仍在进行中，请稍后刷新查看结果。");
  }

  function wait(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function deleteWorkspace() {
    if (!activeWorkspace || !window.confirm(`删除「${activeWorkspace.name}」？`)) {
      return;
    }

    await fetch(`/api/workspaces/${activeWorkspace.id}`, { method: "DELETE" });
    setActiveWorkspace(null);
    setNodes([]);
    setEdges([]);
    await loadWorkspaceList();
  }

  async function saveWorkspace() {
    if (!activeWorkspace) {
      return;
    }

    setIsSaving(true);
    try {
      let body: Record<string, unknown>;
      if (activeWorkspace.type === "audiobook") {
        body = {
          name: activeWorkspace.name,
          activeChapterId: activeWorkspace.activeChapterId,
          novelText: activeWorkspace.novelText,
          characterHints: activeWorkspace.characterHints,
          characters: activeWorkspace.characters,
          segments: activeWorkspace.segments,
          products: activeWorkspace.products,
          chapters: activeWorkspace.chapters,
          phase: activeWorkspace.phase,
          baseUpdatedAt: activeWorkspace.updatedAt
        };
      } else {
        const cleanNodes = nodes.map(stripNodeCallbacks);
        body = {
          name: activeWorkspace.name,
          nodes: cleanNodes,
          edges,
          stashItems: activeWorkspace.stashItems ?? []
        };
      }

      const response = await fetch(`/api/workspaces/${activeWorkspace.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const saved = (await response.json()) as WorkspacePayload & { error?: string };
      if (!response.ok) {
        throw new Error(saved.error || `保存失败：HTTP ${response.status}`);
      }
      setActiveWorkspace((current) => {
        if (!current || current.id !== saved.id) return current;
        if (current.type === "audiobook" && saved.type === "audiobook") {
          return saved;
        }
        return saved;
      });
      setWorkspaces((items) =>
        items.map((item) =>
          item.id === saved.id
            ? {
                ...item,
                name: saved.name,
                updatedAt: saved.updatedAt
              }
            : item
        )
      );
    } finally {
      setIsSaving(false);
    }
  }

  function patchWorkspaceName(name: string) {
    setActiveWorkspace((workspace) => (workspace ? { ...workspace, name } : workspace));
  }

  function stashArtifact(artifact: ArtifactData) {
    if (!activeWorkspace || isArtifactStashed(artifact)) {
      return;
    }

    const item: StashItem = {
      id: createId("stash"),
      ...artifact
    };
    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "board") return workspace;
      return { ...workspace, stashItems: [item, ...workspace.stashItems] };
    });
    setWorkspaces((items) => items.map((w) => (w.id === activeWorkspace.id ? { ...w, stashCount: (w.stashCount ?? 0) + 1 } : w)));
  }

  function isArtifactStashed(artifact: ArtifactData) {
    if (!activeWorkspace || activeWorkspace.type !== "board") return false;
    return activeWorkspace.stashItems.some((item) => item.fileName === artifact.fileName && item.audioDataUrl === artifact.audioDataUrl);
  }

  function deleteStashItem(itemId: string) {
    if (!activeWorkspace || activeWorkspace.type !== "board") {
      return;
    }

    setActiveWorkspace((workspace) => {
      if (!workspace || workspace.type !== "board") return workspace;
      return { ...workspace, stashItems: workspace.stashItems.filter((item) => item.id !== itemId) };
    });
    setWorkspaces((items) =>
      items.map((workspace) =>
        workspace.id === activeWorkspace.id ? { ...workspace, stashCount: Math.max(0, (workspace.stashCount ?? 0) - 1) } : workspace
      )
    );
  }

  function patchNode(nodeId: string, patch: Partial<NodeData>) {
    setNodes((items) => items.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node)));
  }

  function deleteNode(nodeId: string) {
    setNodes((items) => items.filter((node) => node.id !== nodeId));
    setEdges((items) => items.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
  }

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((items) =>
        addEdge(
          {
            ...connection,
            type: "deletable",
            animated: true,
            style: { stroke: "#c5a45d", strokeWidth: 2 }
          },
          items
        )
      );
    },
    [setEdges]
  );

  function openContextMenu(event: MouseEvent) {
    event.preventDefault();
    const point = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 80, y: 80 };
    setMenu({ x: event.clientX, y: event.clientY, flowX: point.x, flowY: point.y });
  }

  function addNode(type: StudioNodeType) {
    if (!menu) {
      return;
    }

    const node: StudioNode = {
      id: createId(type),
      type,
      position: { x: menu.flowX, y: menu.flowY },
      data: nodeCatalog[type].defaultData()
    };
    setNodes((items) => [...items, node]);
    setMenu(null);
  }

  function deleteEdge(edgeId: string) {
    setEdges((items) => items.filter((edge) => edge.id !== edgeId));
  }

  async function runVoiceClone(nodeId: string) {
    const cloneNode = nodes.find((node) => node.id === nodeId);
    if (!cloneNode || cloneNode.type !== "voiceClone") {
      return;
    }

    if (!apiKey) {
      patchNode(nodeId, { error: "API Key 未配置，请点击顶部 API Key 区域配置。" });
      return;
    }

    const resolved = resolveCloneInputs(cloneNode, nodes, edges);
    if (!resolved.audio) {
      patchNode(nodeId, { error: "缺少参考音频，请连接参考音频节点或在节点中上传。" });
      return;
    }

    const textItems = resolveCloneTextInputs(cloneNode, nodes, edges);
    const cloneTexts = textItems.length > 0 ? textItems : [{ title: cloneNode.data.title, text: resolved.text }];

    if (cloneTexts.every((item) => !item.text.trim())) {
      patchNode(nodeId, { error: "缺少音频文本，请连接提示词节点到「文本」输入或在节点中填写。" });
      return;
    }

    patchNode(nodeId, { isRunning: true, error: undefined });

    try {
      for (const [index, item] of cloneTexts.filter((entry) => entry.text.trim()).entries()) {
        const formData = new FormData();
        formData.append("voice", dataUrlToFile(resolved.audio.dataUrl, resolved.audio.fileName, resolved.audio.mimeType));
        formData.append("text", item.text.trim());
        formData.append("instruction", resolved.instruction.trim());
        formData.append("format", "wav");

        const response = await fetch("/api/tts/voiceclone", {
          method: "POST",
          headers: { "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint },
          body: formData
        });
        const payload = (await response.json()) as DebugResponse & { error?: string; details?: unknown };

        if (!response.ok) {
          patchNode(nodeId, { isRunning: false, error: payload.error || `第 ${index + 1} 条音频克隆失败。` });
          return;
        }

        const artifactNode = createArtifactNode(cloneNode, payload, item.title);
        const artifactEdge: StudioEdge = {
          id: createId("edge"),
          source: cloneNode.id,
          sourceHandle: "output",
          target: artifactNode.id,
          targetHandle: "artifact",
          type: "deletable",
          animated: true,
          style: { stroke: "#c5a45d", strokeWidth: 2 }
        };

        setNodes((items) => items.concat(artifactNode));
        setEdges((items) => items.concat(artifactEdge));
      }

      patchNode(nodeId, { isRunning: false, error: undefined });
    } catch (error) {
      patchNode(nodeId, { isRunning: false, error: error instanceof Error ? error.message : "请求失败。" });
    }
  }

  async function runVoiceDesign(nodeId: string) {
    const designNode = nodes.find((node) => node.id === nodeId);
    if (!designNode || designNode.type !== "voiceDesign") {
      return;
    }

    if (!apiKey) {
      patchNode(nodeId, { error: "API Key 未配置，请点击顶部 API Key 区域配置。" });
      return;
    }

    const voiceDescription = String(designNode.data.instruction || "").trim();
    const promptInputs = resolveVoiceDesignInputs(designNode, nodes, edges);
    const textItems = promptInputs.length > 0 ? promptInputs : [{ title: designNode.data.title, text: String(designNode.data.text || "").trim() }];

    if (!voiceDescription) {
      patchNode(nodeId, { error: "请先填写音色描述。" });
      return;
    }

    if (textItems.every((item) => !item.text.trim())) {
      patchNode(nodeId, { error: "请连接提示词节点，或在节点内填写音频文本。" });
      return;
    }

    patchNode(nodeId, { isRunning: true, error: undefined });

    try {
      for (const [index, item] of textItems.filter((entry) => entry.text.trim()).entries()) {
        const response = await fetch("/api/tts/voicedesign", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint },
          body: JSON.stringify({
            voiceDescription,
            text: item.text.trim(),
            format: "wav"
          })
        });
        const payload = (await response.json()) as DebugResponse & { error?: string; details?: unknown };

        if (!response.ok) {
          patchNode(nodeId, { isRunning: false, error: payload.error || `第 ${index + 1} 条音色创造失败。` });
          return;
        }

        const artifactNode = createArtifactNode(designNode, payload, item.title);
        const artifactEdge: StudioEdge = {
          id: createId("edge"),
          source: designNode.id,
          sourceHandle: "output",
          target: artifactNode.id,
          targetHandle: "artifact",
          type: "deletable",
          animated: true,
          style: { stroke: "#c5a45d", strokeWidth: 2 }
        };

        setNodes((items) => items.concat(artifactNode));
        setEdges((items) => items.concat(artifactEdge));
      }

      patchNode(nodeId, { isRunning: false, error: undefined });
    } catch (error) {
      patchNode(nodeId, { isRunning: false, error: error instanceof Error ? error.message : "请求失败。" });
    }
  }

  async function optimizeVoiceStyle(nodeId: string) {
    const styleNode = nodes.find((node) => node.id === nodeId);
    if (!styleNode || styleNode.type !== "voiceStyle") {
      return;
    }

    if (!apiKey) {
      patchNode(nodeId, { error: "API Key 未配置，请点击顶部 API Key 区域配置。" });
      return;
    }

    const style = String(styleNode.data.text || "").trim();
    if (!style) {
      patchNode(nodeId, { error: "请先填写需要优化的语音风格。" });
      return;
    }

    patchNode(nodeId, { isRunning: true, error: undefined });

    try {
      const response = await fetch("/api/voice-style/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint },
        body: JSON.stringify({ style })
      });
      const payload = (await response.json()) as StyleOptimizeResponse;

      if (!response.ok) {
        patchNode(nodeId, { isRunning: false, error: payload.error || "AI 优化失败。" });
        return;
      }

      patchNode(nodeId, {
        text: payload.optimizedText,
        isRunning: false,
        error: undefined
      });
    } catch (error) {
      patchNode(nodeId, {
        isRunning: false,
        error: error instanceof Error ? error.message : "AI 优化请求失败。"
      });
    }
  }

  async function optimizeVoiceDesign(nodeId: string) {
    const designNode = nodes.find((node) => node.id === nodeId);
    if (!designNode || designNode.type !== "voiceDesign") {
      return;
    }

    if (!apiKey) {
      patchNode(nodeId, { error: "API Key 未配置，请点击顶部 API Key 区域配置。" });
      return;
    }

    const voiceDescription = String(designNode.data.instruction || "").trim();
    if (!voiceDescription) {
      patchNode(nodeId, { error: "请先填写需要润色的音色描述。" });
      return;
    }

    patchNode(nodeId, { isRunning: true, error: undefined });

    try {
      const response = await fetch("/api/voice-design/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey, "X-API-Endpoint": apiEndpoint },
        body: JSON.stringify({ voiceDescription })
      });
      const payload = (await response.json()) as StyleOptimizeResponse;

      if (!response.ok) {
        patchNode(nodeId, { isRunning: false, error: payload.error || "AI 润色音色描述失败。" });
        return;
      }

      patchNode(nodeId, {
        instruction: payload.optimizedText,
        isRunning: false,
        error: undefined
      });
    } catch (error) {
      patchNode(nodeId, {
        isRunning: false,
        error: error instanceof Error ? error.message : "AI 润色音色描述请求失败。"
      });
    }
  }

  async function downloadStashZip() {
    if (!activeWorkspace || activeWorkspace.type !== "board" || activeWorkspace.stashItems.length === 0) {
      return;
    }
    const items = activeWorkspace.stashItems;

    const zip = new JSZip();
    const usedNames = new Map<string, number>();
    for (const item of items) {
      const safeName = getUniqueFileName(getArtifactDownloadFileName(item.sourceNodeName || item.fileName, item.fileName), usedNames);
      zip.file(safeName, dataUrlToUint8Array(item.audioDataUrl));
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeFileName(activeWorkspace.name)}-${formatDateForFile(new Date())}.zip`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="studio-shell" onClick={() => setMenu(null)}>
      <header
        className={`studio-topbar ${topbarCollapsed ? "collapsed" : ""}`}
        onMouseEnter={() => {
          if (topbarHoverTimerRef.current) {
            window.clearTimeout(topbarHoverTimerRef.current);
          }
        }}
        onMouseLeave={() => {
          if (!showApiKeyModal) {
            topbarHoverTimerRef.current = window.setTimeout(() => setTopbarCollapsed(true), 2000);
          }
        }}
      >
        <div className="brand-block">
          <span className="brand-kicker">ZHUGUANG AUDIO WORKSTATION</span>
          <h1>铸光音频工作站</h1>
        </div>
        <div className="topbar-actions">
          <StatusPill apiKey={apiKey} onOpenModal={openApiKeyModal} />
          <button type="button" onClick={() => void saveWorkspace()}>
            <Save size={16} />
            {isSaving ? "保存中" : "保存"}
          </button>
        </div>
      </header>

      {apiKey === DEFAULT_API_KEY && showDefaultKeyWarning ? (
        <section className="api-warning">
          <AlertTriangle size={18} />
          <span>当前使用的是默认 API Key，不保证长期可用。请点击右上角 API Key 区域配置自己的密钥。</span>
          <button className="api-warning-close" type="button" onClick={() => setShowDefaultKeyWarning(false)}>
            <X size={16} />
          </button>
        </section>
      ) : null}

      {showApiKeyModal && (
        <div className="api-key-modal" onClick={closeApiKeyModal}>
          <div className="api-key-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="api-key-modal-header">
              <h3>
                <Key size={18} />
                配置 API Key
              </h3>
              <button className="api-key-modal-close" type="button" onClick={closeApiKeyModal}>
                <X size={18} />
              </button>
            </div>
            <div className="api-key-modal-body">
              <p className="api-key-modal-hint">
                请输入您的 MiMo API Key。可前往{" "}
                <a href="https://platform.xiaomimimo.com/" target="_blank" rel="noopener noreferrer">
                  platform.xiaomimimo.com
                </a>{" "}
                获取。
              </p>
              <input
                type="text"
                className="api-key-input"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="sk-..."
                spellCheck={false}
              />
              {apiKey === DEFAULT_API_KEY && (
                <p className="api-key-modal-warn">
                  <AlertTriangle size={14} />
                  当前使用的默认 Key 不可长期使用，不保证可用性，建议尽快配置自己的密钥。
                </p>
              )}
              <div className="api-endpoint-section">
                <p className="api-key-modal-hint">
                  API 地址（可选，留空使用默认地址）：
                </p>
                <input
                  type="text"
                  className="api-key-input"
                  value={apiEndpointInput}
                  onChange={(e) => setApiEndpointInput(e.target.value)}
                  placeholder="https://api.xiaomimimo.com/v1/chat/completions"
                  spellCheck={false}
                />
                <p className="api-endpoint-hint">
                  token 套餐计划可使用：https://token-plan-cn.xiaomimimo.com/v1/chat/completions
                </p>
                <p className="api-endpoint-hint">
                  非套餐请保持默认
                </p>
              </div>
            </div>
            <div className="api-key-modal-footer">
              <button type="button" className="api-key-btn-cancel" onClick={closeApiKeyModal}>
                取消
              </button>
              <button type="button" className="api-key-btn-save" onClick={saveApiKey}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="studio-layout">
        <aside className={`board-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="sidebar-title">
            <PanelTop size={17} />
            <span>画板库</span>
            <button
              className="sidebar-toggle"
              type="button"
              onClick={() => setSidebarCollapsed((value) => !value)}
              title={sidebarCollapsed ? "展开画板库" : "折叠画板库"}
            >
              {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          </div>
          {!sidebarCollapsed && (
            <>
              <button className="new-board" type="button" onClick={() => setBoardDialog("choice")}>
                <Plus size={16} />
                新建画板
              </button>
              <div className="board-list">
                {workspaces.map((workspace) => (
                  <div className="board-list-entry" key={workspace.id}>
                    <button
                      className={workspace.id === activeWorkspace?.id ? "board-item active" : "board-item"}
                      type="button"
                      onClick={() => void loadWorkspace(workspace.id)}
                    >
                      <strong>
                        {workspace.type === "audiobook" ? <BookOpen size={14} style={{ marginRight: 6, verticalAlign: "middle" }} /> : null}
                        {workspace.name}
                      </strong>
                      <span>
                        {workspace.type === "audiobook"
                          ? `${workspace.characterCount ?? 0} 角色 / ${workspace.segmentCount ?? 0} 段落`
                          : `${workspace.nodeCount ?? 0} 节点 / ${workspace.edgeCount ?? 0} 连线`}
                      </span>
                    </button>
                    {workspace.id === activeWorkspace?.id && activeWorkspace.type === "board" && activeWorkspace.stashItems.length > 0 ? (
                      <StashPanel
                        isOpen={isStashOpen}
                        items={activeWorkspace.stashItems}
                        onBatchDownload={() => void downloadStashZip()}
                        onDelete={deleteStashItem}
                        onToggle={() => setIsStashOpen((value) => !value)}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
              <button className="danger subtle" type="button" onClick={() => void deleteWorkspace()} disabled={!activeWorkspace}>
                <Trash2 size={16} />
                删除当前画板
              </button>
            </>
          )}
        </aside>

        {activeWorkspace?.type === "audiobook" ? (
          <AudiobookConsole
            workspace={activeWorkspace}
            apiKey={apiKey}
            apiEndpoint={apiEndpoint}
            onPatch={patchAudiobook}
            onAddChapter={addAudiobookChapter}
            onActivateChapter={(chapterId) => void activateAudiobookChapter(chapterId)}
            onCreateCharacter={createAudiobookCharacter}
            onAnalyze={analyzeAudiobookCharacters}
            onGenerateVoice={(charId) => void generateCharacterVoice(charId)}
            onDeleteVoice={(charId) => void deleteCharacterVoice(charId)}
            onAutoAnnotate={autoAnnotateAudiobook}
            onUpdateSegment={(segId, patch) => void updateAudiobookSegment(segId, patch)}
            onSaveWorkspace={saveWorkspace}
            onGenerate={generateAudiobookAudio}
            onRetryProduct={retryAudiobookProduct}
          />
        ) : (
          <section className="canvas-panel">
            <div className="canvas-titlebar">
              <input
                value={activeWorkspace?.name ?? ""}
                onChange={(event) => patchWorkspaceName(event.target.value)}
                onBlur={() => void saveWorkspace()}
                placeholder="未命名工作台"
              />
              <span>右键画布添加节点，拖动端口建立连接</span>
            </div>
            <div className="flow-wrap" onContextMenu={openContextMenu}>
              <ReactFlow<StudioNode, StudioEdge>
                nodes={hydratedNodes}
                edges={hydratedEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={(instance) => {
                  flowRef.current = instance;
                }}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#3f3a2d" gap={34} size={1.2} variant={BackgroundVariant.Dots} />
                <Controls />
                <MiniMap pannable zoomable nodeColor="#c5a45d" maskColor="rgba(8, 8, 7, 0.72)" />
              </ReactFlow>
              {menu ? <ContextMenu menu={menu} onAdd={addNode} /> : null}
            </div>
          </section>
        )}
      </section>
      {boardDialog ? (
        <BoardCreateDialog
          mode={boardDialog}
          onClose={() => setBoardDialog(null)}
          onCreateBlank={() => {
            setBoardDialog(null);
            void createWorkspace();
          }}
          onCreateSmart={createSmartWorkspace}
          onCreateAudiobook={async (data) => {
            await createAudiobookWorkspace(data);
          }}
          onSwitchMode={setBoardDialog}
        />
      ) : null}
    </main>
  );
}

function BoardCreateDialog({
  mode,
  onClose,
  onCreateBlank,
  onCreateSmart,
  onCreateAudiobook,
  onSwitchMode
}: {
  mode: "choice" | "smart" | "audiobook";
  onClose: () => void;
  onCreateBlank: () => void;
  onCreateSmart: (formData: FormData) => Promise<void>;
  onCreateAudiobook: (data: { novelText: string; characterHints: string }) => Promise<void>;
  onSwitchMode: (mode: "choice" | "smart" | "audiobook") => void;
}) {
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState<string | null>(null);
  const [sceneDescription, setSceneDescription] = useState("");
  const [script, setScript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [isCreatingAudiobook, setIsCreatingAudiobook] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  // 有声书表单状态
  const [novelText, setNovelText] = useState("");
  const [characterHints, setCharacterHints] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const progressTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      stopRecordingTimer();
      stopRecordingStream();
      if (progressTimerRef.current) {
        window.clearTimeout(progressTimerRef.current);
      }
    };
  }, []);

  const progressStages = [
    { percent: 15, text: "正在读取..." },
    { percent: 35, text: "正在分析情感..." },
    { percent: 55, text: "正在规划画板..." },
    { percent: 75, text: "画板创建中..." },
    { percent: 90, text: "正在收尾..." },
    { percent: 95, text: "马上就好了..." }
  ];

  const audiobookProgressStages = [
    { percent: 12, text: "正在连接文段切分模型..." },
    { percent: 28, text: "正在阅读小说原文..." },
    { percent: 45, text: "正在识别旁白和角色对话..." },
    { percent: 62, text: "正在拆分单一说话人片段..." },
    { percent: 82, text: "正在整理有声书结构..." },
    { percent: 95, text: "即将创建画板..." }
  ];

  function startProgressSimulation(stages = progressStages, initialText = "正在连接 AI 服务...") {
    setProgress(0);
    setProgressText(initialText);
    let stageIndex = 0;

    function advance() {
      if (stageIndex < stages.length) {
        const stage = stages[stageIndex];
        setProgress(stage.percent);
        setProgressText(stage.text);
        stageIndex++;
        const delay = 3000 + Math.random() * 2000;
        progressTimerRef.current = window.setTimeout(advance, delay);
      }
    }

    progressTimerRef.current = window.setTimeout(advance, 500);
  }

  function stopProgressSimulation(finalProgress: number) {
    if (progressTimerRef.current) {
      window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    setProgress(finalProgress);
  }

  async function setSmartVoiceFile(file: File) {
    if (!allowedAudioTypes.has(file.type) && !/\.(mp3|m4a|mp4|wav)$/i.test(file.name)) {
      setError("仅支持 mp3、m4a/mp4 或 wav 参考音频。");
      return;
    }

    if (file.size > maxAudioBytes) {
      setError(`参考音频不能超过 ${formatBytes(maxAudioBytes)}。`);
      return;
    }

    setVoiceFile(file);
    setVoicePreviewUrl(await blobToDataUrl(file));
    setError(null);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void setSmartVoiceFile(file);
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("当前浏览器不支持录音，请改用上传音频文件。");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      setRecordingSeconds(0);
      setIsRecording(true);
      setError(null);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        void commitRecording(recorder.mimeType || mimeType || "audio/webm");
      };
      recorder.start();
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((value) => value + 1);
      }, 1000);
    } catch (recordingError) {
      stopRecordingStream();
      setIsRecording(false);
      setError(recordingError instanceof Error ? recordingError.message : "录音启动失败。");
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    setIsRecording(false);
    stopRecordingTimer();
  }

  async function commitRecording(mimeType: string) {
    const chunks = recordingChunksRef.current;
    recordingChunksRef.current = [];
    stopRecordingStream();

    if (chunks.length === 0) {
      setError("没有录到有效音频。");
      return;
    }

    try {
      const recordedBlob = new Blob(chunks, { type: mimeType });
      const wavBlob = await convertRecordedBlobToWav(recordedBlob);
      const fileName = `smart-reference-${formatDateForFile(new Date())}.wav`;
      const file = new File([wavBlob], fileName, { type: "audio/wav" });
      await setSmartVoiceFile(file);
    } catch (recordingError) {
      setError(recordingError instanceof Error ? recordingError.message : "录音处理失败。");
    }
  }

  function stopRecordingTimer() {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }

  function stopRecordingStream() {
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
  }

  async function submitSmartWorkspace() {
    const paragraphs = splitScriptInput(script);
    if (!sceneDescription.trim()) {
      setError("请填写场景描述。");
      return;
    }
    if (paragraphs.length === 0) {
      setError("请填写台词文稿，并使用 ---- 分隔独立段落。");
      return;
    }

    setIsGenerating(true);
    setError(null);
    startProgressSimulation();
    try {
      const formData = new FormData();
      if (voiceFile) {
        formData.append("voice", voiceFile);
      }
      formData.append("sceneDescription", sceneDescription.trim());
      formData.append("script", script.trim());
      await onCreateSmart(formData);
      stopProgressSimulation(100);
      setProgressText("我正在全速处理");
      await new Promise((resolve) => setTimeout(resolve, 500));
      onClose();
    } catch (submitError) {
      stopProgressSimulation(0);
      setError(submitError instanceof Error ? submitError.message : "智能画板生成失败。");
    } finally {
      setIsGenerating(false);
    }
  }

  async function submitAudiobookWorkspace() {
    if (!novelText.trim()) {
      setError("请输入小说原文。");
      return;
    }

    setIsCreatingAudiobook(true);
    setError(null);
    startProgressSimulation(audiobookProgressStages, "正在连接文段切分模型...");
    try {
      await onCreateAudiobook({ novelText: novelText.trim(), characterHints: characterHints.trim() });
      stopProgressSimulation(100);
      setProgressText("有声书创建完成");
      await new Promise((resolve) => setTimeout(resolve, 500));
      onClose();
    } catch (submitError) {
      stopProgressSimulation(0);
      setError(submitError instanceof Error ? submitError.message : "创建有声书失败。");
    } finally {
      setIsCreatingAudiobook(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => {
      if (!isGenerating && !isCreatingAudiobook) onClose();
    }}>
      <section className="board-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <strong>{mode === "choice" ? "新建画板" : mode === "smart" ? "智能画板" : "智能有声书"}</strong>
            <span>{mode === "choice" ? "选择创建方式" : mode === "smart" ? "根据场景、文稿和可选参考音频生成工作流" : "输入小说原文和人物信息，AI自动创建角色音色并生成有声书"}</span>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭" disabled={isGenerating || isCreatingAudiobook}>
            ×
          </button>
        </header>

        {mode === "choice" ? (
          <div className="create-choice-grid">
            <button type="button" onClick={onCreateBlank}>
              <PanelTop size={18} />
              <span>空白画板</span>
              <small>创建一个新的空白画板</small>
            </button>
            <button type="button" onClick={() => onSwitchMode("smart")}>
              <Sparkles size={18} />
              <span>智能画板</span>
              <small>有参考音频则生成克隆链路，无参考音频则生成音色创造链路</small>
            </button>
            <button type="button" onClick={() => onSwitchMode("audiobook")}>
              <BookOpen size={18} />
              <span>智能有声书</span>
              <small>输入小说原文和人物信息，AI自动创建角色音色并生成有声书</small>
            </button>
          </div>
        ) : mode === "smart" ? (
          <div className="smart-board-form">
            <label className="file-picker nodrag">
              <input accept="audio/*,video/mp4,.mp3,.m4a,.mp4,.wav" type="file" onChange={onFileChange} />
              <span>{voiceFile ? voiceFile.name : "上传参考音频（可选）"}</span>
              <small>{voiceFile ? `${voiceFile.type || "audio"} · ${formatBytes(voiceFile.size)}` : "不上传时，将使用音色创造节点生成每段音频"}</small>
            </label>
            <div className="recording-panel nodrag">
              <button className={isRecording ? "record-button recording" : "record-button"} type="button" onClick={() => void startRecording()} disabled={isRecording || isGenerating}>
                <Mic2 size={15} />
                开始录制
              </button>
              <button className="record-stop-button" type="button" onClick={stopRecording} disabled={!isRecording || isGenerating}>
                <Square size={13} />
                停止
              </button>
              <span>{isRecording ? `录制中 ${formatTime(recordingSeconds)}` : "当场录制参考音频"}</span>
            </div>
            {voicePreviewUrl ? <StudioAudioPlayer src={voicePreviewUrl} /> : null}
            <label className="node-field">
              <span>场景描述</span>
              <textarea value={sceneDescription} onChange={(event) => setSceneDescription(event.target.value)} rows={4} placeholder="用简单的关键词去描述这段文本的语境语气并补充必要的信息，帮助模型理解需求" />
            </label>
            <label className="node-field">
              <span>完整台词文稿</span>
              <textarea
                value={script}
                onChange={(event) => setScript(event.target.value)}
                rows={8}
                placeholder="这里输入需要模型朗读的内容，段落使用 ---- 分割，每段建议小于100字"
              />
            </label>
            {error ? <p className="node-error">{error}</p> : null}
            {isGenerating && (
              <div className="smart-progress">
                <div className="smart-progress-bar">
                  <div className="smart-progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <p className="smart-progress-text">{progressText}</p>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => onSwitchMode("choice")} disabled={isGenerating}>
                返回
              </button>
              <button className="run-button" type="button" onClick={() => void submitSmartWorkspace()} disabled={isGenerating || isRecording}>
                {isGenerating ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
                {isGenerating ? "生成中" : "生成智能画板"}
              </button>
            </div>
          </div>
        ) : (
          <div className="smart-board-form">
            <label className="node-field">
              <span>小说原文</span>
              <textarea
                value={novelText}
                onChange={(event) => setNovelText(event.target.value)}
                rows={10}
                placeholder="粘贴小说原文，AI 会按旁白和角色对话切分片段"
                disabled={isCreatingAudiobook}
              />
            </label>
            <label className="node-field">
              <span>关键人物背景信息</span>
              <textarea
                value={characterHints}
                onChange={(event) => setCharacterHints(event.target.value)}
                rows={4}
                placeholder={"每行一个角色，格式：角色名，性别，年龄，声音特点\n例如：林黛玉，女，16岁，声音清脆柔弱，略带哀愁"}
                disabled={isCreatingAudiobook}
              />
            </label>
            {error ? <p className="node-error">{error}</p> : null}
            {isCreatingAudiobook && (
              <div className="smart-progress">
                <div className="smart-progress-bar">
                  <div className="smart-progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <p className="smart-progress-text">{progressText}</p>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => onSwitchMode("choice")} disabled={isCreatingAudiobook}>
                返回
              </button>
              <button
                className="run-button"
                type="button"
                onClick={() => void submitAudiobookWorkspace()}
                disabled={isCreatingAudiobook}
              >
                {isCreatingAudiobook ? <Loader2 className="spin" size={16} /> : <BookOpen size={16} />}
                {isCreatingAudiobook ? "切分中..." : "创建有声书"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ====== 有声书控制台组件 ======

function AudiobookConsole({
  workspace,
  apiKey,
  apiEndpoint,
  onPatch,
  onAddChapter,
  onActivateChapter,
  onCreateCharacter,
  onAnalyze,
  onGenerateVoice,
  onDeleteVoice,
  onAutoAnnotate,
  onUpdateSegment,
  onSaveWorkspace,
  onGenerate,
  onRetryProduct
}: {
  workspace: AudiobookWorkspacePayload;
  apiKey: string;
  apiEndpoint: string;
  onPatch: (patch: Partial<AudiobookWorkspacePayload>) => void;
  onAddChapter: (data: { title: string; novelText: string; characterHints: string }) => Promise<void>;
  onActivateChapter: (chapterId: string) => void;
  onCreateCharacter: (formData: FormData) => Promise<void>;
  onAnalyze: () => Promise<void>;
  onGenerateVoice: (charId: string) => void;
  onDeleteVoice: (charId: string) => void;
  onAutoAnnotate: () => Promise<void>;
  onUpdateSegment: (segId: string, patch: { characterId: string | null; characterName: string; emotion: string }) => void;
  onSaveWorkspace: () => Promise<void>;
  onGenerate: () => Promise<void>;
  onRetryProduct: (productId: string) => Promise<void>;
}) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [analyzeText, setAnalyzeText] = useState("");
  const [editingSegId, setEditingSegId] = useState<string | null>(null);
  const [editCharId, setEditCharId] = useState<string>("");
  const [editEmotion, setEditEmotion] = useState("");
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotateProgress, setAnnotateProgress] = useState(0);
  const [annotateText, setAnnotateText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [chapterTitle, setChapterTitle] = useState("");
  const [chapterText, setChapterText] = useState("");
  const [chapterHints, setChapterHints] = useState("");
  const [isAddingChapter, setIsAddingChapter] = useState(false);
  const [characterName, setCharacterName] = useState("");
  const [characterRoleType, setCharacterRoleType] = useState<AudiobookCharacter["roleType"]>("supporting");
  const [characterVoiceMode, setCharacterVoiceMode] = useState<AudiobookCharacter["voiceMode"]>("designed");
  const [characterDescription, setCharacterDescription] = useState("");
  const [characterTraits, setCharacterTraits] = useState("");
  const [characterAliases, setCharacterAliases] = useState("");
  const [characterVoiceFile, setCharacterVoiceFile] = useState<File | null>(null);
  const [isCreatingCharacter, setIsCreatingCharacter] = useState(false);
  const productSectionRef = useRef<HTMLDivElement | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const runningActionRef = useRef<"analyze" | "annotate" | "generate" | null>(null);

  const allVoicesReady = workspace.characters.length > 0 && workspace.characters.every((c) => c.voiceStatus === "ready");
  const hasAnnotations = workspace.segments.some((s) => s.characterId || s.characterName);
  const hasUsedAutoAnnotation = workspace.segments.some((s) => s.isAutoAnnotated);
  const showProductSection = isGenerating || workspace.phase === "generation" || workspace.products.length > 0;
  const allProductsReady = workspace.products.length > 0 && workspace.products.every((product) => product.status === "ready" && product.audioDataUrl);
  const activeChapter = workspace.chapters.find((chapter) => chapter.id === workspace.activeChapterId) ?? workspace.chapters[0];
  const narrator = workspace.characters.find((character) => character.roleType === "narrator");

  useEffect(() => {
    if (!isGenerating) {
      return;
    }
    window.requestAnimationFrame(() => {
      productSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [isGenerating]);

  function startProgress(
    setProgress: (v: number) => void,
    setText: (v: string) => void,
    stages: { percent: number; text: string }[]
  ) {
    let stageIndex = 0;
    let currentPercent = 5;
    setProgress(5);
    setText(stages[0]?.text || "处理中...");
    function advance() {
      if (stageIndex < stages.length) {
        currentPercent = stages[stageIndex].percent;
        setProgress(currentPercent);
        setText(stages[stageIndex].text);
        stageIndex++;
        progressTimerRef.current = window.setTimeout(advance, 2000 + Math.random() * 2000);
      } else {
        // 模拟阶段结束，继续缓慢脉冲动画直到 stopProgress 被调用
        const base = currentPercent;
        const pulse = Math.min(base + 2 + Math.random() * 3, 95);
        setProgress(pulse);
        progressTimerRef.current = window.setTimeout(() => {
          setProgress(base);
          progressTimerRef.current = window.setTimeout(advance, 3000 + Math.random() * 2000);
        }, 1500);
      }
    }
    progressTimerRef.current = window.setTimeout(advance, 800);
  }

  function stopProgress(finalProgress: number, setProgress: (v: number) => void) {
    if (progressTimerRef.current) {
      window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    setProgress(finalProgress);
  }

  async function handleAnalyze() {
    if (runningActionRef.current) {
      return;
    }
    runningActionRef.current = "analyze";
    setIsAnalyzing(true);
    setAnalyzeProgress(0);
    startProgress(setAnalyzeProgress, setAnalyzeText, [
      { percent: 15, text: "正在连接 AI 服务..." },
      { percent: 35, text: "正在阅读小说原文..." },
      { percent: 55, text: "识别出场人物..." },
      { percent: 75, text: "生成角色描述..." },
      { percent: 90, text: "生成音色描述..." },
      { percent: 95, text: "即将完成..." }
    ]);
    try {
      await onAnalyze();
      stopProgress(100, setAnalyzeProgress);
      setAnalyzeText("分析完成！");
    } catch {
      stopProgress(0, setAnalyzeProgress);
      setAnalyzeText("分析失败，请重试");
    } finally {
      setTimeout(() => {
        runningActionRef.current = null;
        setIsAnalyzing(false);
      }, 500);
    }
  }

  async function handleAutoAnnotate() {
    if (runningActionRef.current || hasUsedAutoAnnotation) {
      return;
    }
    runningActionRef.current = "annotate";
    setIsAnnotating(true);
    setAnnotateProgress(0);
    startProgress(setAnnotateProgress, setAnnotateText, [
      { percent: 15, text: "正在连接 AI 服务..." },
      { percent: 35, text: "分析段落内容..." },
      { percent: 55, text: "识别对话角色..." },
      { percent: 75, text: "生成朗读情绪..." },
      { percent: 90, text: "整理标注结果..." },
      { percent: 95, text: "即将完成..." }
    ]);
    try {
      await onAutoAnnotate();
      stopProgress(100, setAnnotateProgress);
      setAnnotateText("标注完成！");
    } catch {
      stopProgress(0, setAnnotateProgress);
      setAnnotateText("标注失败，请重试");
    } finally {
      setTimeout(() => {
        runningActionRef.current = null;
        setIsAnnotating(false);
      }, 500);
    }
  }

  async function handleGenerate() {
    if (runningActionRef.current) {
      return;
    }
    runningActionRef.current = "generate";
    setIsGenerating(true);
    try {
      await onSaveWorkspace();
      await onGenerate();
    } catch (error) {
      console.error("[audiobook:generate] failed", error);
    } finally {
      setTimeout(() => {
        runningActionRef.current = null;
        setIsGenerating(false);
      }, 500);
    }
  }

  async function handleRetryProduct(productId: string) {
    await onRetryProduct(productId);
  }

  async function handleAddChapter() {
    if (!chapterText.trim() || isAddingChapter) {
      return;
    }
    setIsAddingChapter(true);
    try {
      await onAddChapter({
        title: chapterTitle.trim() || `章节 ${workspace.chapters.length + 1}`,
        novelText: chapterText,
        characterHints: chapterHints
      });
      setChapterTitle("");
      setChapterText("");
      setChapterHints("");
    } finally {
      setIsAddingChapter(false);
    }
  }

  async function handleCreateCharacter() {
    if (!characterName.trim() || isCreatingCharacter) {
      return;
    }
    setIsCreatingCharacter(true);
    try {
      const formData = new FormData();
      formData.append("name", characterName.trim());
      formData.append("roleType", characterRoleType);
      formData.append("aliases", characterAliases);
      formData.append("voiceTraits", characterTraits);
      formData.append("voiceDescription", characterDescription);
      formData.append("personality", characterTraits || characterDescription);
      if (characterVoiceMode === "cloned" && characterVoiceFile) {
        formData.append("voice", characterVoiceFile);
      }
      await onCreateCharacter(formData);
      setCharacterName("");
      setCharacterRoleType("supporting");
      setCharacterVoiceMode("designed");
      setCharacterDescription("");
      setCharacterTraits("");
      setCharacterAliases("");
      setCharacterVoiceFile(null);
    } finally {
      setIsCreatingCharacter(false);
    }
  }

  async function downloadAudiobookProductsZip() {
    if (!allProductsReady) {
      return;
    }

    const zip = new JSZip();
    const usedNames = new Map<string, number>();
    workspace.products.forEach((product, index) => {
      if (!product.audioDataUrl) {
        return;
      }
      const indexLabel = String(index + 1).padStart(2, "0");
      const characterName = sanitizeFileName(product.characterName || "旁白").replace(/\.[a-z0-9]{1,8}$/i, "");
      const fileName = getUniqueFileName(`segment-${indexLabel}-${characterName}.wav`, usedNames);
      zip.file(fileName, dataUrlToUint8Array(product.audioDataUrl));
    });

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeFileName(workspace.name)}-${formatDateForFile(new Date())}.zip`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function startEditSegment(segId: string) {
    const seg = workspace.segments.find((s) => s.id === segId);
    if (seg) {
      setEditingSegId(segId);
      setEditCharId(seg.characterId || narrator?.id || "");
      setEditEmotion(seg.emotion);
    }
  }

  function saveEditSegment() {
    if (!editingSegId) return;
    const char = workspace.characters.find((c) => c.id === editCharId);
    onUpdateSegment(editingSegId, {
      characterId: editCharId || narrator?.id || null,
      characterName: char?.name || "旁白",
      emotion: editEmotion
    });
    setEditingSegId(null);
  }

  return (
    <section className="audiobook-panel">
      <div className="audiobook-titlebar">
        <BookOpen size={16} />
        <input
          value={workspace.name}
          onChange={(event) => onPatch({ name: event.target.value })}
          placeholder="未命名有声书"
        />
        <span className="audiobook-phase-badge">
          {workspace.phase === "character-creation" ? "角色创建" : workspace.phase === "annotation" ? "文本标注" : "语音生成"}
        </span>
      </div>

      <div className="audiobook-body">
        <div className="audiobook-section">
          <div className="section-header">
            <h3>章节项目</h3>
            <span className="section-hint inline">当前：{activeChapter?.title || "未命名章节"}</span>
          </div>
          <div className="chapter-tabs">
            {workspace.chapters.map((chapter, index) => (
              <button
                key={chapter.id}
                type="button"
                className={chapter.id === workspace.activeChapterId ? "chapter-tab active" : "chapter-tab"}
                onClick={() => onActivateChapter(chapter.id)}
              >
                <BookOpen size={13} />
                {chapter.title || `章节 ${index + 1}`}
              </button>
            ))}
          </div>
          <div className="chapter-create-panel">
            <input
              value={chapterTitle}
              onChange={(event) => setChapterTitle(event.target.value)}
              placeholder={`章节 ${workspace.chapters.length + 1}`}
            />
            <textarea
              value={chapterText}
              onChange={(event) => setChapterText(event.target.value)}
              placeholder="粘贴下一章或新的小说片段，系统会加入当前书籍项目并复用音色库"
              rows={4}
            />
            <textarea
              value={chapterHints}
              onChange={(event) => setChapterHints(event.target.value)}
              placeholder="可选：本章新增人物说明，每行一个角色"
              rows={2}
            />
            <button className="run-button" type="button" onClick={() => void handleAddChapter()} disabled={isAddingChapter || !chapterText.trim()}>
              {isAddingChapter ? <Loader2 className="spin" size={14} /> : <BookPlus size={14} />}
              {isAddingChapter ? "新增中..." : "添加章节"}
            </button>
          </div>
        </div>

        <div className="audiobook-section">
          <div className="section-header">
            <h3>书籍音色库</h3>
            {narrator ? <span className="section-hint inline">旁白：{narrator.voiceStatus === "ready" ? "已准备" : "待生成"}</span> : null}
          </div>
          <div className="manual-character-panel">
            <input value={characterName} onChange={(event) => setCharacterName(event.target.value)} placeholder="音色角色名称，如：主角 / 特邀主播A" />
            <select value={characterRoleType} onChange={(event) => setCharacterRoleType(event.target.value as AudiobookCharacter["roleType"])}>
              <option value="protagonist">主角</option>
              <option value="supporting">配角</option>
              <option value="narrator">旁白</option>
              <option value="custom">自定义</option>
            </select>
            <select value={characterVoiceMode} onChange={(event) => setCharacterVoiceMode(event.target.value as AudiobookCharacter["voiceMode"])}>
              <option value="designed">自然语言音色设计</option>
              <option value="cloned">上传参考音频克隆</option>
            </select>
            <input value={characterAliases} onChange={(event) => setCharacterAliases(event.target.value)} placeholder="别名/称呼，可用逗号分隔" />
            <textarea value={characterTraits} onChange={(event) => setCharacterTraits(event.target.value)} placeholder="性格、身份、声音特点" rows={2} />
            {characterVoiceMode === "designed" ? (
              <textarea value={characterDescription} onChange={(event) => setCharacterDescription(event.target.value)} placeholder="音色描述：男女老少、声音质感、气质等" rows={2} />
            ) : (
              <label className="upload-row">
                <FileAudio size={14} />
                <span>{characterVoiceFile ? characterVoiceFile.name : "上传参考音频"}</span>
                <input
                  type="file"
                  accept="audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/wav,audio/wave,video/mp4"
                  onChange={(event) => setCharacterVoiceFile(event.target.files?.[0] ?? null)}
                />
              </label>
            )}
            <button className="run-button" type="button" onClick={() => void handleCreateCharacter()} disabled={isCreatingCharacter || !characterName.trim()}>
              {isCreatingCharacter ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
              {isCreatingCharacter ? "创建中..." : "创建音色角色"}
            </button>
          </div>
        </div>

        {/* 角色创造区域 */}
        <div className="audiobook-section">
          <div className="section-header">
            <h3>角色创造</h3>
            {workspace.phase === "character-creation" && (
              <button className="run-button" type="button" onClick={() => void handleAnalyze()} disabled={isAnalyzing}>
                {isAnalyzing ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />}
                {isAnalyzing ? "分析中..." : "开始分析"}
              </button>
            )}
          </div>

          {isAnalyzing && (
            <div className="smart-progress">
              <div className="smart-progress-bar">
                <div className="smart-progress-fill" style={{ width: `${analyzeProgress}%` }} />
              </div>
              <p className="smart-progress-text">{analyzeText}</p>
            </div>
          )}

          {workspace.characters.length === 0 && !isAnalyzing && (
            <p className="section-hint">点击"开始分析"，AI将从小说原文中识别角色并生成音色描述。</p>
          )}

          <div className="character-grid">
            {workspace.characters.map((char) => (
              <div key={char.id} className="character-card">
                <div className="character-info">
                  <strong>{char.name}</strong>
                  {char.gender && <span className="char-tag">{char.gender}</span>}
                  {char.age && <span className="char-tag">{char.age}</span>}
                  <p className="char-personality">{char.personality}</p>
                  <p className="char-voice-desc">{char.voiceDescription}</p>
                  {char.voiceSampleText && <p className="char-voice-sample">试听：{char.voiceSampleText}</p>}
                </div>
                <div className="character-voice">
                  {char.voiceStatus === "ready" && char.voiceDataUrl ? (
                    <>
                      <StudioAudioPlayer src={char.voiceDataUrl} />
                      <button className="icon-button" type="button" onClick={() => void onDeleteVoice(char.id)} title="重新生成">
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : char.voiceStatus === "generating" ? (
                    <span className="voice-status generating"><Loader2 className="spin" size={14} /> 生成中...</span>
                  ) : char.voiceStatus === "error" ? (
                    <span className="voice-status error">{char.voiceError || "生成失败"}</span>
                  ) : (
                    <button className="run-button" type="button" onClick={() => onGenerateVoice(char.id)}>
                      <AudioLines size={14} />
                      生成音色
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {workspace.phase === "character-creation" && allVoicesReady && (
            <button
              className="run-button phase-advance"
              type="button"
              onClick={() => onPatch({ phase: "annotation" })}
            >
              确认并进入标注
            </button>
          )}
        </div>

        {/* 标注区域 */}
        {workspace.phase !== "character-creation" && (
          <div className="audiobook-section">
            <div className="section-header">
              <h3>文本标注</h3>
              <div className="annotation-controls">
                <button
                  className="run-button"
                  type="button"
                  onClick={() => void handleAutoAnnotate()}
                  disabled={isAnnotating || hasUsedAutoAnnotation}
                  title={hasUsedAutoAnnotation ? "AI auto annotation can only be used once. Please edit manually." : undefined}
                >
                  {isAnnotating ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />}
                  {isAnnotating ? "标注中..." : "AI 自动标注"}
                </button>
              </div>
            </div>

            {isAnnotating && (
              <div className="smart-progress">
                <div className="smart-progress-bar">
                  <div className="smart-progress-fill" style={{ width: `${annotateProgress}%` }} />
                </div>
                <p className="smart-progress-text">{annotateText}</p>
              </div>
            )}

            <div className="segment-list">
              {workspace.segments.map((seg, index) => (
                <div key={seg.id} className="segment-block" onDoubleClick={() => startEditSegment(seg.id)}>
                  <div className="segment-header">
                    <span className="seg-index">#{index + 1}</span>
                    {seg.characterName && (
                      <span className="annotation-badge">
                        {seg.characterName}
                        {seg.emotion && ` · ${seg.emotion}`}
                      </span>
                    )}
                  </div>
                  <p className="segment-text">{seg.text}</p>
                  {editingSegId === seg.id && (
                    <div className="segment-editor">
                      <select value={editCharId} onChange={(e) => setEditCharId(e.target.value)}>
                        {workspace.characters.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={editEmotion}
                        onChange={(e) => setEditEmotion(e.target.value)}
                        placeholder="朗读情绪（如：温柔地、焦急地）"
                      />
                      <button type="button" onClick={saveEditSegment}>确定</button>
                      <button type="button" onClick={() => setEditingSegId(null)}>取消</button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {workspace.phase === "annotation" && hasAnnotations && !isGenerating && (
              <>
                <button className="run-button phase-advance" type="button" onClick={() => void handleGenerate()} disabled={isGenerating}>
                  {isGenerating ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
                  {isGenerating ? "生成中..." : "一键生成"}
                </button>
              </>
            )}
          </div>
        )}

        {/* 产物列表区域 */}
        {showProductSection && (
          <div className="audiobook-section" ref={productSectionRef}>
            <div className="section-header">
              <h3>产物列表</h3>
              <div className="product-toolbar">
                {allProductsReady && (
                  <button className="run-button" type="button" onClick={() => void downloadAudiobookProductsZip()}>
                    <Download size={14} />
                    批量下载 ZIP
                  </button>
                )}
                <button
                  className="run-button"
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={isGenerating}
                >
                  {isGenerating ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                  {isGenerating ? "生成中..." : "重新生成"}
                </button>
              </div>
            </div>
            <div className="product-list">
              {workspace.products.map((prod, index) => (
                <div key={prod.id} className="product-item">
                  <div className="product-info">
                    <span className="product-index">#{index + 1}</span>
                    <span className="product-char">{prod.characterName}</span>
                    <span className="product-text">{prod.text.slice(0, 50)}{prod.text.length > 50 ? "..." : ""}</span>
                  </div>
                  {prod.status === "ready" && prod.audioDataUrl ? (
                    <div className="product-actions">
                      <StudioAudioPlayer src={prod.audioDataUrl} />
                      <a
                        className="icon-button product-download-button"
                        href={prod.audioDataUrl}
                        download={`segment-${index + 1}.wav`}
                        title="下载"
                      >
                        <Download size={14} />
                      </a>
                      <button className="icon-button" type="button" onClick={() => void handleRetryProduct(prod.id)} title="重新生成">
                        <RefreshCw size={14} />
                      </button>
                    </div>
                  ) : prod.status === "generating" ? (
                    <span className="voice-status generating"><Loader2 className="spin" size={14} /> 合成中...</span>
                  ) : prod.status === "error" ? (
                    <div className="product-actions">
                      <span className="voice-status error">{prod.error || "失败"}</span>
                      <button className="icon-button" type="button" onClick={() => void handleRetryProduct(prod.id)} title="重试生成">
                        <RefreshCw size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="product-actions">
                      <span className="voice-status">等待中</span>
                      <button className="icon-button" type="button" onClick={() => void handleRetryProduct(prod.id)} title="生成当前片段">
                        <RefreshCw size={14} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ReferenceAudioNode({ id, data }: NodeProps<StudioNode>) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(data.audio?.dataUrl ?? null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      stopRecordingTimer();
      stopRecordingStream();
    };
  }, []);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!allowedAudioTypes.has(file.type) && !/\.(mp3|m4a|mp4|wav)$/i.test(file.name)) {
      data.onPatch?.(id, { error: "仅支持 mp3、m4a/mp4 或 wav 参考音频。" });
      return;
    }

    if (file.size > maxAudioBytes) {
      data.onPatch?.(id, { error: `参考音频不能超过 ${formatBytes(maxAudioBytes)}。` });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setPreviewUrl(dataUrl);
      data.onPatch?.(id, {
        audio: {
          fileName: file.name,
          mimeType: file.type || guessMimeFromName(file.name),
          size: file.size,
          dataUrl
        },
        error: undefined
      });
    };
    reader.readAsDataURL(file);
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      data.onPatch?.(id, { error: "当前浏览器不支持录音，请改用上传音频文件。" });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      setRecordingSeconds(0);
      setIsRecording(true);
      data.onPatch?.(id, { error: undefined });

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        void commitRecording(recorder.mimeType || mimeType || "audio/webm");
      };
      recorder.start();
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((value) => value + 1);
      }, 1000);
    } catch (error) {
      stopRecordingStream();
      setIsRecording(false);
      data.onPatch?.(id, { error: error instanceof Error ? error.message : "录音启动失败。" });
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    setIsRecording(false);
    stopRecordingTimer();
  }

  async function commitRecording(mimeType: string) {
    const chunks = recordingChunksRef.current;
    recordingChunksRef.current = [];
    stopRecordingStream();

    if (chunks.length === 0) {
      data.onPatch?.(id, { error: "没有录到有效音频。" });
      return;
    }

    try {
      const recordedBlob = new Blob(chunks, { type: mimeType });
      const wavBlob = await convertRecordedBlobToWav(recordedBlob);

      if (wavBlob.size > maxAudioBytes) {
        data.onPatch?.(id, { error: `录音文件不能超过 ${formatBytes(maxAudioBytes)}。请缩短录制时长。` });
        return;
      }

      const fileName = `recorded-reference-${formatDateForFile(new Date())}.wav`;
      const dataUrl = await blobToDataUrl(wavBlob);
      setPreviewUrl(dataUrl);
      data.onPatch?.(id, {
        audio: {
          fileName,
          mimeType: "audio/wav",
          size: wavBlob.size,
          dataUrl
        },
        error: undefined
      });
    } catch (error) {
      data.onPatch?.(id, { error: error instanceof Error ? error.message : "录音处理失败。" });
    }
  }

  function stopRecordingTimer() {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }

  function stopRecordingStream() {
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
  }

  return (
    <StudioNodeFrame id={id} data={data} icon={<FileAudio size={17} />} tone="audio">
      <Handle type="source" position={Position.Right} id="audio" className="node-handle" />
      <label className="file-picker nodrag">
        <input accept="audio/*,video/mp4,.mp3,.m4a,.mp4,.wav" type="file" onChange={onFileChange} />
        <span>{data.audio ? data.audio.fileName : "上传参考音频"}</span>
        <small>{data.audio ? `${data.audio.mimeType} · ${formatBytes(data.audio.size)}` : "支持改后缀的 M4A/MP4"}</small>
      </label>
      <div className="recording-panel nodrag">
        <button className={isRecording ? "record-button recording" : "record-button"} type="button" onClick={() => void startRecording()} disabled={isRecording}>
          <Mic2 size={15} />
          开始录制
        </button>
        <button className="record-stop-button" type="button" onClick={stopRecording} disabled={!isRecording}>
          <Square size={13} />
          停止
        </button>
        <span>{isRecording ? `录制中 ${formatTime(recordingSeconds)}` : "当场录制参考音频"}</span>
      </div>
      {previewUrl ? <StudioAudioPlayer src={previewUrl} /> : null}
      {data.error ? <p className="node-error">{data.error}</p> : null}
    </StudioNodeFrame>
  );
}

function CommentNode({ id, data }: NodeProps<StudioNode>) {
  return (
    <div className="comment-node">
      <textarea
        className="nodrag"
        value={data.text ?? ""}
        onChange={(event) => data.onPatch?.(id, { text: event.target.value })}
        rows={3}
        placeholder="添加注释..."
      />
    </div>
  );
}

function PromptNode({ id, data }: NodeProps<StudioNode>) {
  return (
    <StudioNodeFrame id={id} data={data} icon={<Sparkles size={17} />} tone="prompt">
      <Handle type="source" position={Position.Right} id="text" className="node-handle" />
      <textarea
        className="nodrag"
        value={data.text ?? ""}
        onChange={(event) => data.onPatch?.(id, { text: event.target.value })}
        rows={6}
        placeholder="写入最终要生成成音频的文本，并连接到克隆节点的「文本」输入。"
      />
    </StudioNodeFrame>
  );
}

function VoiceStyleNode({ id, data }: NodeProps<StudioNode>) {
  return (
    <StudioNodeFrame id={id} data={data} icon={<Sparkles size={17} />} tone="style">
      <Handle type="source" position={Position.Right} id="style" className="node-handle" />
      <textarea
        className="nodrag"
        value={data.text ?? ""}
        onChange={(event) => data.onPatch?.(id, { text: event.target.value })}
        rows={6}
        placeholder="写入语气、情绪、语速、角色和导演指令，并连接到克隆节点的「风格」输入。"
      />
      {data.error ? <p className="node-error">{data.error}</p> : null}
    </StudioNodeFrame>
  );
}

function VoiceCloneNode({ id, data }: NodeProps<StudioNode>) {
  return (
    <StudioNodeFrame id={id} data={data} icon={<Mic2 size={17} />} tone="clone">
      <Handle type="target" position={Position.Left} id="voice" className="node-handle handle-voice" />
      <Handle type="target" position={Position.Left} id="instruction" className="node-handle handle-instruction" />
      <Handle type="target" position={Position.Left} id="text" className="node-handle handle-text" />
      <Handle type="source" position={Position.Right} id="output" className="node-handle" />
      <div className="input-map">
        <span>参考</span>
        <span>风格</span>
        <span>文本</span>
      </div>
      <label className="node-field nodrag">
        <span>语音风格（导演文本）</span>
        <textarea value={data.instruction ?? ""} onChange={(event) => data.onPatch?.(id, { instruction: event.target.value })} rows={4} />
      </label>
      <label className="node-field nodrag">
        <span>音频文本</span>
        <textarea value={data.text ?? ""} onChange={(event) => data.onPatch?.(id, { text: event.target.value })} rows={5} />
      </label>
      {data.error ? <p className="node-error">{data.error}</p> : null}
      <button className="run-button nodrag" type="button" onClick={() => data.onRunClone?.(id)} disabled={data.isRunning}>
        {data.isRunning ? <Loader2 className="spin" size={16} /> : <AudioLines size={16} />}
        {data.isRunning ? "生成中" : "运行克隆"}
      </button>
    </StudioNodeFrame>
  );
}

function VoiceDesignNode({ id, data }: NodeProps<StudioNode>) {
  return (
    <StudioNodeFrame id={id} data={data} icon={<Sparkles size={17} />} tone="design">
      <Handle type="target" position={Position.Left} id="text" className="node-handle handle-text" />
      <Handle type="source" position={Position.Right} id="output" className="node-handle" />
      <div className="input-map input-map-design">
        <span>文本</span>
      </div>
      <label className="node-field nodrag">
        <span>音色描述</span>
        <textarea value={data.instruction ?? ""} onChange={(event) => data.onPatch?.(id, { instruction: event.target.value })} rows={5} />
      </label>
      <label className="node-field nodrag">
        <span>音频文本</span>
        <textarea value={data.text ?? ""} onChange={(event) => data.onPatch?.(id, { text: event.target.value })} rows={6} />
      </label>
      {data.error ? <p className="node-error">{data.error}</p> : null}
      <button className="run-button nodrag" type="button" onClick={() => data.onRunVoiceDesign?.(id)} disabled={data.isRunning}>
        {data.isRunning ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
        {data.isRunning ? "生成中" : "批量运行音色创造"}
      </button>
    </StudioNodeFrame>
  );
}

function ArtifactNode({ id, data }: NodeProps<StudioNode>) {
  const artifact = data.artifact;
  const isStashed = artifact ? data.isArtifactStashed?.(artifact) : false;
  const artifactForStash = artifact ? { ...artifact, sourceNodeName: data.title } : null;

  return (
    <StudioNodeFrame id={id} data={data} icon={<Archive size={17} />} tone="artifact">
      <Handle type="target" position={Position.Left} id="artifact" className="node-handle" />
      {artifact ? <Handle type="source" position={Position.Right} id="audio" className="node-handle handle-artifact-audio" /> : null}
      {artifact ? (
        <>
          <StudioAudioPlayer src={artifact.audioDataUrl} />
          <div className="artifact-meta">
            <span>{artifact.fileName}</span>
            <span>{artifact.elapsedMs} ms · {new Date(artifact.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
          </div>
          <div className="artifact-actions">
            <button
              className="download-link nodrag"
              type="button"
              onClick={() => artifactForStash && data.onStashArtifact?.(artifactForStash)}
              disabled={isStashed}
            >
              <Archive size={15} />
              {isStashed ? "已暂存" : "暂存"}
            </button>
            <a className="download-link nodrag" href={artifact.audioDataUrl} download={getArtifactDownloadFileName(data.title, artifact.fileName)}>
              <Download size={15} />
              下载
            </a>
          </div>
        </>
      ) : (
        <p className="node-muted">等待音频克隆节点写入产物。</p>
      )}
    </StudioNodeFrame>
  );
}

function StudioNodeFrame({
  id,
  data,
  icon,
  tone,
  children
}: {
  id: string;
  data: NodeData;
  icon: ReactNode;
  tone: string;
  children: ReactNode;
}) {
  return (
    <section className={`studio-node node-${tone}`}>
      <header className="node-header">
        <div className="node-title-wrap">
          {icon}
          <input
            className="node-title-input nodrag"
            title="节点命名"
            value={data.title}
            onChange={(event) => data.onPatch?.(id, { title: event.target.value })}
          />
        </div>
        <div className="node-header-actions">
          {tone === "style" || tone === "design" ? (
            <button
              className="icon-button optimize-icon nodrag"
              type="button"
              onClick={() => (tone === "style" ? data.onOptimizeStyle?.(id) : data.onOptimizeVoiceDesign?.(id))}
              disabled={data.isRunning}
              title={data.isRunning ? "AI优化中" : tone === "style" ? "AI优化语音风格" : "AI润色音色描述"}
            >
              {data.isRunning ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
            </button>
          ) : null}
          <button className="icon-button nodrag" type="button" onClick={() => data.onDelete?.(id)} title="删除节点">
            <Trash2 size={14} />
          </button>
        </div>
      </header>
      {children}
    </section>
  );
}

function ContextMenu({ menu, onAdd }: { menu: { x: number; y: number }; onAdd: (type: StudioNodeType) => void }) {
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
      <strong>添加工作节点</strong>
      {(Object.keys(nodeCatalog) as StudioNodeType[]).filter((type) => type !== "artifact").map((type) => (
        <button key={type} type="button" onClick={() => onAdd(type)}>
          <span>{nodeCatalog[type].label}</span>
          <small>{nodeCatalog[type].description}</small>
        </button>
      ))}
    </div>
  );
}

function StatusPill({ apiKey, onOpenModal }: { apiKey: string; onOpenModal: () => void }) {
  const masked = apiKey.length > 8 ? `${apiKey.slice(0, 3)}***${apiKey.slice(-4)}` : "***";
  const isDefault = apiKey === DEFAULT_API_KEY;
  return (
    <button className={`status-pill ${isDefault ? "warn" : "good"}`} type="button" onClick={onOpenModal}>
      <Key size={14} />
      <span>API Key: {masked}</span>
    </button>
  );
}

function StashPanel({
  isOpen,
  items,
  onBatchDownload,
  onDelete,
  onToggle
}: {
  isOpen: boolean;
  items: StashItem[];
  onBatchDownload: () => void;
  onDelete: (itemId: string) => void;
  onToggle: () => void;
}) {
  return (
    <section className="stash-panel">
      <button className="stash-header" type="button" onClick={onToggle} aria-expanded={isOpen}>
        <span>
          <ChevronDown className={isOpen ? "stash-chevron open" : "stash-chevron"} size={14} />
          暂存 {items.length}
        </span>
      </button>
      {isOpen ? (
        <div className="stash-body">
          <div className="stash-toolbar">
            <span>暂存 {items.length}</span>
            <button className="stash-download-all" type="button" onClick={onBatchDownload}>
              <Download size={13} />
              批量下载 ZIP
            </button>
          </div>
          {items.map((item) => (
            <article className="stash-item" key={item.id}>
              <strong title={item.sourceNodeName || item.fileName}>{item.sourceNodeName || item.fileName}</strong>
              <StashMiniPlayer src={item.audioDataUrl} />
              <a
                className="stash-round-action"
                href={item.audioDataUrl}
                download={getArtifactDownloadFileName(item.sourceNodeName || item.fileName, item.fileName)}
                title="下载暂存音频"
              >
                <Download size={13} />
              </a>
              <button className="stash-round-action nodrag" type="button" onClick={() => onDelete(item.id)} title="删除暂存">
                <Trash2 size={13} />
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function StashMiniPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }

  return (
    <>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />
      <button className="stash-round-action nodrag" type="button" onClick={togglePlay} title={isPlaying ? "暂停" : "播放"}>
        {isPlaying ? <Pause size={13} /> : <Play size={13} />}
      </button>
    </>
  );
}

function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data
}: EdgeProps<StudioEdge>) {
  const [isHovered, setIsHovered] = useState(false);
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  });

  return (
    <>
      <g onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
        <path className="edge-hover-path" d={edgePath} />
        <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      </g>
      <EdgeLabelRenderer>
        <button
          className={isHovered ? "edge-delete visible" : "edge-delete"}
          onClick={(event) => {
            event.stopPropagation();
            data?.onDeleteEdge?.(id);
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`
          }}
          title="断开链接"
          type="button"
        >
          ×
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

function StudioAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }

  function seek(value: string) {
    const nextTime = Number(value);
    const audio = audioRef.current;
    if (!audio || Number.isNaN(nextTime)) {
      return;
    }

    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  return (
    <div className="studio-player nodrag">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />
      <button className="player-button" type="button" onClick={togglePlay} title={isPlaying ? "暂停" : "播放"}>
        {isPlaying ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <span className="player-time">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
      <input
        aria-label="播放进度"
        className="player-range player-progress"
        max={duration || 0}
        min={0}
        onChange={(event) => seek(event.target.value)}
        style={{ "--progress": `${progress}%` } as React.CSSProperties}
        type="range"
        value={currentTime}
      />
    </div>
  );
}

function resolveCloneInputs(cloneNode: StudioNode, nodes: StudioNode[], edges: StudioEdge[]) {
  const incoming = edges.filter((edge) => edge.target === cloneNode.id);
  const getSource = (targetHandle: string) => {
    const edge = incoming.find((item) => item.targetHandle === targetHandle);
    return edge ? nodes.find((node) => node.id === edge.source) : undefined;
  };

  const voiceNode = getSource("voice");
  const instructionNode = getSource("instruction");
  const textNode = getSource("text");
  const artifact = voiceNode?.data.artifact;
  const artifactAudio: AudioAsset | undefined = artifact
    ? {
        fileName: artifact.fileName,
        mimeType: guessMimeFromName(artifact.fileName),
        size: dataUrlToUint8Array(artifact.audioDataUrl).byteLength,
        dataUrl: artifact.audioDataUrl
      }
    : undefined;

  return {
    audio: voiceNode?.data.audio ?? artifactAudio ?? cloneNode.data.audio,
    instruction: instructionNode?.data.text ?? cloneNode.data.instruction ?? "",
    text: textNode?.data.text ?? cloneNode.data.text ?? ""
  };
}

function resolveCloneTextInputs(cloneNode: StudioNode, nodes: StudioNode[], edges: StudioEdge[]) {
  return edges
    .filter((edge) => edge.target === cloneNode.id && edge.targetHandle === "text")
    .map((edge) => nodes.find((node) => node.id === edge.source && node.type === "prompt"))
    .filter((node): node is StudioNode => Boolean(node))
    .map((node) => ({
      title: node.data.title,
      text: String(node.data.text || "")
    }));
}

function resolveVoiceDesignInputs(designNode: StudioNode, nodes: StudioNode[], edges: StudioEdge[]) {
  return edges
    .filter((edge) => edge.target === designNode.id && edge.targetHandle === "text")
    .map((edge) => nodes.find((node) => node.id === edge.source && node.type === "prompt"))
    .filter((node): node is StudioNode => Boolean(node))
    .map((node) => ({
      title: node.data.title,
      text: String(node.data.text || "")
    }));
}

function createArtifactNode(sourceNode: StudioNode, result: DebugResponse, title?: string): StudioNode {
  const artifactTitle = title?.trim() ? `${title.trim()} 产物` : `产物 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;

  return {
    id: createId("artifact"),
    type: "artifact",
    position: {
      x: sourceNode.position.x + 420,
      y: sourceNode.position.y + 36
    },
    data: {
      title: artifactTitle,
      artifact: {
        fileName: result.fileName,
        audioDataUrl: result.audioDataUrl,
        elapsedMs: result.elapsedMs,
        createdAt: new Date().toISOString(),
        sourceNodeName: artifactTitle
      }
    }
  };
}

function stripNodeCallbacks(node: StudioNode): StudioNode {
  const { onPatch, onDelete, onRunClone, onRunVoiceDesign, onOptimizeStyle, onOptimizeVoiceDesign, onStashArtifact, isArtifactStashed, ...data } = node.data;
  return { ...node, data };
}

function dataUrlToFile(dataUrl: string, fileName: string, mimeType: string): File {
  const [meta, base64] = dataUrl.split(",");
  const resolvedMime = mimeType || meta.match(/data:(.*);base64/)?.[1] || "audio/mpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: resolvedMime });
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getSupportedRecordingMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

async function convertRecordedBlobToWav(blob: Blob): Promise<Blob> {
  const AudioContextConstructor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("当前浏览器无法处理录音，请改用上传音频文件。");
  }

  const audioContext = new AudioContextConstructor();
  try {
    const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    return encodeAudioBufferToWav(audioBuffer);
  } finally {
    await audioContext.close();
  }
}

function encodeAudioBufferToWav(audioBuffer: AudioBuffer): Blob {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frameCount = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const channels = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index));

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取录音失败。"));
    reader.readAsDataURL(blob);
  });
}

function splitScriptInput(script: string): string[] {
  return script
    .split(/\n?\s*----\s*\n?/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function guessMimeFromName(fileName: string): string {
  if (/\.wav$/i.test(fileName)) {
    return "audio/wav";
  }
  if (/\.(m4a|mp4)$/i.test(fileName)) {
    return "audio/m4a";
  }
  return "audio/mp3";
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "audio.wav";
}

function getArtifactDownloadFileName(title: string, originalFileName: string): string {
  const safeTitle = sanitizeFileName(title).replace(/\.[a-z0-9]{1,8}$/i, "") || "audio";
  return `${safeTitle}${getFileExtension(originalFileName)}`;
}

function getFileExtension(fileName: string): string {
  const match = sanitizeFileName(fileName).match(/(\.[a-z0-9]{1,8})$/i);
  return match?.[1] ?? ".wav";
}

function getUniqueFileName(fileName: string, usedNames: Map<string, number>): string {
  const count = usedNames.get(fileName) ?? 0;
  usedNames.set(fileName, count + 1);
  if (count === 0) {
    return fileName;
  }

  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) {
    return `${fileName}-${count + 1}`;
  }

  return `${fileName.slice(0, dotIndex)}-${count + 1}${fileName.slice(dotIndex)}`;
}

function formatDateForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0:00";
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
