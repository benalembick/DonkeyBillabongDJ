import { Emitter } from "./events";
import { actionCatalog } from "./actions";

export type CommandSource = "midi" | "keyboard" | "ui" | "system";

export interface Command {
  /** Action id from the catalogue, e.g. "deck1.play". */
  action: string;
  /** Normalised value (see actions.ts for conventions). */
  value: number;
  source: CommandSource;
}

export type CommandHandler = (value: number, cmd: Command) => void;

/**
 * Command bus: every input path (controller mapping, keyboard, UI) dispatches
 * Commands here; the DJ engine registers handlers. Inputs never talk to the
 * audio engine directly.
 */
export class CommandBus extends Emitter<{
  dispatched: Command;
  unhandled: Command;
  failed: { cmd: Command; error: unknown };
}> {
  private handlers = new Map<string, CommandHandler>();

  handle(action: string, handler: CommandHandler): void {
    this.handlers.set(action, handler);
  }

  has(action: string): boolean {
    return this.handlers.has(action);
  }

  dispatch(cmd: Command): boolean {
    const h = this.handlers.get(cmd.action);
    if (!h) {
      this.emit("unhandled", cmd);
      return false;
    }
    try {
      h(cmd.value, cmd);
      this.emit("dispatched", cmd);
      return true;
    } catch (error) {
      this.emit("failed", { cmd, error });
      return false;
    }
  }

  /** Convenience for UI / keyboard. */
  send(action: string, value = 1, source: CommandSource = "ui"): boolean {
    return this.dispatch({ action, value, source });
  }

  isKnownAction(action: string): boolean {
    return actionCatalog().has(action);
  }
}
