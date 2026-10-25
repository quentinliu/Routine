import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { Orchestrator } from './agent/orchestrator';
import { getSafetyGate } from './agent/safety';
import { ToolRegistry } from './agent/tools/registry';
import { createBrowserTools } from './agent/tools/builtin/browser';
import { createComputerTools } from './agent/tools/builtin/computer';
import { createDbTools } from './agent/tools/builtin/db';
import { createFileTools } from './agent/tools/builtin/file';
import { createMemoryTools } from './agent/tools/builtin/memory';
import { createSkillTools } from './agent/tools/builtin/skill';
import { createSshTools } from './agent/tools/builtin/ssh';
import { createTodoTools } from './agent/tools/builtin/todo';
import { createWebTools } from './agent/tools/builtin/web';
import { getRouter } from './llm/router';
import { getBrowserAgentService } from './services/browser';
import { getComputerService } from './services/computer';
import { getFileAgentService } from './services/fileAgent';
import { getSshService } from './services/ssh/service';
import { getStorage } from './services/storage';
import { getWebSearchService } from './services/webSearch';
import { SkillRegistry } from './skills/registry';

/**
 * 组合根：工具注册表 / 技能注册表 / 编排器的唯一装配点。
 * ipc.ts 只做路由，从这里取得已装配的实例。
 */
let orchestrator: Orchestrator | null = null;
let toolRegistry: ToolRegistry | null = null;
let skillRegistry: SkillRegistry | null = null;

export function getRegistry(): ToolRegistry {
  if (!toolRegistry) {
    const registry = new ToolRegistry(getSafetyGate());
    registry.register(...createFileTools(getFileAgentService()));
    registry.register(...createComputerTools(getComputerService()));
    registry.register(...createWebTools(getWebSearchService()));
    registry.register(...createBrowserTools(getBrowserAgentService()));
    registry.register(...createSshTools(getSshService()));
    registry.register(...createTodoTools());
    registry.register(...createDbTools());
    registry.register(...createSkillTools(getSkillRegistry()));
    registry.register(...createMemoryTools());
    toolRegistry = registry;
  }
  return toolRegistry;
}

export function getSkillRegistry(): SkillRegistry {
  if (!skillRegistry) {
    const userRoot = path.join(app.getPath('userData'), 'skills');
    skillRegistry = new SkillRegistry(builtinSkillsRoot(), userRoot, () => {
      const overrides = getStorage().loadSettings().skillOverrides;
      return overrides ?? {};
    });
  }
  return skillRegistry;
}

/** 内置技能根：打包后位于进程资源目录，开发态回退到项目 resources/skills */
function builtinSkillsRoot(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'skills'),
    path.join(app.getAppPath(), 'resources', 'skills')
  ].filter((p) => p && p !== 'skills');
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      // 无效路径直接尝试下一个候选
    }
  }
  return path.join(app.getAppPath(), 'resources', 'skills');
}

export function getOrchestrator(): Orchestrator {
  if (!orchestrator) {
    orchestrator = new Orchestrator({
      router: getRouter(),
      safety: getSafetyGate(),
      registry: getRegistry(),
      skills: getSkillRegistry()
    });
  }
  return orchestrator;
}
