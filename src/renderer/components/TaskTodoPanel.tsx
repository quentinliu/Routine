import { useAppStore, EMPTY_TODOS } from '../store';

const STATUS_MARK: Record<string, string> = {
  completed: '✓',
  in_progress: '▶',
  pending: '○'
};

export function TaskTodoPanel() {
  const todos = useAppStore((s) => s.todosBySession[s.currentSessionId] ?? EMPTY_TODOS);
  const done = todos.filter((t) => t.status === 'completed').length;

  return (
    <div className="todo-panel">
      <h3 className="panel-title">
        {todos.length > 0 ? `任务进度 ${done}/${todos.length}` : '任务进度'}
      </h3>
      {todos.length === 0 ? (
        <p className="todo-empty">发送任务后，复杂任务的子任务进度会显示在这里</p>
      ) : (
        <ul className="todo-list">
          {todos.map((t, i) => (
            <li key={i} className={`todo-item todo-${t.status}`}>
              <span className="todo-mark">{STATUS_MARK[t.status]}</span>
              <span className="todo-content">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
