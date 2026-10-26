import { useEffect, useState } from 'react';
import { useAppStore } from './store';
import { Topbar } from './components/Topbar';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { AgentPanel } from './components/AgentPanel';
import { SettingsView } from './components/SettingsView';
import { FileSearchDialog } from './components/FileSearchDialog';
import { TodoDialog } from './components/TodoDialog';
import { DatabaseWorkbench } from './components/DatabaseWorkbench';
import { SafetyDialog } from './components/SafetyDialog';
import { NoticeDialogs } from './components/NoticeDialogs';
import { OnboardingWizard, onboardingDismissed } from './components/OnboardingWizard';

export function App() {
  const bootstrap = useAppStore((s) => s.bootstrap);
  const settings = useAppStore((s) => s.settings);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const fileDialogOpen = useAppStore((s) => s.fileDialogOpen);
  const todoDialogOpen = useAppStore((s) => s.todoDialogOpen);
  const dbWorkbenchOpen = useAppStore((s) => s.dbWorkbenchOpen);
  const pendingSafety = useAppStore((s) => s.pendingSafety);
  const [booted, setBooted] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(() => !onboardingDismissed());

  useEffect(() => {
    void bootstrap().finally(() => setBooted(true));
  }, [bootstrap]);

  useEffect(() => {
    const state = useAppStore.getState;
    const unsubs = [
      window.api.onChatDelta((e) =>
        state().receiveDelta(e.sessionId, e.msgId, e.delta, e.done ?? false)
      ),
      window.api.onChatError((e) => state().setChatError(e.error, e.sessionId)),
      window.api.onAgentStatus((s) => state().setAgentStatus(s)),
      window.api.onAgentTrace((e) => state().pushTrace(e)),
      window.api.onTodoUpdate((e) => state().pushTodoUpdate(e)),
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
      {dbWorkbenchOpen && <DatabaseWorkbench />}
      {pendingSafety && <SafetyDialog request={pendingSafety} />}
      {booted &&
        wizardOpen &&
        settings.providerMode === 'cloud' &&
        settings.cloudProfiles.every((p) => !p.apiKey.trim()) && (
          <OnboardingWizard onDone={() => setWizardOpen(false)} />
        )}
      <NoticeDialogs />
    </div>
  );
}
