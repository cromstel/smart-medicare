import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useReducedMotion } from 'motion/react';
import { ExternalLink, Mail, Send, ThumbsDown, ThumbsUp, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, type SamConfig } from '@/services/api';
import { resolveApiAssetUrl } from '@/config/api';
import { APP_NAME } from '@/config/app';
import { cn } from '@/lib/utils';

/**
 * SAM — the platform's support assistant.
 *
 * The conversation lives in component state and nowhere else. It is not
 * written to localStorage and not written to sessionStorage: a support
 * conversation can carry a patient's name, a record number or a complaint
 * about a specific account, and browser storage is a plaintext copy of it
 * that outlives the tab and is readable by any script on the origin.
 *
 * The panel is deliberately not a modal. It is a non-modal dialog
 * (`aria-modal="false"`): the visitor keeps the page behind it, and the
 * shortcut that opened it can close it again.
 */

/** The assistant's name, as it appears in the conversation. */
const SAM_NAME = 'SAM';

/** The mark shown when no profile image has been uploaded. */
const DEFAULT_AVATAR = '/sam-avatar-default.svg';

/**
 * The greeting the conversation opens with.
 *
 * It is a local message: it is never sent to the server, so the assistant
 * does not answer a question nobody asked.
 *
 * The product's name comes from the configuration rather than from a literal
 * written here, so a deployment that is called something else is not greeted
 * by the wrong name.
 */
const GREETING_TEXT = `Hi there! 👋 I'm **SAM**, your ${APP_NAME} support assistant. I can help you with information about the platform, how to use features, troubleshooting, and more. How can I assist you today?`;

/** The questions offered under the greeting. */
const SUGGESTED_ACTIONS = [
  'How do I reset my password?',
  'What can my role do?',
  'How do I upload a document?',
  'How do I request a new role?',
];

/** How the providers are named in the header. */
const PROVIDER_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  groq: 'Groq',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/**
 * Why an answer was handed to a person, in the words the visitor reads.
 *
 * The server names the reason with a code; a code is not an explanation. An
 * unrecognised code falls back to the general wording rather than being
 * shown raw, so a reason the server adds later cannot surface as jargon.
 */
const ESCALATION_EXPLANATIONS: Record<string, string> = {
  user_request: 'You asked for a person, so a support agent will follow up.',
  user_dissatisfaction: 'This answer did not help, so a support agent will follow up.',
  sensitive_account_action:
    'This involves your account, so a support agent will follow up.',
  out_of_scope: 'This is beyond what I can answer, so a support agent will follow up.',
};

const escalationExplanation = (reason?: string): string => {
  if (!reason) return 'This one is better handled by a person. A support agent will follow up.';
  return ESCALATION_EXPLANATIONS[reason] ?? ESCALATION_EXPLANATIONS.out_of_scope;
};

/**
 * The support address, when it is one.
 *
 * The server refuses an address that is not an email address, and this check
 * is the same rule applied again at the point of use: a value that was stored
 * before that rule existed must not become a link that runs script.
 */
