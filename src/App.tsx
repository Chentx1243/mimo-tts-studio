import "@xyflow/react/dist/style.css";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
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
  Download,
  FileAudio,
  Loader2,
  Mic2,
  Pause,
  PanelTop,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2
} from "lucide-react";
import { ChangeEvent, MouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

type StatusResponse = {
  ok: boolean;
  model: string;
  apiKeyConfigured: boolean;
  maxAudioBytes: number;
  allowedMimeTypes: string[];
};

type WorkspaceSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
};

type WorkspacePayload = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
};

type WorkspacesResponse = {
  activeWorkspaceId: string | null;
  workspaces: WorkspaceSummary[];
};

type StudioNodeType = "referenceAudio" | "prompt" | "voiceClone" | "artifact";
type StudioNode = Node<NodeData, StudioNodeType>;
type StudioEdge = Edge;

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
};

type DebugResponse = {
  audioDataUrl: string;
  fileName: string;
  elapsedMs: number;
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
  prompt: {
    label: "提示词",
    description: "导演文本或音频文本输入",
    defaultData: () => ({ title: "提示词", text: "自然、清晰、略带播客讲述感，语速中等，语气友好但不过分夸张。" })
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
  artifact: {
    label: "产物",
    description: "保存生成结果和下载入口",
    defaultData: () => ({ title: "音频产物" })
  }
};

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
  const flowRef = useRef<ReactFlowInstance<StudioNode, StudioEdge> | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void loadStatus();
    void loadWorkspaceList();
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
    }, 900);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
    // 仅监听画布结构和节点数据变化，避免保存函数引用。
  }, [nodes, edges]);

  const nodeCallbacks = useMemo(
    () => ({
      onPatch: patchNode,
      onDelete: deleteNode,
      onRunClone: runVoiceClone
    }),
    [nodes, edges, status?.apiKeyConfigured]
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

  const nodeTypes = useMemo<NodeTypes>(
    () => ({
      referenceAudio: ReferenceAudioNode,
      prompt: PromptNode,
      voiceClone: VoiceCloneNode,
      artifact: ArtifactNode
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

  async function loadWorkspaceList(preferredId?: string) {
    const response = await fetch("/api/workspaces");
    const payload = (await response.json()) as WorkspacesResponse;
    setWorkspaces(payload.workspaces);
    const targetId = preferredId ?? payload.activeWorkspaceId ?? payload.workspaces[0]?.id;
    if (targetId) {
      await loadWorkspace(targetId);
    }
  }

  async function loadWorkspace(id: string) {
    const response = await fetch(`/api/workspaces/${id}`);
    const workspace = (await response.json()) as WorkspacePayload;
    setActiveWorkspace(workspace);
    setNodes(workspace.nodes ?? []);
    setEdges(workspace.edges ?? []);
  }

  async function createWorkspace() {
    const name = `新工作台 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, nodes: [], edges: [] })
    });
    const workspace = (await response.json()) as WorkspacePayload;
    await loadWorkspaceList(workspace.id);
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
    const cleanNodes = nodes.map(stripNodeCallbacks);
    const response = await fetch(`/api/workspaces/${activeWorkspace.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: activeWorkspace.name,
        nodes: cleanNodes,
        edges
      })
    });
    const saved = (await response.json()) as WorkspacePayload;
    setActiveWorkspace(saved);
    setWorkspaces((items) =>
      items.map((item) =>
        item.id === saved.id
          ? { ...item, name: saved.name, updatedAt: saved.updatedAt, nodeCount: saved.nodes.length, edgeCount: saved.edges.length }
          : item
      )
    );
    setIsSaving(false);
  }

  function patchWorkspaceName(name: string) {
    setActiveWorkspace((workspace) => (workspace ? { ...workspace, name } : workspace));
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

  async function runVoiceClone(nodeId: string) {
    const cloneNode = nodes.find((node) => node.id === nodeId);
    if (!cloneNode || cloneNode.type !== "voiceClone") {
      return;
    }

    if (!status?.apiKeyConfigured) {
      patchNode(nodeId, { error: "API Key 未配置，请先配置 .env 中的 MIMO_API_KEY。" });
      return;
    }

    const resolved = resolveCloneInputs(cloneNode, nodes, edges);
    if (!resolved.audio) {
      patchNode(nodeId, { error: "缺少参考音频，请连接参考音频节点或在节点中上传。" });
      return;
    }

    if (!resolved.text.trim()) {
      patchNode(nodeId, { error: "缺少音频文本，请连接提示词节点到「文本」输入或在节点中填写。" });
      return;
    }

    patchNode(nodeId, { isRunning: true, error: undefined });

    try {
      const formData = new FormData();
      formData.append("voice", dataUrlToFile(resolved.audio.dataUrl, resolved.audio.fileName, resolved.audio.mimeType));
      formData.append("text", resolved.text.trim());
      formData.append("instruction", resolved.instruction.trim());
      formData.append("format", "wav");

      const response = await fetch("/api/tts/voiceclone", {
        method: "POST",
        body: formData
      });
      const payload = (await response.json()) as DebugResponse & { error?: string; details?: unknown };

      if (!response.ok) {
        patchNode(nodeId, { isRunning: false, error: payload.error || "MiMo 生成失败。" });
        return;
      }

      const artifactNode = createArtifactNode(cloneNode, payload);
      const artifactEdge: StudioEdge = {
        id: createId("edge"),
        source: cloneNode.id,
        sourceHandle: "output",
        target: artifactNode.id,
        targetHandle: "artifact",
        animated: true,
        style: { stroke: "#c5a45d", strokeWidth: 2 }
      };

      setNodes((items) => items.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, isRunning: false, error: undefined } } : node)).concat(artifactNode));
      setEdges((items) => items.concat(artifactEdge));
    } catch (error) {
      patchNode(nodeId, { isRunning: false, error: error instanceof Error ? error.message : "请求失败。" });
    }
  }

  return (
    <main className="studio-shell" onClick={() => setMenu(null)}>
      <header className="studio-topbar">
        <div className="brand-block">
          <span className="brand-kicker">ZHUGUANG AUDIO WORKSTATION</span>
          <h1>铸光音频工作站</h1>
        </div>
        <div className="topbar-actions">
          <StatusPill status={status} error={statusError} onRefresh={loadStatus} />
          <button type="button" onClick={() => void saveWorkspace()}>
            <Save size={16} />
            {isSaving ? "保存中" : "保存"}
          </button>
        </div>
      </header>

      {!status?.apiKeyConfigured ? (
        <section className="api-warning">
          <AlertTriangle size={18} />
          <span>未检测到 MIMO_API_KEY。请在本地 .env 中配置后重启服务，音频克隆节点才可运行。</span>
        </section>
      ) : null}

      <section className="studio-layout">
        <aside className="board-sidebar">
          <div className="sidebar-title">
            <PanelTop size={17} />
            <span>画板库</span>
          </div>
          <button className="new-board" type="button" onClick={() => void createWorkspace()}>
            <Plus size={16} />
            新建画板
          </button>
          <div className="board-list">
            {workspaces.map((workspace) => (
              <button
                className={workspace.id === activeWorkspace?.id ? "board-item active" : "board-item"}
                key={workspace.id}
                type="button"
                onClick={() => void loadWorkspace(workspace.id)}
              >
                <strong>{workspace.name}</strong>
                <span>
                  {workspace.nodeCount} 节点 / {workspace.edgeCount} 连线
                </span>
              </button>
            ))}
          </div>
          <button className="danger subtle" type="button" onClick={() => void deleteWorkspace()} disabled={!activeWorkspace}>
            <Trash2 size={16} />
            删除当前画板
          </button>
        </aside>

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
              edges={edges}
              nodeTypes={nodeTypes}
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
      </section>
    </main>
  );
}

