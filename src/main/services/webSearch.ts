import type { WebSearchResult } from '../../shared/types';
import { getStorage } from './storage';

const BING_ENDPOINT = 'cn.bing.com';
const TAVILY_ENDPOINT = 'api.tavily.com';
const REQUEST_TIMEOUT_MS = 8_000;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface WebSearchService {
  search(query: string, maxResults?: number): Promise<WebSearchResult[]>;
}

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('fetch failed') ? '连接失败（网络不可达或被拦截）' : msg;
}

async function tavilySearch(
  apiKey: string,
  query: string,
  maxResults: number
): Promise<WebSearchResult[]> {
  const res = await fetch(`https://${TAVILY_ENDPOINT}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 4_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as TavilyResponse;
  return (data.results ?? [])
    .map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }))
    .filter((r) => r.url);
}

/** 抓取必应结果页：<li class="b_algo"> 内 h2>a 为标题链接、p 为摘要 */
export async function bingSearch(
  query: string,
  maxResults: number
): Promise<WebSearchResult[]> {
  const url = `https://${BING_ENDPOINT}/search?q=${encodeURIComponent(query)}&count=${Math.max(
    maxResults,
    10
  )}&mkt=zh-CN`;
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const blocks = html.split('class="b_algo"').slice(1);
  for (const block of blocks) {
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const link = linkMatch[1];
    const title = stripTags(linkMatch[2]);
    if (!/^https?:\/\//i.test(link) || !title || seen.has(link)) continue;
    seen.add(link);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({
      title,
      url: link,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : ''
    });
    if (results.length >= maxResults) break;
  }
  if (results.length === 0) throw new Error('结果页解析为空（可能触发风控页）');
  return results;
}

type Engine = 'tavily' | 'bing';

const ENGINE_LABEL: Record<Engine, string> = {
  tavily: `Tavily (${TAVILY_ENDPOINT})`,
  bing: `必应 (${BING_ENDPOINT})`
};

type EngineFn = (query: string, maxResults: number) => Promise<WebSearchResult[]>;

function engineByName(name: Engine, apiKey: string): EngineFn {
  if (name === 'tavily') return (query, maxResults) => tavilySearch(apiKey, query, maxResults);
  return bingSearch;
}

/** 进程内记忆上次成功的引擎，auto 链优先复用，避免每次都重试已知失败源 */
let lastGoodEngine: Engine | null = null;

/** 测试隔离用：清空引擎记忆 */
export function resetEngineMemory(): void {
  lastGoodEngine = null;
}

function autoChain(hasTavilyKey: boolean): Engine[] {
  const chain: Engine[] = [];
  if (lastGoodEngine) chain.push(lastGoodEngine);
  if (hasTavilyKey) chain.push('tavily');
  chain.push('bing');
  return [...new Set(chain)];
}

export class WebSearchServiceImpl implements WebSearchService {
  async search(query: string, maxResults = 6): Promise<WebSearchResult[]> {
    const { search } = getStorage().loadSettings();
    const apiKey = search.tavilyApiKey;

    if (search.provider === 'tavily') {
      if (!apiKey) throw new Error('搜索引擎为 Tavily 但未配置 API Key，请在设置中填写');
      return this.runChain([['tavily', engineByName('tavily', apiKey)]], maxResults)(query);
    }

    const engines: Array<[Engine, EngineFn]> =
      search.provider === 'bing'
        ? [['bing', engineByName('bing', apiKey)]]
        : autoChain(Boolean(apiKey)).map((name) => [name, engineByName(name, apiKey)]);

    return this.runChain(engines, maxResults)(query);
  }

  private runChain(
    engines: Array<[Engine, EngineFn]>,
    maxResults: number
  ): (query: string) => Promise<WebSearchResult[]> {
    return async (query: string) => {
      const failures: string[] = [];
      for (const [name, fn] of engines) {
        try {
          const results = await fn(query, maxResults);
          if (results.length === 0) {
            failures.push(`${ENGINE_LABEL[name]}: 无结果`);
            continue;
          }
          lastGoodEngine = name;
          return results;
        } catch (err) {
          failures.push(`${ENGINE_LABEL[name]}: ${reasonOf(err)}`);
        }
      }
      throw new Error(`联网搜索失败（${failures.join('；')}），可在设置中配置 Tavily API Key`);
    };
  }
}

let webSearch: WebSearchService | null = null;

export function getWebSearchService(): WebSearchService {
  if (!webSearch) webSearch = new WebSearchServiceImpl();
  return webSearch;
}
