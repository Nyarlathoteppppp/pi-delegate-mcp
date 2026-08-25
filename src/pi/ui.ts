import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { QuestionJson, QuestionKind } from "../types.js";

/** A pending question raised by a pi extension, waiting for an answer. */
export class Question {
  readonly id: string;
  readonly asked: string;
  readonly promise: Promise<unknown>;
  resolve!: (value: unknown) => void;

  constructor(
    readonly kind: QuestionKind,
    readonly title: string,
    readonly detail?: string,
    readonly options?: string[],
  ) {
    this.id = randomUUID().slice(0, 8);
    this.asked = new Date().toISOString();
    this.promise = new Promise((resolve) => (this.resolve = resolve));
  }

  toJSON(): QuestionJson {
    const { id, kind, title, detail, options, asked } = this;
    return { id, kind, title, detail, options, asked };
  }
}

const NOOP = (): void => {};
const noopUnsub = () => NOOP;

/**
 * Extensions that decorate output reach for ui.theme.fg()/bg()/etc. There is no terminal
 * here, so hand them an identity palette rather than let a statusline extension take down
 * the whole bind.
 */
const PLAIN_THEME = new Proxy(
  {},
  { get: () => (value: unknown) => (typeof value === "string" ? value : "") },
);

export interface UiHooks {
  ask(kind: QuestionKind, title: string, detail?: string, options?: string[]): Promise<unknown>;
  notify(message: string, type?: string): void;
}

/**
 * Extension UI for a delegate: queue dialogs instead of blocking on a terminal nobody is
 * watching. The Proxy answers every method pi's UI contract might reach for, because an
 * extension calling something we did not stub would otherwise sink the whole bind.
 */
export function createUiContext(hooks: UiHooks): ExtensionUIContext {
  return new Proxy(
    {
      select: (title: string, options: string[]) => hooks.ask("select", title, undefined, options),
      confirm: (title: string, message?: string) => hooks.ask("confirm", title, message),
      input: (title: string, placeholder?: string) => hooks.ask("input", title, placeholder),
      notify: (message: string, type = "info") => hooks.notify(message, type),
      theme: PLAIN_THEME,
      custom: async () => undefined,
      onTerminalInput: noopUnsub,
      getEditorText: () => "",
      getToolsExpanded: () => false,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "no TUI" }),
    } as Record<string, unknown>,
    { get: (t, p) => (p in t ? t[p as string] : NOOP) },
    // The Proxy answers every member of the contract, including ones pi adds later, but
    // structural typing cannot see that through a `get` trap.
  ) as unknown as ExtensionUIContext;
}
