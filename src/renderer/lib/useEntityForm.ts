import { useState } from 'react';

/** 表单样板收敛：form/setForm/update（update 在 form 关闭为 null 时静默忽略） */
export function useEntityForm<T extends object>(initial: T | null) {
  const [form, setForm] = useState<T | null>(initial);
  function update(patch: Partial<T>): void {
    setForm((f) => (f === null ? f : { ...f, ...patch }));
  }
  return { form, setForm, update };
}
