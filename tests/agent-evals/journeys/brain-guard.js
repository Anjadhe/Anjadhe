/**
 * The brain is never silently replaced (2026-08-31, observed live: a
 * Studio-hosted server default was swapped for the local qwen3.5 fine-tune
 * by checkEngineStatus's first-run auto-pick — its guards checked the
 * ACTIVE entry and the legacy provider flag, and a per-conversation
 * override on a local model walked past both). Pinned:
 *  - with ANY default entry saved, checkEngineStatus leaves
 *    defaultModelId and selectedModel untouched, whatever the legacy
 *    provider flag says.
 */
module.exports = [
  {
    id: 'brain-guard-no-silent-swap',
    name: 'checkEngineStatus never replaces an existing default brain',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const before = StorageManager.get('agent-settings') || {};
        const saved = JSON.stringify(before);
        try {
          // The observed shape: default = the user's own server, while the
          // legacy provider flag reads 'local' (a migration or a stale
          // write-through) and a local model is installed and auto-pickable.
          const s = JSON.parse(saved);
          s.modelList = Array.isArray(s.modelList) ? s.modelList : [];
          let srv = s.modelList.find(e => e.engine === 'server');
          if (!srv) {
            srv = { id: 'm_evalsrv', engine: 'server', model: 'eval-server-model', baseUrl: 'http://example.invalid:8080/' };
            s.modelList.push(srv);
          }
          s.defaultModelId = srv.id;
          s.selectedModel = srv.model;
          StorageManager.set('agent-settings', s);
          AgentService.model = srv.model;

          // The hole the old guards had: the ACTIVE conversation overrides
          // to a local model, so the active-entry check sees a local brain
          // while the DEFAULT is the server.
          const local = s.modelList.find(e => e.engine === 'llamacpp');
          const prevActive = AgentService.activeConversationId;
          const conv = AgentService.createConversation();   // makes itself active
          AgentService.activeConversationId = conv.id;
          if (local) AgentService.setConversationModel(conv.id, local.model);

          await AgentUI.checkEngineStatus();

          AgentService.activeConversationId = prevActive;
          AgentService.conversations = AgentService.conversations.filter(c => c.id !== conv.id);
          AgentService._saveConversations();

          const after = StorageManager.get('agent-settings') || {};
          const held = after.defaultModelId === srv.id
            && after.selectedModel === srv.model
            && AgentService.model === srv.model;
          return { pass: held, detail: JSON.stringify({
            expected: srv.model,
            defaultModelId: after.defaultModelId,
            selectedModel: after.selectedModel
          }) };
        } finally {
          StorageManager.set('agent-settings', JSON.parse(saved));
          AgentService.model = (JSON.parse(saved).selectedModel) || null;
        }
      });
    }
  }
];
