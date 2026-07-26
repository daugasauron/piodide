import {
  createMarkdownStreamer,
  createRenderer,
  type ThemeName,
} from "markdansi";

import type { TermWriter } from "./termui.ts";

export type AssistantChannel = "text" | "thinking";
type MarkdownStreamer = ReturnType<typeof createMarkdownStreamer>;

/**
 * Owns the small amount of lifecycle glue between pi's content events and
 * markdansi's append-only streaming renderer. Markdown parsing and terminal
 * layout remain entirely inside markdansi.
 */
export class AssistantMarkdown {
  private channel: AssistantChannel | null = null;
  private stream: MarkdownStreamer | null = null;
  private readonly writer: TermWriter;

  constructor(writer: TermWriter) {
    this.writer = writer;
  }

  push(channel: AssistantChannel, delta: string) {
    if (channel !== this.channel) {
      this.finish();
      this.channel = channel;
      this.stream = this.createStream(
        channel === "thinking" ? "dim" : "bright",
        channel === "thinking",
      );
    }
    const output = this.stream?.push(delta) ?? "";
    if (output) this.writer.write(output);
  }

  finish() {
    const output = this.stream?.finish() ?? "";
    if (output) this.writer.write(output);
    this.stream = null;
    this.channel = null;
  }

  reset() {
    this.stream?.reset();
    this.stream = null;
    this.channel = null;
  }

  private createStream(theme: ThemeName, preserveSpacing: boolean): MarkdownStreamer {
    const render = createRenderer({
      width: Math.max(20, this.writer.cols - 2),
      wrap: true,
      color: true,
      hyperlinks: true,
      theme,
      tableBorder: "unicode",
      tableTruncate: true,
      codeBox: true,
      codeWrap: true,
    });
    // Reasoning often uses blank lines structurally without Markdown markers.
    // Preserve those exactly; normal answers keep compact single spacing.
    return createMarkdownStreamer({
      render,
      spacing: preserveSpacing ? "preserve" : "single",
    });
  }
}
