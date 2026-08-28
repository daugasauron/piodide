import {
  createMarkdownStreamer,
  createRenderer,
} from "markdansi";

import type { TermWriter } from "./termui.ts";

type MarkdownStreamer = ReturnType<typeof createMarkdownStreamer>;

/**
 * Owns the small amount of lifecycle glue between pi's content events and
 * markdansi's append-only streaming renderer. Markdown parsing and terminal
 * layout remain entirely inside markdansi.
 */
export class AssistantMarkdown {
  private stream: MarkdownStreamer | null = null;
  private readonly writer: TermWriter;

  constructor(writer: TermWriter) {
    this.writer = writer;
  }

  push(delta: string) {
    this.stream ??= this.createStream();
    const output = this.stream?.push(delta) ?? "";
    if (output) this.writer.write(output);
  }

  finish() {
    const output = this.stream?.finish() ?? "";
    if (output) this.writer.write(output);
    this.stream = null;
  }

  reset() {
    this.stream?.reset();
    this.stream = null;
  }

  private createStream(): MarkdownStreamer {
    const render = createRenderer({
      width: Math.max(20, this.writer.cols - 2),
      wrap: true,
      color: true,
      hyperlinks: true,
      theme: "bright",
      tableBorder: "unicode",
      tableTruncate: true,
      codeBox: true,
      codeWrap: true,
    });
    return createMarkdownStreamer({
      render,
      spacing: "single",
    });
  }
}
