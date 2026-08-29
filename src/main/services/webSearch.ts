import type { WebSearchResult } from '../../shared/types';
import { getStorage } from './storage';

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

async function tavilySearch(
  apiKey: string,
  query: string,
  maxResults: number
): Promise<WebSearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults })
  });
  if (!res.ok) throw new Error(`Tavily 请求失败 HTTP ${res.status}`);
  const data = (await res.json()) as TavilyResponse;
  return (data.results ?? [])
    .map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }))
    .filter((r) => r.url);
}

async function duckduckgoSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`DuckDuckGo 请求失败 HTTP ${res.status}`);
  const html = await res.text();

  const results: WebSearchResult[] = [];
  const linkRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) snippets.push(stripTags(m[1]));

  for (const m of html.matchAll(linkRe)) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) continue;
    results.push({
      title: stripTags(m[2]),
      url,
      snippet: snippets[results.length] ?? ''
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

export class WebSearchServiceImpl implements WebSearchService {
  async search(query: string, maxResults = 6): Promise<WebSearchResult[]> {
    const { search } = getStorage().loadSettings();
    if (search.provider === 'tavily' && search.tavilyApiKey) {
      return tavilySearch(search.tavilyApiKey, query, maxResults);
    }
    let results: WebSearchResult[];
    try {
      results = await duckduckgoSearch(query, maxResults);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `联网搜索失败（${reason.includes('fetch failed') ? '网络不可达或被拦截' : reason}），可在设置中配置 Tavily API Key`
      );
    }
    if (results.length === 0) {
      throw new Error('联网搜索无结果（可能被限流），可在设置中配置 Tavily API Key');
    }
    return results;
  }
}

let webSearch: WebSearchService | null = null;

export function getWebSearchService(): WebSearchService {
  if (!webSearch) webSearch = new WebSearchServiceImpl();
  return webSearch;
}
