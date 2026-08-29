import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../../shared/types';

interface Props {
  message: ChatMessage;
  streaming?: boolean;
}

export const MessageBubble = memo(function MessageBubble({ message, streaming }: Props) {
  const isUser = message.role === 'user';
  return (
    <div className={`message-row ${isUser ? 'row-user' : 'row-assistant'}`}>
      <div className={`avatar ${isUser ? 'avatar-user' : 'avatar-ai'}`}>
        {isUser ? (
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <circle cx="12" cy="8.5" r="3.5" fill="currentColor" />
            <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <path
              d="M12 2 21 7v10l-9 5-9-5V7z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="2.6" fill="currentColor" />
          </svg>
        )}
      </div>
      <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-ai'}`}>
        {isUser ? (
          <p className="bubble-plain">{message.content}</p>
        ) : (
          <>
            <div className="bubble-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
            {streaming && <span className="stream-cursor">▍</span>}
          </>
        )}
      </div>
    </div>
  );
});
