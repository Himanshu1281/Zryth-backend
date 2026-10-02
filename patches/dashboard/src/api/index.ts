// Drop-in replacements for every direct supabase/Vobiz/Gemini call in the dashboard.
import apiClient from './client';

const d = <T = any>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data);

export const api = {
  calls: {
    list: () => d(apiClient.get('/calls')),                          // useCalls.ts
    get: (id: string) => d(apiClient.get(`/calls/${id}`)),            // CallTranscript.tsx -> {call, messages}
    summarize: (id: string) => d<{ summary: string }>(apiClient.post(`/calls/${id}/summary`)), // AllCalls.tsx
    agentPhoneMap: () => d(apiClient.get('/calls/agent-phone-map')),  // PhoneNumbers.tsx
  },
  metrics: () => d(apiClient.get('/metrics')),
  agent: {
    status: () => d(apiClient.get('/agents/status')),                 // Dashboard + VoiceAgents (poll every 5s)
    config: () => d(apiClient.get('/agents/config')),
    attachPrompt: (prompt_tag: string) => apiClient.post('/agents/prompts', { prompt_tag }),
    detachPrompt: (tag: string) => apiClient.delete(`/agents/prompts/${encodeURIComponent(tag)}`),
    attachTool: (tool_name: string) => apiClient.post('/agents/tools', { tool_name }),
    detachTool: (name: string) => apiClient.delete(`/agents/tools/${encodeURIComponent(name)}`),
  },
  prompts: {
    list: () => d(apiClient.get('/prompts')),
    create: (b: { tag: string; content: string }) => d(apiClient.post('/prompts', b)),
    update: (id: string, b: { tag: string; content: string }) => d(apiClient.put(`/prompts/${id}`, b)),
    remove: (id: string) => apiClient.delete(`/prompts/${id}`),
  },
  tools: {
    list: () => d(apiClient.get('/tools')),
    create: (b: { name: string; json_spec: object; execution_instruction?: string }) => d(apiClient.post('/tools', b)),
    update: (id: string, b: { name: string; json_spec: object; execution_instruction?: string }) => d(apiClient.put(`/tools/${id}`, b)),
    remove: (id: string) => apiClient.delete(`/tools/${id}`),
  },
  knowledge: {
    list: () => d(apiClient.get('/knowledge')),
    upload: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return d(apiClient.post('/knowledge', fd));
    },
    url: (name: string) => d<{ url: string }>(apiClient.get(`/knowledge/${encodeURIComponent(name)}/url`)),
    remove: (name: string) => apiClient.delete(`/knowledge/${encodeURIComponent(name)}`),
  },
  phoneNumbers: {
    list: () => d(apiClient.get('/phone-numbers')),
    inventory: (page = 1, search = '') => d(apiClient.get('/phone-numbers/inventory', { params: { page, search } })),
  },
  account: { deleteMe: () => apiClient.delete('/account/me') },
};
