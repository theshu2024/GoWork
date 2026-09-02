import { create } from 'zustand';
import type { ParsedDocument } from '../../main/preload';
import { DEFAULT_CONFIG, type AIConfig, type AIMessage } from '../services/ai';

export type ChatRole = 'user' | 'ai' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  streaming?: boolean;
  tool?: string; // 用于前端标注：摘要 / 问答 / 改写 / 数据分析
  timestamp: number;
}

interface AppState {
  documents: ParsedDocument[];
  activeDocId: string | null;
  chatMessages: ChatMessage[];
  chatLoading: boolean;
  aiConfig: AIConfig;
  showSettings: boolean;

  addDocuments: (docs: ParsedDocument[]) => void;
  setActiveDoc: (id: string | null) => void;
  removeDoc: (id: string) => void;

  addChatMessage: (msg: ChatMessage) => void;
  updateChatMessage: (id: string, patch: Partial<ChatMessage>) => void;
  clearChat: () => void;
  setChatLoading: (v: boolean) => void;

  updateAIConfig: (cfg: Partial<AIConfig>) => void;
  setShowSettings: (v: boolean) => void;
}

const STORAGE_KEY = 'aioffice_config_v1';

function loadConfig(): AIConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_CONFIG;
}

function saveConfig(cfg: AIConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
}

export const useAppStore = create<AppState>((set, get) => ({
  documents: [],
  activeDocId: null,
  chatMessages: [],
  chatLoading: false,
  aiConfig: loadConfig(),
  showSettings: false,

  addDocuments: (docs) => {
    set((s) => ({
      documents: [...s.documents, ...docs],
      activeDocId: s.activeDocId ?? docs[0]?.id ?? null,
    }));
  },
  setActiveDoc: (id) => set({ activeDocId: id }),
  removeDoc: (id) =>
    set((s) => {
      const docs = s.documents.filter((d) => d.id !== id);
      return {
        documents: docs,
        activeDocId: s.activeDocId === id ? docs[0]?.id ?? null : s.activeDocId,
      };
    }),

  addChatMessage: (msg) =>
    set((s) => ({ chatMessages: [...s.chatMessages, msg] })),
  updateChatMessage: (id, patch) =>
    set((s) => ({
      chatMessages: s.chatMessages.map((m) =>
        m.id === id ? { ...m, ...patch } : m
      ),
    })),
  clearChat: () => set({ chatMessages: [] }),
  setChatLoading: (v) => set({ chatLoading: v }),

  updateAIConfig: (cfg) => {
    const merged = { ...get().aiConfig, ...cfg };
    saveConfig(merged);
    set({ aiConfig: merged });
  },
  setShowSettings: (v) => set({ showSettings: v }),
}));

export function getActiveDoc(): ParsedDocument | null {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocId) || null;
}

export { type AIMessage };
