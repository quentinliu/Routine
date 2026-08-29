import nodeOs from 'node:os';
import type { ComputerExecResult, ComputerOp, SystemSnapshot } from '../../shared/types';
import { run } from '../util/shell';

export interface ComputerService {
  snapshot(): Promise<SystemSnapshot>;
  execWhitelisted(op: string, args: Record<string, unknown>): Promise<ComputerExecResult>;
  listOps(): ComputerOp[];
}

export const COMPUTER_OPS: ComputerOp[] = [
  { op: 'get-info', description: '获取系统信息快照（CPU/内存/磁盘/电池）', risk: 'safe' },
  { op: 'open-app', description: '打开应用程序（args: { name }）', risk: 'safe' },
  { op: 'set-volume', description: '设置系统音量 0-100（args: { volume }）', risk: 'safe' },
  { op: 'toggle-dark-mode', description: '切换深色/浅色模式', risk: 'medium' },
  { op: 'set-brightness', description: '设置屏幕亮度（args: { level: 0-100 }）', risk: 'medium' },
  { op: 'empty-trash', description: '清空废纸篓（不可恢复）', risk: 'high' },
  { op: 'kill-app', description: '强制退出应用（args: { name }）', risk: 'high' },
  { op: 'sleep-display', description: '立即熄灭屏幕', risk: 'safe' },
  { op: 'open-url', description: '用默认浏览器打开 URL（args: { url }）', risk: 'safe' }
];

function appleScriptError(raw: string): boolean {
  return raw.includes('not authorized') || raw.includes('-1743') || raw.includes('not allowed');
}

function automationHint(): string {
  return '缺少自动化权限，请前往 系统设置 → 隐私与安全性 → 自动化，允许 Routine 控制相应应用后重试';
}

async function parseFreeMemoryMb(): Promise<number> {
  const vm = await run('vm_stat', []);
  const ps = await run('sysctl', ['-n', 'hw.pagesize']);
  const pagesize = Number(ps.stdout.trim()) || 4096;
  let freePages = 0;
  for (const line of vm.stdout.split('\n')) {
    const m = line.match(/^(Pages free|Pages inactive).*?(\d+)/);
    if (m) freePages += Number(m[2]);
  }
  return Math.round((freePages * pagesize) / 1048576);
}

