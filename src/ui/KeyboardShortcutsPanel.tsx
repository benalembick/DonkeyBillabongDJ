import { actionCatalog } from "../core/actions";
import { keyBindingLabel, type KeyBinding } from "../input/keyboard";
import { useApp } from "./context";

interface ShortcutRow {
  action: string;
  binding: KeyBinding;
  label: string;
  group: string;
}

/** A discoverable reference for every active general keyboard binding. */
export function KeyboardShortcutsPanel() {
  const { keyboard } = useApp();
  const catalog = actionCatalog();
  const groups = new Map<string, ShortcutRow[]>();
  for (const binding of keyboard.getKeymap()) {
    const meta = catalog.get(binding.action);
    const group = meta?.group ?? "Other";
    const rows = groups.get(group) ?? [];
    rows.push({ action: binding.action, binding, label: meta?.label ?? binding.action, group });
    groups.set(group, rows);
  }

  return (
    <div className="keyboard-shortcuts-panel">
      <header>
        <h3>Keyboard shortcuts</h3>
        <p>These are the shortcuts currently active. Workspace shortcuts can be changed in Settings.</p>
      </header>
      <div className="keyboard-shortcut-groups">
        {[...groups.entries()].map(([group, rows]) => (
          <section key={group} className="keyboard-shortcut-group">
            <h4>{group}</h4>
            {rows.map((row) => (
              <div className="keyboard-shortcut-row" key={`${row.action}-${keyBindingLabel(row.binding)}`}>
                <span>{row.label}</span>
                <kbd>{keyBindingLabel(row.binding)}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
