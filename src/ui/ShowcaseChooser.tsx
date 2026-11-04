/**
 * File > Open Showcase Stack (spec 04 task 8, Requirements 7.1 and 7.5): a modal System 7 window
 * listing the showcase stacks by name. A click selects a stack, a double click or **Open** opens
 * it, **Cancel** (or Escape, or the close box) closes the window.
 *
 * The window only reports the choice; the composition root loads the stack through the stack
 * loader, whose `replaceStack` then closes the studio windows (App.tsx).
 */
import { useState } from "react";
import { PushButtonArt, System7Window } from "./System7Shell.tsx";

export interface ShowcaseChoice {
  id: string;
  name: string;
  description: string;
}

export interface ShowcaseChooserProps {
  showcases: readonly ShowcaseChoice[];
  onOpen: (id: string) => void;
  onClose: () => void;
}

export const SHOWCASE_CHOOSER_TITLE = "Open Showcase Stack";

export function ShowcaseChooser({ showcases, onOpen, onClose }: ShowcaseChooserProps) {
  const [selected, setSelected] = useState<string | undefined>(showcases[0]?.id);
  return (
    <System7Window title={SHOWCASE_CHOOSER_TITLE} className="s7-chooser-window" onClose={onClose}>
      <p className="s7-chooser-prompt">Choose a showcase stack to open:</p>
      <ul className="s7-chooser-list" aria-label="Showcase stacks">
        {showcases.map((entry) => {
          const isSelected = entry.id === selected;
          return (
            <li key={entry.id}>
              <button
                type="button"
                className={isSelected ? "s7-chooser-item s7-chooser-item-selected" : "s7-chooser-item"}
                aria-pressed={isSelected}
                onClick={() => setSelected(entry.id)}
                onDoubleClick={() => onOpen(entry.id)}
              >
                <span className="s7-chooser-name">{entry.name}</span>
                <span className="s7-chooser-description">{entry.description}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="s7-dialog-buttons">
        <button type="button" className="s7-button" onClick={onClose}>
          Cancel
          <PushButtonArt isDefault={false} />
        </button>
        <button
          type="button"
          className="s7-button s7-button-default"
          disabled={selected === undefined}
          onClick={() => {
            if (selected !== undefined) onOpen(selected);
          }}
        >
          Open
          <PushButtonArt isDefault />
        </button>
      </div>
    </System7Window>
  );
}
