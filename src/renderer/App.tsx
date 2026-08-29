import { useEffect } from 'react';
import { useAppStore } from './store';
import { Topbar } from './components/Topbar';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { AgentPanel } from './components/AgentPanel';
import { SettingsView } from './components/SettingsView';
import { FileSearchDialog } from './components/FileSearchDialog';
import { TodoDialog } from './components/TodoDialog';
import { SafetyDialog } from './components/SafetyDialog';

export function App() {
  const bootstrap = useAppStore((s) => s.bootstrap);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const fileDialogOpen = useAppStore((s) => s.fileDialogOpen);
  const todoDialogOpen = useAppStore((s) => s.todoDialogOpen);
  const pendingSafety = useAppStore((s) => s.pendingSafety);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const state = useAppStore.getState;
    const unsubs = [
      window.api.onChatDelta((e) =>
        state().receiveDelta(e.sessionId, e.msgId, e.delta, e.done ?? false)
      ),
      window.api.onChatError((e) => state().setChatError(e.error)),
      window.api.onAgentStatus((s) => state().setAgentStatus(s)),
      window.api.onLogEntry((l) => state().pushLog(l)),
      window.api.onSafetyRequest((r) => state().setPendingSafety(r)),
      window.api.onIndexProgress((p) => state().setIndexProgress(p)),
      window.api.onTodoRunsChanged(() => state().refreshSessions())
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  return (
    <div className="app-shell">
      <Topbar />
      <Sidebar />
      <ChatView />
      <AgentPanel />
      {settingsOpen && <SettingsView />}
      {fileDialogOpen && <FileSearchDialog />}
      {todoDialogOpen && <TodoDialog />}
      {pendingSafety && <SafetyDialog request={pendingSafety} />}
    </div>
  );
}