export class ComputerServiceImpl implements ComputerService {
  async snapshot(): Promise<SystemSnapshot> {
    const [ver, cpu, ncpu, memsize, free, df, batt] = await Promise.all([
      run('sw_vers', ['-productVersion']),
      run('sysctl', ['-n', 'machdep.cpu.brand_string']),
      run('sysctl', ['-n', 'hw.ncpu']),
      run('sysctl', ['-n', 'hw.memsize']),
      parseFreeMemoryMb(),
      run('df', ['-k', '/']),
      run('pmset', ['-g', 'batt'])
    ]);

    const dfLines = df.stdout.trim().split('\n');
    const dfCols = (dfLines[dfLines.length - 1] ?? '').split(/\s+/);
    const diskTotalGB = Math.round((Number(dfCols[1] ?? 0) / 1048576) * 10) / 10;
    const diskFreeGB = Math.round((Number(dfCols[3] ?? 0) / 1048576) * 10) / 10;

    const battMatch = batt.stdout.match(/(\d+)%;\s*([^\s(]+)/);
    let battery: SystemSnapshot['battery'];
    if (battMatch) {
      battery = {
        percent: Number(battMatch[1]),
        charging: battMatch[2] !== 'discharging' && battMatch[2] !== ''
      };
    }

    return {
      osVersion: `macOS ${ver.stdout.trim()}`,
      cpuModel: cpu.stdout.trim(),
      cpuCores: Number(ncpu.stdout.trim()) || 0,
      memoryTotalMB: Math.round(Number(memsize.stdout.trim()) / 1048576) || 0,
      memoryFreeMB: free,
      diskTotalGB,
      diskFreeGB,
      battery,
      hostname: nodeOs.hostname()
    };
  }

  async execWhitelisted(op: string, args: Record<string, unknown>): Promise<ComputerExecResult> {
    switch (op) {
      case 'get-info': {
        const s = await this.snapshot();
        const details = [
          `系统: ${s.osVersion}（${s.hostname}）`,
          `CPU: ${s.cpuModel} × ${s.cpuCores} 核`,
          `内存: 总共 ${s.memoryTotalMB} MB，可用约 ${s.memoryFreeMB} MB`,
          `磁盘: 总共 ${s.diskTotalGB} GB，可用 ${s.diskFreeGB} GB`,
          s.battery
            ? `电池: ${s.battery.percent}%${s.battery.charging ? '（充电中）' : ''}`
            : '电池: 未检测到'
        ];
        return { summary: '已获取系统信息', details };
      }

      case 'open-app': {
        const name = String(args.name ?? '').trim();
        if (!name || /["\\]/.test(name)) throw new Error('无效的应用名称');
        const r = await run('open', ['-a', name]);
        if (r.code !== 0) throw new Error(`未找到应用「${name}」，请确认名称是否正确`);
        return { summary: `已打开应用「${name}」` };
      }

      case 'set-volume': {
        const volume = Math.max(0, Math.min(100, Math.round(Number(args.volume ?? 50))));
        const r = await run('osascript', ['-e', `set volume output volume ${volume}`]);
        if (r.code !== 0) throw new Error(`设置音量失败: ${r.stderr.trim()}`);
        return { summary: `已将系统音量设置为 ${volume}` };
      }

      case 'toggle-dark-mode': {
        const r = await run('osascript', [
          '-e',
          'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'
        ]);
        if (r.code !== 0) {
          if (appleScriptError(r.stderr)) throw new Error(automationHint());
          throw new Error(`切换外观模式失败: ${r.stderr.trim()}`);
        }
        return { summary: '已切换深色/浅色模式' };
      }

      case 'set-brightness': {
        return {
          summary: '当前系统无法通过命令行直接调节亮度，请在 系统设置 → 显示器 中操作'
        };
      }

      case 'empty-trash': {
        const r = await run('osascript', ['-e', 'tell application "Finder" to empty trash']);
        if (r.code !== 0) {
          if (appleScriptError(r.stderr)) throw new Error(automationHint());
          throw new Error(`清空废纸篓失败: ${r.stderr.trim()}`);
        }
        return { summary: '已清空废纸篓' };
      }

      case 'kill-app': {
        const name = String(args.name ?? '').trim();
        if (!name || /["\\]/.test(name)) throw new Error('无效的应用名称');
        await run('osascript', ['-e', `tell application "${name}" to quit`]);
        await new Promise((r) => setTimeout(r, 2000));
        const check = await run('pgrep', ['-x', name]);
        if (check.code === 0) {
          const kill = await run('killall', [name]);
          if (kill.code !== 0) throw new Error(`无法强制退出「${name}」: ${kill.stderr.trim()}`);
          return { summary: `已强制退出「${name}」` };
        }
        return { summary: `已正常退出「${name}」` };
      }

      case 'sleep-display': {
        const r = await run('pmset', ['displaysleepnow']);
        if (r.code !== 0) throw new Error(`熄屏失败: ${r.stderr.trim()}`);
        return { summary: '已熄灭屏幕' };
      }

      case 'open-url': {
        const url = String(args.url ?? '').trim();
        if (!/^https?:\/\//.test(url)) throw new Error('仅支持 http/https 链接');
        const r = await run('open', [url]);
        if (r.code !== 0) throw new Error(`打开链接失败: ${r.stderr.trim()}`);
        return { summary: `已在默认浏览器打开 ${url}` };
      }

      default:
        throw new Error(`未知操作: ${op}`);
    }
  }

  listOps(): ComputerOp[] {
    return COMPUTER_OPS;
  }
}

let computer: ComputerService | null = null;

export function getComputerService(): ComputerService {
  if (!computer) computer = new ComputerServiceImpl();
  return computer;
}
