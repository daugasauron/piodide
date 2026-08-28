export interface ThinkingOverlayRoot {
  hidden: boolean | string;
}

export interface ThinkingOverlayContent {
  textContent: string | null;
  scrollTop: number;
  readonly scrollHeight: number;
}

/** A transient reasoning surface that never writes into terminal history. */
export class ThinkingOverlay {
  private value = "";
  private readonly root: ThinkingOverlayRoot;
  private readonly content: ThinkingOverlayContent;
  private readonly maxCharacters: number;

  constructor(
    root: ThinkingOverlayRoot,
    content: ThinkingOverlayContent,
    maxCharacters = 20_000,
  ) {
    this.root = root;
    this.content = content;
    this.maxCharacters = maxCharacters;
  }

  append(delta: string): void {
    if (!delta) return;
    this.value = (this.value + delta).slice(-this.maxCharacters);
    this.content.textContent = this.value;
    this.root.hidden = false;
    this.content.scrollTop = this.content.scrollHeight;
  }

  clear(): void {
    this.value = "";
    this.content.textContent = "";
    this.root.hidden = true;
    this.content.scrollTop = 0;
  }
}
