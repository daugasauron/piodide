import type { MobilePromptSurface, SelectRequest } from "./termui.ts";

export interface MobileCommandDefinition {
  command: "/provider" | "/login" | "/model";
  label: string;
  description: string;
}

export const MOBILE_COMMANDS: readonly MobileCommandDefinition[] = [
  {
    command: "/provider",
    label: "Provider",
    description: "Choose local inference or an API",
  },
  {
    command: "/login",
    label: "Login",
    description: "Paste the selected provider's API key",
  },
  {
    command: "/model",
    label: "Model",
    description: "Choose a model for the provider",
  },
];

export const MOBILE_COMMAND_MAX_WIDTH = 960;

export function shouldUseMobileCommands(
  width: number,
  hasCoarsePointer: boolean,
): boolean {
  return hasCoarsePointer && width <= MOBILE_COMMAND_MAX_WIDTH;
}

interface MobileCommandUiOptions {
  layer: HTMLElement;
  drawer: HTMLElement;
  backdrop: HTMLButtonElement;
  trigger: HTMLButtonElement;
  close: HTMLButtonElement;
  title: HTMLElement;
  content: HTMLElement;
  onCommand: (command: MobileCommandDefinition["command"]) => boolean;
}

interface SwipeStart {
  pointerId: number;
  x: number;
  y: number;
  drawerWasOpen: boolean;
}

function normalizePromptTitle(value: string): string {
  return value
    .replace(/\(hidden\)\s*:?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:\s*$/, "");
}

