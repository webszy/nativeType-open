export interface PlatformEditorListener {
  onEdit(): void;
  onDetach(): void;
}

export interface PreviewLayout {
  container: HTMLElement;
  heightTarget?: HTMLElement;
  placement?: 'above';
}

export type WritingContext = 'post' | 'reply' | 'quote' | 'chat' | 'unknown';

export interface PlatformAdapter {
  readonly id: string;
  readonly replacementErrorMessage: string;
  matches(location: Location): boolean;
  findEditor(target: EventTarget | null): HTMLElement | null;
  writingContext(editor: HTMLElement): WritingContext;
  // Some SPAs reuse one input node for drafts belonging to different conversations.
  draftKey?(editor: HTMLElement): string | undefined;
  getText(editor: HTMLElement): string;
  replaceText(editor: HTMLElement, source: string, translation: string, canReplace?: () => boolean): Promise<boolean>;
  observe(editor: HTMLElement, listener: PlatformEditorListener): () => void;
  previewLayout(editor: HTMLElement): PreviewLayout;
}
