export const platformContextConfig = {
  x: {
    title: 'config for X',
    defaultOpen: true,
    contexts: {
      post: {
        inputId: 'context-post',
        label: 'New posts',
        hint: 'When composing a new post',
        defaultEnabled: true,
      },
      reply: {
        inputId: 'context-reply',
        label: 'Replies',
        hint: 'When replying to a post',
        defaultEnabled: true,
      },
      quote: {
        inputId: 'context-quote',
        label: 'Quote posts',
        hint: 'When quoting another post',
        defaultEnabled: true,
      },
      chat: {
        inputId: 'context-chat',
        label: 'Chat(DMs)',
        hint: 'When writing a chat message',
        defaultEnabled: true,
      },
    },
  },
} as const;

export type ContextSettings = {
  [Platform in keyof typeof platformContextConfig]: {
    [Context in keyof typeof platformContextConfig[Platform]['contexts']]: boolean;
  };
};