function textElement(tag: "span" | "small", className: string, value: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

export class MobileCommandUi implements MobilePromptSurface {
  private readonly options: MobileCommandUiOptions;
  private readonly widthQuery = matchMedia(`(max-width: ${MOBILE_COMMAND_MAX_WIDTH}px)`);
  private readonly coarsePointerQuery = matchMedia("(any-pointer: coarse)");
  private cancelActive: (() => void) | null = null;
  private swipe: SwipeStart | null = null;

  constructor(options: MobileCommandUiOptions) {
    this.options = options;
    options.trigger.addEventListener("click", () => this.openCommands());
    options.close.addEventListener("click", () => this.cancelCurrent());
    options.backdrop.addEventListener("click", () => this.cancelCurrent());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.isOpen()) {
        event.preventDefault();
        this.cancelCurrent();
      }
    });
    document.addEventListener("pointerdown", (event) => this.startSwipe(event), {
      passive: true,
    });
    document.addEventListener("pointermove", (event) => this.continueSwipe(event), {
      passive: true,
    });
    document.addEventListener("pointerup", (event) => this.finishSwipe(event), {
      passive: true,
    });
    document.addEventListener("pointercancel", () => {
      this.swipe = null;
    });
    this.widthQuery.addEventListener("change", () => this.syncAvailability());
    this.coarsePointerQuery.addEventListener("change", () => this.syncAvailability());
    this.syncAvailability();
  }

  enabled(): boolean {
    return shouldUseMobileCommands(
      window.innerWidth,
      this.coarsePointerQuery.matches || navigator.maxTouchPoints > 0,
    );
  }

  openCommands(): void {
    if (!this.enabled()) return;
    this.cancelActive = null;
    this.options.title.textContent = "Commands";
    this.options.content.replaceChildren();

    const intro = document.createElement("p");
    intro.className = "mobile-command-intro";
    intro.textContent = "Configure the active model";
    this.options.content.append(intro);

    const list = document.createElement("div");
    list.className = "mobile-command-list";
    for (const command of MOBILE_COMMANDS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mobile-command-button";
      button.dataset.mobileCommand = command.command;
      button.setAttribute("aria-label", `${command.label}: ${command.description}`);
      button.append(
        textElement("span", "mobile-command-name", command.command),
        textElement("small", "mobile-command-description", command.description),
      );
      button.addEventListener("click", () => {
        this.hide();
        if (!this.options.onCommand(command.command)) this.openCommands();
      });
      list.append(button);
    }
    this.options.content.append(list);
    this.show();
  }

  select<T>(request: SelectRequest<T>): Promise<T | null> {
    return new Promise<T | null>((resolveSelect) => {
      let settled = false;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        this.cancelActive = null;
        this.hide();
        resolveSelect(value);
      };
      this.cancelActive = () => finish(null);
      this.options.title.textContent = request.title;
      this.options.content.replaceChildren();

      const list = document.createElement("div");
      list.className = "mobile-option-list";

      const render = (query = "") => {
        const normalized = query.trim().toLowerCase();
        const visible = request.options.filter((option) =>
          `${option.label} ${option.description ?? ""} ${String(option.value)}`
            .toLowerCase()
            .includes(normalized),
        );
        list.replaceChildren();
        if (visible.length === 0) {
          list.append(textElement("span", "mobile-option-empty", "No matches"));
          return;
        }
        for (const option of visible) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "mobile-option-button";
          button.classList.toggle("active", Object.is(option.value, request.active));
          button.append(textElement("span", "mobile-option-label", option.label));
          if (option.description) {
            button.append(
              textElement("small", "mobile-option-description", option.description),
            );
          }
          button.addEventListener("click", () => finish(option.value));
          list.append(button);
        }
      };

      if (request.options.length > 8) {
        const search = document.createElement("input");
        search.className = "mobile-command-search";
        search.type = "search";
        search.placeholder = "Filter";
        search.autocomplete = "off";
        search.spellcheck = false;
        search.addEventListener("input", () => render(search.value));
        this.options.content.append(search);
      }
      this.options.content.append(list);
      render();
      this.show();
    });
  }

  ask(question: string, hidden = false): Promise<string> {
    return new Promise<string>((resolveAsk) => {
      let settled = false;
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        this.cancelActive = null;
        this.hide();
        resolveAsk(value);
      };
      this.cancelActive = () => finish("");
      this.options.title.textContent = normalizePromptTitle(question) || "Enter value";
      this.options.content.replaceChildren();

      const form = document.createElement("form");
      form.className = "mobile-command-form";

      const input = document.createElement("input");
      input.className = "mobile-command-input";
      input.type = hidden ? "password" : "text";
      input.autocomplete = "off";
      input.autocapitalize = "none";
      input.spellcheck = false;
      input.setAttribute("data-1p-ignore", "true");
      input.setAttribute("data-lpignore", "true");
      input.setAttribute("aria-label", hidden ? "API key" : "Value");

      const message = document.createElement("small");
      message.className = "mobile-command-form-message";
      message.textContent = hidden
        ? "The key stays in this browser tab."
        : "Enter a value to continue.";

      const actions = document.createElement("div");
      actions.className = "mobile-command-form-actions";

      if (hidden) {
        const paste = document.createElement("button");
        paste.type = "button";
        paste.className = "mobile-command-secondary";
        paste.textContent = "Paste";
        paste.addEventListener("click", async () => {
          try {
            input.value = await navigator.clipboard.readText();
            input.dispatchEvent(new Event("input"));
            input.focus();
            message.textContent = "Pasted. The key stays in this browser tab.";
          } catch {
            input.focus();
            message.textContent = "Clipboard access was blocked. Long-press the field to paste.";
          }
        });
        actions.append(paste);
      }

      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "mobile-command-primary";
      submit.textContent = hidden ? "Connect" : "Continue";
      actions.append(submit);

      form.append(input, message, actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        finish(input.value);
      });
      this.options.content.append(form);
      this.show();
      window.setTimeout(() => input.focus(), 50);
    });
  }

  private syncAvailability(): void {
    const available = this.enabled();
    document.body.classList.toggle("mobile-commands-enabled", available);
    this.options.trigger.hidden = !available;
    if (!available) this.cancelCurrent();
  }

  private show(): void {
    this.options.layer.classList.add("open");
    this.options.layer.setAttribute("aria-hidden", "false");
    this.options.close.focus({ preventScroll: true });
  }

  private hide(): void {
    this.options.layer.classList.remove("open");
    this.options.layer.setAttribute("aria-hidden", "true");
    this.options.content.replaceChildren();
  }

  private isOpen(): boolean {
    return this.options.layer.classList.contains("open");
  }

  private cancelCurrent(): void {
    const cancel = this.cancelActive;
    this.cancelActive = null;
    if (cancel) cancel();
    else this.hide();
  }

  private startSwipe(event: PointerEvent): void {
    if (!this.enabled() || event.pointerType === "mouse") return;
    const drawerWasOpen = this.isOpen();
    const startsAtRightEdge = event.clientX >= window.innerWidth - 28;
    const startsInsideDrawer =
      drawerWasOpen && this.options.drawer.contains(event.target as Node);
    if (!startsAtRightEdge && !startsInsideDrawer) return;
    this.swipe = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      drawerWasOpen,
    };
  }

  private finishSwipe(event: PointerEvent): void {
    this.applySwipe(event);
    this.swipe = null;
  }

  private continueSwipe(event: PointerEvent): void {
    if (this.applySwipe(event)) this.swipe = null;
  }

  private applySwipe(event: PointerEvent): boolean {
    const start = this.swipe;
    if (!start || event.pointerId !== start.pointerId) return false;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < 56 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return false;
    if (!start.drawerWasOpen && deltaX < 0) this.openCommands();
    if (start.drawerWasOpen && deltaX > 0) this.cancelCurrent();
    return true;
  }
}
