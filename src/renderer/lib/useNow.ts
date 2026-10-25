import { useEffect, useState } from 'react';

/**
 * 只在需要时走的秒表：active 为真才起定时器，静置的会话不会每秒重渲染。
 * 返回当前时间戳，由调用方自行计算已耗时。
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  return now;
}