const safeSupportEmail = (email: string | null | undefined): string | null => {
  const value = (email ?? '').trim();
  if (value === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
};

/**
 * The support portal address, when it is one.
 *
 * Only http and https are followed. A scheme that is not one of those would
 * run script in the page rather than open a page, so the link is not rendered
 * at all.
 */
const safeSupportUrl = (url: string | null | undefined): string | null => {
  const value = (url ?? '').trim();
  if (value === '') return null;
  try {
    const { protocol } = new URL(value);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return value;
  } catch {
    return null;
  }
};

/** A turn in the conversation. */
interface ChatMessage {
  id: string;
  role: 'user' | 'sam';
  text: string;
  /** The server's identifier, used when the answer is rated. */
  serverId?: string;
  /** True when SAM asked for a human to follow up. */
  escalate?: boolean;
  /** Why the answer was handed to a person, when the server reports it. */
  escalateReason?: string;
  /** The rating the visitor gave, once they have given one. */
  helpful?: boolean;
  /** True once the visitor chose to keep talking to SAM instead. */
  escalationDismissed?: boolean;
}

let messageCounter = 0;

/** A message identifier that is unique within the session. */
function nextMessageId(): string {
  messageCounter += 1;
  return `sam-msg-${messageCounter}`;
}

/**
 * SAM's text, rendered as plain text.
 *
 * SAM writes markdown, and there is no markdown renderer in this project —
 * adding one is not an option for a support widget. The emphasis markers are
 * therefore removed and the sentence is rendered as one plain text node: the
 * reader sees the words the assistant wrote, and a screen reader reads them
 * as one utterance rather than as a run of fragments. Line breaks survive
 * because the message body is rendered with `whitespace-pre-wrap`.
 */
function toPlainText(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

/**
 * The address of a profile image the server handed back.
 *
 * An uploaded mark is served by the API, which may be on another origin than
 * the page, so its path is resolved against the API origin. The default mark
 * is an asset of the front end itself, so it is left relative to the page.
 */
function resolveImageUrl(url: string | null | undefined): string {
  if (!url) return DEFAULT_AVATAR;
  return resolveApiAssetUrl(url) || DEFAULT_AVATAR;
}

export function SAMChatWidget() {
  const reduceMotion = useReducedMotion();
  const location = useLocation();

  const [config, setConfig] = useState<SamConfig | null>(null);
  // Null until the configuration has been read: the button is not rendered
  // until then, so it cannot appear and then vanish as the answer arrives.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(DEFAULT_AVATAR);
  const [errorText, setErrorText] = useState<string | null>(null);

  const fabRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  /* ── Configuration ──────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const loaded = await api.getSAMConfig();
        if (cancelled) return;
        setConfig(loaded);
        setEnabled(loaded.enabled !== false);
      } catch (err) {
        if (cancelled) return;
        // A visitor the server refuses is not offered the assistant. Any
        // other failure leaves the widget in place, because a transient
        // fault is not a statement about whether the assistant exists.
        const status = (err as { status?: number } | null)?.status;
        setEnabled(status === 401 || status === 403 ? false : true);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (enabled !== true) return;
    let cancelled = false;

    const loadAvatar = async () => {
      try {
        const result = await api.getSAMProfileImage();
        if (cancelled) return;
        setAvatarUrl(resolveImageUrl(result?.url));
      } catch {
        if (cancelled) return;
        setAvatarUrl(DEFAULT_AVATAR);
      }
    };

    loadAvatar();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  /* ── Open / close ───────────────────────────────────────────────────── */

  const openPanel = useCallback(() => {
    setIsOpen(true);
    setHasUnread(false);
    // The input takes focus so the conversation can be started without a
    // pointer; the panel is not a modal, so this is a convenience rather
    // than a trap.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const closePanel = useCallback(() => {
    setIsOpen(false);
    // Focus goes back where it came from, so a keyboard user is not dropped
    // at the top of the document.
    fabRef.current?.focus();
  }, []);

  const togglePanel = useCallback(() => {
    if (isOpenRef.current) {
      closePanel();
    } else {
      openPanel();
    }
  }, [closePanel, openPanel]);

  /* ── The Ctrl/Cmd+K shortcut, and Escape ────────────────────────────── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpenRef.current) {
        event.preventDefault();
        closePanel();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key?.toLowerCase() !== 'k') return;

      const target = event.target as HTMLElement | null;
      // The shortcut is for the page, not for a field the visitor is typing
      // in — Ctrl+K inside a text box must not steal the keystroke. SAM's own
      // input is the exception: it is the panel's field, and the shortcut has
      // to be able to close the panel it opened.
      if (target && target !== inputRef.current) {
        const tag = target.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;
      }

      event.preventDefault();
      togglePanel();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closePanel, togglePanel]);

  /* ── Conversation ───────────────────────────────────────────────────── */

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;

      const userMessage: ChatMessage = { id: nextMessageId(), role: 'user', text: trimmed };
      setErrorText(null);

      // The conversation so far. The greeting is not in this list: it is a
      // local message, so the assistant is never told it said hello.
      const history = [...messages, userMessage].map((message) => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.text,
      }));

      setMessages((current) => [...current, userMessage]);
      setDraft('');
      setIsSending(true);

      try {
        const response = await api.sendSAMMessage(history, location.pathname);
        const reply: ChatMessage = {
          id: nextMessageId(),
          role: 'sam',
          text: response.text,
          serverId: response.messageId,
          escalate: response.escalate === true,
          escalateReason: response.escalateReason,
        };
        setMessages((current) => [...current, reply]);
        // A reply that lands while the panel is closed is an unread one.
        if (!isOpenRef.current) setHasUnread(true);
      } catch (err) {
        const message =
          err instanceof Error && err.message ? err.message : 'SAM could not be reached just now.';
        setErrorText(message);
      } finally {
        setIsSending(false);
      }
    },
    [isSending, location.pathname, messages]
  );

  const sendFeedback = useCallback(async (message: ChatMessage, helpful: boolean) => {
    setMessages((current) =>
      current.map((item) => (item.id === message.id ? { ...item, helpful } : item))
    );
    try {
      await api.sendSAMFeedback(message.serverId ?? message.id, helpful);
    } catch {
      // A rating is a courtesy. If it cannot be recorded, the visitor is not
      // interrupted with an error about it.
    }
  }, []);

  /* ── Scrolling and derived values ───────────────────────────────────── */

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages, isSending]);

  const modelLabel = useMemo(() => {
    if (!config) return '';
    const provider = PROVIDER_LABELS[config.provider?.toLowerCase()] ?? config.provider;
    if (config.model && provider) return `${config.model} · ${provider}`;
    return config.model || provider || '';
  }, [config]);

  // Nothing is rendered until the configuration has been read: a button that
  // appears and then disappears is worse than a button that arrives a moment
  // later.
  if (enabled !== true) return null;

  return (
    <>
      {/* The chat panel. A non-modal dialog: the page behind it stays live. */}
      <div
        id="sam-chat-panel"
        role="dialog"
        aria-label="SAM support chat"
        aria-modal="false"
        className={cn(
          'fixed z-50 flex-col overflow-hidden border border-border bg-card shadow-lg',
          'inset-x-0 bottom-0 h-[85vh] rounded-t-2xl',
          'sm:inset-x-auto sm:right-5 sm:bottom-36 sm:h-[32rem] sm:w-[24rem] sm:rounded-2xl'
        )}
        // The panel stays in the document so the button's `aria-controls`
        // always points at a real element; it is taken out of the layout and
        // out of the accessibility tree while it is closed.
        style={{
          display: isOpen ? 'flex' : 'none',
          ...(reduceMotion ? {} : { transition: 'opacity 150ms ease-out' }),
        }}
      >
        <header className="flex items-center gap-3 border-b border-border bg-background px-4 py-3">
          <img
            src={avatarUrl}
            alt=""
            aria-hidden="true"
            className="h-9 w-9 shrink-0 rounded-full border border-border object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">{SAM_NAME}</p>
            <p className="truncate text-xs text-muted-foreground" title={modelLabel || undefined}>
              {modelLabel || 'Support assistant'}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={closePanel}
            aria-label="Close SAM support chat"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </header>

        <div
          ref={messageListRef}
          aria-live="polite"
          aria-label="Conversation with SAM"
          className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
        >
          {/* The greeting. A local message: it is never sent to the server. */}
          <div className="flex items-start gap-2">
            <img
              src={avatarUrl}
              alt=""
              aria-hidden="true"
              className="mt-1 h-7 w-7 shrink-0 rounded-full border border-border object-cover"
            />
            <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border bg-background px-3 py-2 text-sm text-foreground">
              <p className="whitespace-pre-wrap break-words">{toPlainText(GREETING_TEXT)}</p>
            </div>
          </div>

          {messages.length === 0 && (
            <ul className="flex flex-wrap gap-2 pl-9" aria-label="Suggested questions">
              {SUGGESTED_ACTIONS.map((action) => (
                <li key={action}>
                  <button
                    type="button"
                    onClick={() => void sendMessage(action)}
                    className={cn(
                      'rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground',
                      'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      'motion-reduce:transition-none'
                    )}
                  >
                    {action}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {messages.map((message) => (
            <div key={message.id} className="flex flex-col gap-1">
              <div
                className={cn(
                  'flex items-start gap-2',
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                )}
              >
                {message.role === 'sam' && (
                  <img
                    src={avatarUrl}
                    alt=""
                    aria-hidden="true"
                    className="mt-1 h-7 w-7 shrink-0 rounded-full border border-border object-cover"
                  />
                )}
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3 py-2 text-sm',
                    message.role === 'user'
                      ? 'rounded-tr-sm bg-accent text-accent-foreground'
                      : 'rounded-tl-sm border border-border bg-background text-foreground'
                  )}
                >
                  <p className="whitespace-pre-wrap break-words">{toPlainText(message.text)}</p>
                </div>
              </div>

              {message.role === 'sam' && (
                <div className="flex items-center gap-1 pl-9">
                  {message.helpful === undefined ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void sendFeedback(message, true)}
                        aria-label="Mark this answer as helpful"
                        className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void sendFeedback(message, false)}
                        aria-label="Mark this answer as not helpful"
                        className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">Thanks for the feedback</span>
                  )}
                </div>
              )}

              {message.escalate && !message.escalationDismissed && (
                <div
                  className="ml-9 rounded-lg border border-warning/40 bg-warning/10 p-3"
                  role="note"
                >
                  <p className="text-sm text-foreground">
                    {escalationExplanation(message.escalateReason)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {safeSupportEmail(config?.humanSupportEmail) && (
                      <Button asChild variant="outline" size="sm">
                        <a href={`mailto:${safeSupportEmail(config?.humanSupportEmail)}`}>
                          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                          Email support
                        </a>
                      </Button>
                    )}
                    {safeSupportUrl(config?.humanSupportUrl) && (
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={safeSupportUrl(config?.humanSupportUrl) ?? undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          Open support portal
                        </a>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setMessages((current) =>
                          current.map((item) =>
                            item.id === message.id ? { ...item, escalationDismissed: true } : item
                          )
                        )
                      }
                    >
                      Continue with SAM
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {isSending && (
            <div className="flex items-center gap-2" role="status">
              <img
                src={avatarUrl}
                alt=""
                aria-hidden="true"
                className="h-7 w-7 shrink-0 rounded-full border border-border object-cover"
              />
              <span className="rounded-2xl rounded-tl-sm border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
                SAM is typing…
              </span>
            </div>
          )}

          {errorText && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {errorText}
            </p>
          )}
        </div>

        <form
          className="border-t border-border bg-background p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage(draft);
          }}
        >
          <div className="flex items-end gap-2">
            <label htmlFor="sam-chat-input" className="sr-only">
              Message SAM
            </label>
            <Textarea
              id="sam-chat-input"
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage(draft);
                }
              }}
              placeholder="Ask SAM about the platform…"
              rows={1}
              className="max-h-32 min-h-[2.5rem] resize-none bg-background"
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send message"
              disabled={isSending || draft.trim() === ''}
            >
              <Send className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </form>
      </div>

      {/* The floating button that opens the panel. It wears the assistant's
          mark, so the picture an operator uploaded is the picture a visitor
          sees before they have opened anything. */}
      <button
        ref={fabRef}
        type="button"
        onClick={togglePanel}
        aria-label="Open SAM support chat"
        aria-expanded={isOpen}
        aria-controls="sam-chat-panel"
        aria-haspopup="dialog"
        className={cn(
          'fixed bottom-20 right-5 z-40 flex h-12 w-12 items-center justify-center overflow-hidden rounded-full',
          'border border-border bg-accent text-accent-foreground shadow-lg',
          'hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'motion-reduce:transition-none'
        )}
      >
        <img
          src={avatarUrl}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover"
        />
        {hasUnread && !isOpen && (
          <span
            className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border border-background bg-destructive"
            aria-hidden="true"
          />
        )}
      </button>
    </>
  );
}

export default SAMChatWidget;