function ReferenceAudioNode({ id, data }: NodeProps<StudioNode>) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(data.audio?.dataUrl ?? null);

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

  return (
    <StudioNodeFrame id={id} data={data} icon={<FileAudio size={17} />} tone="audio">
      <Handle type="source" position={Position.Right} id="audio" className="node-handle" />
      <label className="file-picker nodrag">
        <input accept="audio/*,video/mp4,.mp3,.m4a,.mp4,.wav" type="file" onChange={onFileChange} />
        <span>{data.audio ? data.audio.fileName : "上传参考音频"}</span>
        <small>{data.audio ? `${data.audio.mimeType} · ${formatBytes(data.audio.size)}` : "支持改后缀的 M4A/MP4"}</small>
      </label>
      {previewUrl ? <StudioAudioPlayer src={previewUrl} /> : null}
      {data.error ? <p className="node-error">{data.error}</p> : null}
    </StudioNodeFrame>
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
        placeholder="写入可连接到克隆节点的提示词、导演文本或音频文本。"
      />
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
        <span>导演</span>
        <span>文本</span>
      </div>
      <label className="node-field nodrag">
        <span>导演文本</span>
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

function ArtifactNode({ id, data }: NodeProps<StudioNode>) {
  const artifact = data.artifact;

  return (
    <StudioNodeFrame id={id} data={data} icon={<Archive size={17} />} tone="artifact">
      <Handle type="target" position={Position.Left} id="artifact" className="node-handle" />
      {artifact ? (
        <>
          <StudioAudioPlayer src={artifact.audioDataUrl} />
          <div className="artifact-meta">
            <span>{artifact.fileName}</span>
            <span>{artifact.elapsedMs} ms · {new Date(artifact.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
          </div>
          <a className="download-link nodrag" href={artifact.audioDataUrl} download={artifact.fileName}>
            <Download size={15} />
            下载产物
          </a>
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
        <div>
          {icon}
          <input
            className="node-title-input nodrag"
            title="节点命名"
            value={data.title}
            onChange={(event) => data.onPatch?.(id, { title: event.target.value })}
          />
        </div>
        <button className="icon-button nodrag" type="button" onClick={() => data.onDelete?.(id)} title="删除节点">
          <Trash2 size={14} />
        </button>
      </header>
      {children}
    </section>
  );
}

function ContextMenu({ menu, onAdd }: { menu: { x: number; y: number }; onAdd: (type: StudioNodeType) => void }) {
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
      <strong>添加工作节点</strong>
      {(Object.keys(nodeCatalog) as StudioNodeType[]).map((type) => (
        <button key={type} type="button" onClick={() => onAdd(type)}>
          <span>{nodeCatalog[type].label}</span>
          <small>{nodeCatalog[type].description}</small>
        </button>
      ))}
    </div>
  );
}

function StatusPill({ status, error, onRefresh }: { status: StatusResponse | null; error: string | null; onRefresh: () => void }) {
  const text = error ? "代理离线" : status?.apiKeyConfigured ? "API Key 已就绪" : "API Key 未配置";
  const tone = error ? "bad" : status?.apiKeyConfigured ? "good" : "warn";
  return (
    <button className={`status-pill ${tone}`} type="button" onClick={onRefresh}>
      {text}
    </button>
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

  return {
    audio: voiceNode?.data.audio ?? cloneNode.data.audio,
    instruction: instructionNode?.data.text ?? cloneNode.data.instruction ?? "",
    text: textNode?.data.text ?? cloneNode.data.text ?? ""
  };
}

function createArtifactNode(sourceNode: StudioNode, result: DebugResponse): StudioNode {
  return {
    id: createId("artifact"),
    type: "artifact",
    position: {
      x: sourceNode.position.x + 420,
      y: sourceNode.position.y + 36
    },
    data: {
      title: `产物 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
      artifact: {
        fileName: result.fileName,
        audioDataUrl: result.audioDataUrl,
        elapsedMs: result.elapsedMs,
        createdAt: new Date().toISOString(),
        sourceNodeName: sourceNode.data.title
      }
    }
  };
}

function stripNodeCallbacks(node: StudioNode): StudioNode {
  const { onPatch, onDelete, onRunClone, ...data } = node.data;
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

function guessMimeFromName(fileName: string): string {
  if (/\.wav$/i.test(fileName)) {
    return "audio/wav";
  }
  if (/\.(m4a|mp4)$/i.test(fileName)) {
    return "audio/m4a";
  }
  return "audio/mp3";
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
